from base64 import urlsafe_b64encode
from cryptography.fernet import Fernet, InvalidToken
from fastapi import FastAPI, HTTPException, Path as RoutePath, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, ConfigDict, Field
from typing import Any, Dict, Optional
from urllib.parse import urlencode
import asyncio
import hashlib
import hmac
import json
import secrets
import sqlite3
import time

import httpx

from .notifications import synchronize
from .host_releases import get_host_releases
from .identities import RepositoryIdentities, github_repository
from .storage import Settings, connect, initialize


SESSION = "__Host-pm_session"
STATE = "__Host-pm_oauth"
MAX_SNAPSHOT_AGE = 300


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def secure_equal(left: str, right: str) -> bool:
    return secrets.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


class ClaimBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plugin_id: str = Field(min_length=1, max_length=200)


class ReplyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    body: str = Field(min_length=1, max_length=2000)


class FoldRequestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    reason: str = Field(min_length=1, max_length=1000)


class GitHub:
    def __init__(self, settings: Settings):
        self.settings = settings

    def json(self, method: str, url: str, **kwargs: Any) -> Dict[str, Any]:
        try:
            with httpx.Client(timeout=12, follow_redirects=False) as client:
                response = client.request(method, url, **kwargs)
            if response.status_code == 401:
                raise HTTPException(401, "GitHub 授权已过期，请重新登录")
            if response.status_code == 404:
                raise HTTPException(
                    409, "GitHub 仓库不存在、已改名或不再公开，请更新市场索引"
                )
            if response.status_code != 200:
                raise HTTPException(503, "GitHub 暂时无法完成核验，请稍后重试")
            data = response.json()
            if not isinstance(data, dict):
                raise ValueError("GitHub response must be an object")
            return data
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(503, "GitHub 暂时无法完成核验") from exc

    def login(self, code: str, verifier: str) -> Dict[str, Any]:
        # The database consumes the browser-bound OAuth state before this call.
        # GitHub also accepts each authorization code only once. Do not retry
        # token exchange automatically after an ambiguous network failure.
        if self.settings.oauth_relay_key:
            if len(self.settings.oauth_relay_key) < 32:
                raise HTTPException(503, "GitHub 登录服务配置错误")
            body = json.dumps({"code": code, "verifier": verifier}, separators=(",", ":"))
            timestamp = str(int(time.time()))
            signature = hmac.new(
                self.settings.oauth_relay_key.encode(),
                ("github-token-v1\n" + timestamp + "\n" + body).encode(),
                hashlib.sha256,
            ).hexdigest()
            token = self.json(
                "POST", self.settings.public_origin + "/api/internal/github/token",
                headers={
                    "Content-Type": "application/json",
                    "X-OAuth-Timestamp": timestamp,
                    "X-OAuth-Signature": signature,
                },
                content=body,
                timeout=20,
            )
        else:
            token = self.direct_token(code, verifier)
        if "access_token" not in token:
            raise HTTPException(400, "GitHub 登录授权无效，请重新登录")
        access_token = token["access_token"]
        user = self.json(
            "GET", "https://api.github.com/user", headers=self.headers(access_token)
        )
        if not isinstance(user.get("id"), int) or not isinstance(
            user.get("login"), str
        ):
            raise HTTPException(503, "GitHub 身份响应无效")
        return {
            "id": user["id"],
            "login": user["login"],
            "token": access_token,
            "lifetime": min(int(token.get("expires_in", 604800)), 604800),
        }

    def direct_token(self, code: str, verifier: str) -> Dict[str, Any]:
        token = self.json(
            "POST",
            "https://github.com/login/oauth/access_token",
            headers={"Accept": "application/json"},
            data={
                "client_id": self.settings.client_id,
                "client_secret": self.settings.client_secret,
                "code": code,
                "code_verifier": verifier,
                "redirect_uri": self.settings.public_origin
                + "/api/auth/github/callback",
            },
        )
        return token

    @staticmethod
    def headers(token: str) -> Dict[str, str]:
        return {
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "User-Agent": "MaiBot-Plugin-Developer",
        }

    def repository(self, name: str, token: str) -> Dict[str, Any]:
        return github_repository(name, self.headers(token))


def create_app(settings: Settings, github: Optional[GitHub] = None) -> FastAPI:
    if (
        not settings.public_origin.startswith("https://")
        or len(settings.ingress_key) < 32
    ):
        raise ValueError("HTTPS origin and a strong ingress key are required")
    cipher = Fernet(settings.encryption_key)
    initialize(settings)
    gh = github if github is not None else GitHub(settings)
    identities = RepositoryIdentities(settings, gh)
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    def limit(key: str, maximum: int, seconds: int = 60) -> None:
        now = int(time.time())
        bucket = now // seconds
        with connect(settings) as db:
            db.execute(
                "DELETE FROM rate_limits WHERE bucket < ? AND key LIKE ?",
                (bucket - 1, str(seconds) + ":%"),
            )
            db.execute(
                "INSERT INTO rate_limits VALUES (?,?,1) ON CONFLICT(key,bucket) DO UPDATE SET count=count+1",
                (str(seconds) + ":" + key, bucket),
            )
            count = db.execute(
                "SELECT count FROM rate_limits WHERE key=? AND bucket=?",
                (str(seconds) + ":" + key, bucket),
            ).fetchone()[0]
        if count > maximum:
            raise HTTPException(
                429, "操作过于频繁，请稍后重试", headers={"Retry-After": str(seconds)}
            )

    @app.middleware("http")
    async def boundary(request: Request, call_next: Any) -> Any:
        # Trust identity headers only after authenticating the Worker, never from browsers.
        if request.url.path != "/health" and not secure_equal(
            request.headers.get("x-market-ingress", ""), settings.ingress_key
        ):
            return JSONResponse({"detail": "Forbidden"}, 403)
        if request.url.path != "/health":
            try:
                await asyncio.to_thread(
                    limit,
                    "ip:" + digest(request.headers.get("x-client-ip", "unknown")),
                    180,
                )
                await asyncio.to_thread(limit, "global", 1200)
            except HTTPException as exc:
                return JSONResponse(
                    {"detail": exc.detail}, exc.status_code, headers=exc.headers
                )
        if request.method not in {"GET", "HEAD"}:
            if request.headers.get("origin") != settings.public_origin:
                return JSONResponse({"detail": "来源校验失败"}, 403)
            if (
                request.headers.get("content-type", "").split(";")[0]
                != "application/json"
            ):
                return JSONResponse({"detail": "需要 application/json"}, 415)
            # Reject streamed oversized bodies too; do not trust Content-Length alone.
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 12288:
                    return JSONResponse({"detail": "请求过大"}, 413)
            request._body = bytes(body)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    def snapshot() -> Dict[str, Any]:
        try:
            data = json.loads(settings.snapshot.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise HTTPException(503, "反馈数据暂不可用，插件索引仍可正常使用") from exc
        if (
            data["schema"] != 1
            or not -30 <= time.time() - data["exported_at"] <= MAX_SNAPSHOT_AGE
        ):
            raise HTTPException(503, "反馈数据同步延迟，请稍后重试")
        return data

    def plugin(data: Dict[str, Any], plugin_id: str) -> Dict[str, Any]:
        for entry in data["plugins"].values():
            if plugin_id.casefold() in (
                entry["id"].casefold(),
                entry["market_id"].casefold(),
            ):
                return entry
        raise HTTPException(404, "插件不在市场索引中")

    def csrf(raw: str) -> str:
        return hmac.new(
            settings.encryption_key.encode(), ("csrf:" + raw).encode(), hashlib.sha256
        ).hexdigest()

    def account(request: Request, write: bool = False) -> Dict[str, Any]:
        raw = request.cookies.get(SESSION, "")
        with connect(settings) as db:
            row = db.execute(
                "SELECT s.*,u.login FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>?",
                (digest(raw), int(time.time())),
            ).fetchone()
        if row is None:
            raise HTTPException(401, "请先使用 GitHub 登录")
        if write:
            if not secure_equal(request.headers.get("x-csrf-token", ""), csrf(raw)):
                raise HTTPException(403, "请求校验失败，请刷新页面")
            limit("write:" + str(row["user_id"]), 30)
        result = dict(row)
        try:
            result["access_token"] = cipher.decrypt(row["token"].encode()).decode()
        except InvalidToken as exc:
            raise HTTPException(401, "登录已失效，请重新登录") from exc
        return result

    def repository(entry: Dict[str, Any], user: Dict[str, Any]) -> Dict[str, Any]:
        # Cached ownership discovers candidates only; every write rechecks GitHub.
        return identities.resolve(entry, user["access_token"])

    def authorize(entry: Dict[str, Any], user: Dict[str, Any]) -> Dict[str, Any]:
        with connect(settings) as db:
            claim = db.execute(
                "SELECT * FROM claims WHERE plugin_id=? AND user_id=? AND status='active'",
                (entry["id"], user["user_id"]),
            ).fetchone()
        if claim is None:
            raise HTTPException(403, "尚未获得此插件的管理权限")
        repo = repository(entry, user)
        allowed = (
            repo["id"] == claim["repo_id"]
            and repo["owner"]["id"] == claim["owner_id"]
            and repo["owner"]["type"] == claim["kind"]
        )
        if claim["kind"] == "User":
            allowed = allowed and repo["owner"]["id"] == user["user_id"]
        else:
            allowed = allowed and bool(repo.get("permissions", {}).get("push"))
        if not allowed:
            with connect(settings) as db:
                db.execute(
                    "UPDATE claims SET status='revoked' WHERE plugin_id=? AND user_id=?",
                    (entry["id"], user["user_id"]),
                )
            raise HTTPException(403, "仓库归属或权限已变更，认领已撤销")
        return dict(claim)

    def current_entry(entry: Dict[str, Any]) -> Dict[str, Any]:
        current = plugin(snapshot(), entry["id"])
        if current["id"] != entry["id"] or current["repository"] != entry["repository"]:
            raise HTTPException(409, "插件仓库映射已更新，请刷新后重试")
        return current

    def verify_write(
        db: sqlite3.Connection,
        entry: Dict[str, Any],
        user: Dict[str, Any],
        verified: Dict[str, Any],
    ) -> None:
        # Keep revocations/logout atomic with the final write, without holding a DB lock over GitHub I/O.
        db.execute("BEGIN IMMEDIATE")
        current = db.execute(
            "SELECT * FROM claims WHERE plugin_id=? AND user_id=?",
            (entry["id"], user["user_id"]),
        ).fetchone()
        if (
            current is None
            or dict(current) != verified
            or current["status"] != "active"
        ):
            raise HTTPException(403, "管理权限已变更，请重新核验")
        if (
            db.execute(
                "SELECT 1 FROM sessions WHERE hash=? AND expires>?",
                (user["hash"], int(time.time())),
            ).fetchone()
            is None
        ):
            raise HTTPException(401, "登录已失效，请重新登录")
        current_entry(entry)

    def reviews(
        entry: Dict[str, Any], offset: int, limit_count: int,
        user_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        if offset < 0 or not 1 <= limit_count <= 100:
            raise HTTPException(422, "分页参数无效")
        result = []
        with connect(settings) as db:
            for review in entry["reviews"][offset : offset + limit_count]:
                reply = db.execute(
                    "SELECT r.body,r.updated,u.login FROM replies r JOIN users u ON u.id=r.user_id JOIN claims c ON c.plugin_id=r.plugin_id AND c.user_id=r.user_id WHERE r.review_id=? AND r.revision=? AND c.status='active'",
                    (review["id"], review["revision"]),
                ).fetchone()
                item = {**review, "reply": dict(reply) if reply else None}
                if user_id is not None:
                    application = db.execute(
                        "SELECT id,status,created FROM comment_fold_requests "
                        "WHERE plugin_id=? AND review_id=? AND revision=? AND user_id=?",
                        (entry["id"], review["id"], review["revision"], user_id),
                    ).fetchone()
                    item["fold_request"] = dict(application) if application else None
                result.append(item)
        return {
            "items": result,
            "total": len(entry["reviews"]),
            "next_offset": offset + limit_count
            if offset + limit_count < len(entry["reviews"])
            else None,
        }

    @app.get("/health")
    def health() -> Dict[str, Any]:
        data = snapshot()
        with connect(settings) as db:
            db.execute("SELECT 1").fetchone()
        return {
            "ok": True,
            "snapshot_at": data["exported_at"],
            "oauth_configured": bool(settings.client_id and settings.client_secret),
        }

    @app.get("/api/auth/github/start")
    def start(request: Request) -> RedirectResponse:
        if not settings.client_id or not settings.client_secret:
            raise HTTPException(503, "开发者登录尚未配置完成")
        limit("oauth:" + digest(request.headers.get("x-client-ip", "unknown")), 10, 600)
        state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(48)
        now = int(time.time())
        with connect(settings) as db:
            db.execute("DELETE FROM oauth_states WHERE expires<?", (now,))
            db.execute("DELETE FROM sessions WHERE expires<?", (now,))
            db.execute(
                "INSERT INTO oauth_states VALUES (?,?,?)",
                (digest(state), verifier, now + 600),
            )
        params = {
            "client_id": settings.client_id,
            "redirect_uri": settings.public_origin + "/api/auth/github/callback",
            "scope": "",
            "state": state,
            "code_challenge": urlsafe_b64encode(
                hashlib.sha256(verifier.encode()).digest()
            )
            .decode()
            .rstrip("="),
            "code_challenge_method": "S256",
        }
        response = RedirectResponse(
            "https://github.com/login/oauth/authorize?" + urlencode(params), 302
        )
        response.set_cookie(
            STATE,
            state,
            max_age=600,
            secure=True,
            httponly=True,
            samesite="lax",
            path="/",
        )
        return response

    @app.get("/api/auth/github/callback")
    def callback(request: Request, state: str = "", code: str = "") -> RedirectResponse:
        if (
            not state
            or len(state) > 128
            or not code
            or len(code) > 512
            or not secure_equal(state, request.cookies.get(STATE, ""))
        ):
            raise HTTPException(400, "登录校验失败，请重新登录")
        with connect(settings) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM oauth_states WHERE hash=? AND expires>?",
                (digest(state), int(time.time())),
            ).fetchone()
            db.execute("DELETE FROM oauth_states WHERE hash=?", (digest(state),))
        if row is None:
            raise HTTPException(400, "登录请求已过期或使用过")
        user = gh.login(code, row["verifier"])
        raw = secrets.token_urlsafe(32)
        with connect(settings) as db:
            db.execute(
                "INSERT INTO users VALUES (?,?) ON CONFLICT(id) DO UPDATE SET login=excluded.login",
                (user["id"], user["login"]),
            )
            db.execute(
                "DELETE FROM sessions WHERE hash=?",
                (digest(request.cookies.get(SESSION, "")),),
            )
            db.execute(
                "INSERT INTO sessions VALUES (?,?,?,?)",
                (
                    digest(raw),
                    user["id"],
                    cipher.encrypt(user["token"].encode()).decode(),
                    int(time.time()) + user["lifetime"],
                ),
            )
        response = RedirectResponse("/developer", 302)
        response.set_cookie(
            SESSION,
            raw,
            max_age=user["lifetime"],
            secure=True,
            httponly=True,
            samesite="lax",
            path="/",
        )
        response.delete_cookie(
            STATE, secure=True, httponly=True, samesite="lax", path="/"
        )
        return response

    @app.get("/api/auth/session")
    def session(request: Request) -> Dict[str, Any]:
        user = account(request)
        return {
            "id": user["user_id"],
            "login": user["login"],
            "csrf": csrf(request.cookies[SESSION]),
        }

    @app.post("/api/auth/logout")
    def logout(request: Request) -> JSONResponse:
        user = account(request, True)
        with connect(settings) as db:
            db.execute("DELETE FROM sessions WHERE hash=?", (user["hash"],))
        response = JSONResponse({"ok": True})
        response.delete_cookie(
            SESSION, path="/", secure=True, httponly=True, samesite="lax"
        )
        return response

    @app.get("/api/developer/plugins")
    def my_plugins(request: Request) -> Dict[str, Any]:
        user = account(request)
        data = snapshot()
        with connect(settings) as db:
            claims = {
                row["plugin_id"]: dict(row)
                for row in db.execute(
                    "SELECT plugin_id,status FROM claims WHERE user_id=?",
                    (user["user_id"],),
                )
            }
        items = [
            {k: value for k, value in entry.items() if k not in ("reviews", "releases")}
            | {
                "claim": claims.get(entry["id"], {}).get("status"),
                "comments": len(entry["reviews"]),
            }
            for entry in data["plugins"].values()
        ]
        return {"items": items, "snapshot_at": data["exported_at"]}

    @app.get("/api/developer/claim-candidates")
    def claim_candidates(request: Request, after: str = Query(default="", max_length=200)) -> Dict[str, Any]:
        user = account(request)
        limit("discover:" + str(user["user_id"]), 60)
        return identities.discover(list(snapshot()["plugins"].values()), user, after)

    @app.get("/api/market/host-releases")
    def host_releases() -> Dict[str, Any]:
        return get_host_releases()

    @app.get("/api/market/catalog")
    def public_catalog() -> Dict[str, Any]:
        data = snapshot()
        fields = ("id", "market_id", "name", "repository", "manifest", "likes", "dislikes",
                  "downloads", "downloads_7d", "downloads_30d", "rating", "rating_count")
        return {
            "items": [
                {key: entry[key] for key in fields} | {
                    # Snapshots exported before rating_score existed fall back to the plain average.
                    "rating_score": entry.get("rating_score", entry["rating"]),
                    "icon_url": entry.get("icon_url"),
                    "comments": len(entry["reviews"]),
                    "updated_at": max((r.get("published_at") or "" for r in entry["releases"]), default=""),
                } for entry in data["plugins"].values()
            ],
            "snapshot_at": data["exported_at"],
            "catalog_synced_at": data["catalog_synced_at"],
        }

    @app.get("/api/market/plugins/{plugin_id}/releases")
    def public_releases(plugin_id: str) -> Dict[str, Any]:
        data = snapshot()
        entry = plugin(data, plugin_id)
        return {
            "items": entry["releases"],
            "mode": entry["release_mode"],
            "catalog_synced_at": data["catalog_synced_at"],
        }

    @app.get("/api/developer/plugins/{plugin_id}/releases")
    def plugin_releases(plugin_id: str, request: Request) -> Dict[str, Any]:
        account(request)
        return public_releases(plugin_id)

    @app.post("/api/developer/claims")
    def claim(body: ClaimBody, request: Request) -> Dict[str, Any]:
        user = account(request, True)
        entry = plugin(snapshot(), body.plugin_id)
        repo = repository(entry, user)
        entry = current_entry(entry)
        owner = repo["owner"]
        if owner["type"] == "User" and owner["id"] != user["user_id"]:
            raise HTTPException(403, "只有个人仓库所有者可以认领")
        status = "active" if owner["type"] == "User" else "pending"
        with connect(settings) as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute(
                "SELECT * FROM claims WHERE plugin_id=? AND user_id=?",
                (entry["id"], user["user_id"]),
            ).fetchone()
            if old and old["status"] in ("revoked", "rejected"):
                raise HTTPException(
                    403, "认领已撤销或未通过审核，请联系管理员重新开放申请"
                )
            if (
                old
                and old["status"] == "active"
                and old["repo_id"] == repo["id"]
                and old["owner_id"] == owner["id"]
            ):
                return {"status": "active"}
            db.execute(
                "INSERT INTO claims VALUES (?,?,?,?,?,?,?) ON CONFLICT(plugin_id,user_id) DO UPDATE SET repo_id=excluded.repo_id,owner_id=excluded.owner_id,status=excluded.status,kind=excluded.kind,created=excluded.created",
                (
                    entry["id"],
                    user["user_id"],
                    repo["id"],
                    owner["id"],
                    status,
                    owner["type"],
                    int(time.time()),
                ),
            )
            if owner["type"] == "User":
                db.execute(
                    "UPDATE claims SET status='revoked' WHERE plugin_id=? AND user_id<>?",
                    (entry["id"], user["user_id"]),
                )
            # A first claim sets a baseline instead of turning all old votes into notifications.
            db.execute(
                "DELETE FROM baselines WHERE plugin_id=? AND user_id=?",
                (entry["id"], user["user_id"]),
            )
            synchronize(db, entry, user["user_id"])
            db.execute(
                "INSERT INTO audit(actor,action,plugin_id,created) VALUES (?,?,?,?)",
                (
                    str(user["user_id"]),
                    "claim:" + status,
                    entry["id"],
                    int(time.time()),
                ),
            )
        return {"status": status}

    @app.get("/api/developer/inbox")
    def inbox(
        request: Request,
        before: Optional[int] = Query(default=None, ge=1, le=9223372036854775807),
    ) -> Dict[str, Any]:
        user = account(request)
        data = snapshot()
        with connect(settings) as db:
            db.execute("BEGIN IMMEDIATE")
            for row in db.execute(
                "SELECT plugin_id FROM claims WHERE user_id=? AND status='active'",
                (user["user_id"],),
            ).fetchall():
                if row["plugin_id"] in data["plugins"]:
                    synchronize(db, data["plugins"][row["plugin_id"]], user["user_id"])
            rows = db.execute(
                "SELECT * FROM notifications WHERE user_id=? AND id<? ORDER BY id DESC LIMIT 50",
                (
                    user["user_id"],
                    before if before is not None else 9223372036854775807,
                ),
            ).fetchall()
            unread = db.execute(
                "SELECT count(*) FROM notifications WHERE user_id=? AND read_at IS NULL",
                (user["user_id"],),
            ).fetchone()[0]
        return {
            "items": [
                {k: row[k] for k in row.keys() if k != "user_id"} for row in rows
            ],
            "unread": unread,
            "next_before": rows[-1]["id"] if len(rows) == 50 else None,
        }

    @app.post("/api/developer/inbox/{notification_id}/read")
    def mark_read(
        request: Request, notification_id: int = RoutePath(ge=1, le=9223372036854775807)
    ) -> Dict[str, bool]:
        user = account(request, True)
        with connect(settings) as db:
            updated = db.execute(
                "UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?",
                (int(time.time()), notification_id, user["user_id"]),
            )
            if updated.rowcount == 0:
                raise HTTPException(404, "通知不存在")
        return {"ok": True}

    @app.get("/api/feedback/{plugin_id}")
    def feedback(plugin_id: str, offset: int = 0, limit: int = 20) -> Dict[str, Any]:
        data = snapshot()
        entry = plugin(data, plugin_id)
        return {
            "plugin_id": entry["id"],
            "likes": entry["likes"],
            "dislikes": entry["dislikes"],
            "snapshot_at": data["exported_at"],
            **reviews(entry, offset, limit),
        }

    @app.get("/api/developer/plugins/{plugin_id}/feedback")
    def developer_feedback(
        plugin_id: str, request: Request, offset: int = 0, limit: int = 20,
    ) -> Dict[str, Any]:
        user = account(request)
        data = snapshot()
        entry = plugin(data, plugin_id)
        with connect(settings) as db:
            if db.execute(
                "SELECT 1 FROM claims WHERE plugin_id=? AND user_id=? AND status='active'",
                (entry["id"], user["user_id"]),
            ).fetchone() is None:
                raise HTTPException(403, "尚未获得此插件的管理权限")
        return {
            "plugin_id": entry["id"], "likes": entry["likes"], "dislikes": entry["dislikes"],
            "snapshot_at": data["exported_at"],
            **reviews(entry, offset, limit, user["user_id"]),
        }

    @app.post("/api/developer/plugins/{plugin_id}/reviews/{review_id}/fold-request")
    def request_comment_fold(
        plugin_id: str, review_id: str, body: FoldRequestBody, request: Request,
    ) -> Dict[str, Any]:
        user = account(request, True)
        reason = body.reason.strip()
        if not reason:
            raise HTTPException(422, "请填写申请理由")
        entry = plugin(snapshot(), plugin_id)
        verified = authorize(entry, user)
        with connect(settings) as db:
            verify_write(db, entry, user, verified)
            # Freeze the exact comment revision under review; never modify public feedback.
            entry = current_entry(entry)
            review = next((item for item in entry["reviews"] if item["id"] == review_id), None)
            if review is None:
                raise HTTPException(404, "评论已删除或不存在")
            if review["revision"] != body.revision:
                raise HTTPException(409, "评论已经更新，请刷新后重新申请")
            existing = db.execute(
                "SELECT id,status,created FROM comment_fold_requests "
                "WHERE plugin_id=? AND review_id=? AND revision=? AND user_id=?",
                (entry["id"], review_id, body.revision, user["user_id"]),
            ).fetchone()
            if existing:
                return dict(existing)
            now = int(time.time())
            review_snapshot = {key: review[key] for key in (
                "id", "revision", "comment", "rating", "username", "created_at", "updated_at",
            )}
            cursor = db.execute(
                "INSERT INTO comment_fold_requests "
                "(plugin_id,review_id,revision,user_id,requester_login,repo_id,owner_id,reason,review_snapshot,created) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (entry["id"], review_id, body.revision, user["user_id"], user["login"],
                 verified["repo_id"], verified["owner_id"], reason,
                 json.dumps(review_snapshot, ensure_ascii=False), now),
            )
            db.execute(
                "INSERT INTO audit(actor,action,plugin_id,created) VALUES (?,?,?,?)",
                (str(user["user_id"]), "comment_fold_request", entry["id"], now),
            )
            return {"id": cursor.lastrowid, "status": "pending", "created": now}

    @app.put("/api/developer/plugins/{plugin_id}/reviews/{review_id}/reply")
    def reply(
        plugin_id: str, review_id: str, body: ReplyBody, request: Request
    ) -> Dict[str, bool]:
        user = account(request, True)
        entry = plugin(snapshot(), plugin_id)
        verified = authorize(entry, user)
        # Reload after the remote permission check so a newly published snapshot is respected.
        entry = current_entry(entry)
        review = next(
            (item for item in entry["reviews"] if item["id"] == review_id), None
        )
        if review is None:
            raise HTTPException(404, "评论已删除或不存在")
        if review["revision"] != body.revision:
            raise HTTPException(409, "评论已经更新，请刷新后回复")
        text = body.body.strip()
        if not text:
            raise HTTPException(422, "回复不能为空")
        with connect(settings) as db:
            verify_write(db, entry, user, verified)
            db.execute(
                "INSERT INTO replies VALUES (?,?,?,?,?,?) ON CONFLICT(review_id) DO UPDATE SET user_id=excluded.user_id,revision=excluded.revision,body=excluded.body,updated=excluded.updated",
                (
                    review_id,
                    entry["id"],
                    user["user_id"],
                    body.revision,
                    text,
                    int(time.time()),
                ),
            )
            db.execute(
                "INSERT INTO audit(actor,action,plugin_id,created) VALUES (?,?,?,?)",
                (str(user["user_id"]), "reply", entry["id"], int(time.time())),
            )
        return {"ok": True}

    @app.delete("/api/developer/plugins/{plugin_id}/reviews/{review_id}/reply")
    def delete_reply(
        plugin_id: str, review_id: str, request: Request
    ) -> Dict[str, bool]:
        user = account(request, True)
        entry = plugin(snapshot(), plugin_id)
        verified = authorize(entry, user)
        with connect(settings) as db:
            verify_write(db, entry, user, verified)
            db.execute(
                "DELETE FROM replies WHERE review_id=? AND plugin_id=?",
                (review_id, entry["id"]),
            )
            db.execute(
                "INSERT INTO audit(actor,action,plugin_id,created) VALUES (?,?,?,?)",
                (str(user["user_id"]), "delete_reply", entry["id"], int(time.time())),
            )
        return {"ok": True}

    return app


def factory() -> FastAPI:
    return create_app(Settings.environment())
