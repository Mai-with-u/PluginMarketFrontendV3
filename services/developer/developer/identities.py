"""Resolve public repository identities without trusting mutable GitHub logins."""

from concurrent.futures import ThreadPoolExecutor
from fastapi import HTTPException
from threading import Lock
from typing import Any, Dict, List
from urllib.parse import urljoin, urlsplit
import re
import time

import httpx

from .storage import Settings, connect


def github_repository(name: str, headers: Dict[str, str]) -> Dict[str, Any]:
    if re.fullmatch(r"#[1-9][0-9]*", name):
        url = "https://api.github.com/repositories/" + name[1:]
    elif re.fullmatch(r"[\w.-]+/[\w.-]+", name) and all(
        part not in {".", ".."} for part in name.split("/")
    ):
        url = "https://api.github.com/repos/" + name
    else:
        raise HTTPException(409, "市场仓库地址无效")
    deadline = time.monotonic() + 9
    try:
        with httpx.Client(follow_redirects=False) as client:
            for _ in range(4):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise HTTPException(503, "GitHub 仓库核验超时")
                response = client.get(url, headers=headers, timeout=remaining)
                if response.status_code in {301, 302, 307, 308}:
                    location = response.headers.get("location")
                    target = urljoin(url, location or "")
                    parsed = urlsplit(target)
                    # Never forward the user's token outside fixed GitHub repository APIs.
                    if (
                        not location
                        or parsed.scheme != "https"
                        or parsed.netloc != "api.github.com"
                        or parsed.query
                        or parsed.fragment
                        or not re.fullmatch(
                            r"/(?:repositories/[1-9][0-9]*|repos/[\w.-]+/[\w.-]+)",
                            parsed.path,
                        )
                        or any(part in {".", ".."} for part in parsed.path.split("/"))
                    ):
                        raise HTTPException(503, "GitHub 返回了不受信任的仓库跳转")
                    url = target
                    continue
                if response.status_code == 401:
                    raise HTTPException(401, "GitHub 授权已过期，请重新登录")
                if response.status_code == 404:
                    raise HTTPException(409, "仓库不存在或不再公开，请更新市场索引")
                if response.status_code != 200:
                    raise HTTPException(503, "GitHub 暂时无法完成仓库核验，请稍后重试")
                data = response.json()
                if not isinstance(data, dict):
                    raise ValueError("Invalid repository response")
                return data
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(503, "GitHub 暂时无法完成仓库核验") from exc
    raise HTTPException(503, "GitHub 仓库跳转次数过多")


class RepositoryIdentities:
    def __init__(self, settings: Settings, github: Any):
        self.settings = settings
        self.github = github
        self.discovery_lock = Lock()

    def resolve(self, entry: Dict[str, Any], token: str) -> Dict[str, Any]:
        with connect(self.settings) as db:
            binding = db.execute(
                "SELECT * FROM repository_identities WHERE plugin_id=?", (entry["id"],)
            ).fetchone()
            historic = db.execute(
                "SELECT DISTINCT repo_id FROM claims WHERE plugin_id=?", (entry["id"],)
            ).fetchall()
        if binding:
            expected = binding["repo_id"]
            name = (
                "#" + str(expected)
                if binding["repository"] == entry["repository"]
                else entry["repository"]
            )
        elif historic:
            if len(historic) != 1:
                raise HTTPException(409, "仓库历史身份不一致，请联系管理员核实")
            expected = historic[0]["repo_id"]
            name = "#" + str(expected)
        else:
            expected = None
            name = entry["repository"]
        repo = self.github.repository(name, token)
        owner = repo.get("owner")
        if (
            type(repo.get("id")) is not int
            or repo["id"] <= 0
            or not isinstance(owner, dict)
            or type(owner.get("id")) is not int
            or owner["id"] <= 0
            or owner.get("type") not in {"User", "Organization"}
            or repo.get("private") is not False
        ):
            raise HTTPException(409, "仓库不是可核验的公开仓库")
        if expected is not None and repo["id"] != expected:
            with connect(self.settings) as db:
                db.execute(
                    "UPDATE claims SET status='revoked' WHERE plugin_id=?",
                    (entry["id"],),
                )
            raise HTTPException(403, "仓库数字 ID 已变更，请联系管理员核实市场索引")
        with connect(self.settings) as db:
            # Pin the first verified repository ID, including under concurrent requests.
            db.execute(
                "INSERT OR IGNORE INTO repository_identities VALUES (?,?,?,?,?,?)",
                (
                    entry["id"],
                    entry["repository"],
                    repo["id"],
                    owner["id"],
                    owner["type"],
                    int(time.time()),
                ),
            )
            pinned = db.execute(
                "SELECT repo_id FROM repository_identities WHERE plugin_id=?",
                (entry["id"],),
            ).fetchone()[0]
            if pinned != repo["id"]:
                raise HTTPException(409, "仓库身份发生并发变更，请重新核实")
            db.execute(
                "UPDATE repository_identities SET repository=?,owner_id=?,kind=?,checked=? WHERE plugin_id=?",
                (
                    entry["repository"],
                    owner["id"],
                    owner["type"],
                    int(time.time()),
                    entry["id"],
                ),
            )
        return repo

    def discover(
        self, entries: List[Dict[str, Any]], user: Dict[str, Any], after: str
    ) -> Dict[str, Any]:
        if not self.discovery_lock.acquire(blocking=False):
            raise HTTPException(429, "仓库身份索引正在更新，请稍后重新打开页面")
        try:
            with connect(self.settings) as db:
                cached = {
                    row["plugin_id"]: dict(row)
                    for row in db.execute("SELECT * FROM repository_identities")
                }
                claimed = {
                    row[0]
                    for row in db.execute(
                        "SELECT plugin_id FROM claims WHERE user_id=?",
                        (user["user_id"],),
                    )
                }
            ordered = sorted(
                (e for e in entries if e["id"] > after), key=lambda e: e["id"]
            )
            batch, missing = [], []
            for entry in ordered:
                old = cached.get(entry["id"])
                fresh = (
                    old
                    and old["repository"] == entry["repository"]
                    and old["checked"] > time.time() - 3600
                )
                if not fresh and entry["id"] not in claimed:
                    if len(missing) == 8:
                        break
                    missing.append(entry)
                batch.append(entry)
                if len(batch) == 128:
                    break

            def resolve_one(entry: Dict[str, Any]) -> Dict[str, Any]:
                try:
                    repo = self.resolve(entry, user["access_token"])
                    return {
                        "plugin_id": entry["id"],
                        "owner_id": repo["owner"]["id"],
                        "kind": repo["owner"]["type"],
                    }
                except HTTPException as exc:
                    if exc.status_code in {403, 409}:
                        return {"plugin_id": entry["id"], "error": exc.detail}
                    raise

            # Cold discovery is bounded to eight parallel public API calls; no DB lock over I/O.
            with ThreadPoolExecutor(max_workers=8) as pool:
                resolved = {
                    item["plugin_id"]: item for item in pool.map(resolve_one, missing)
                }
            candidates, unavailable = [], []
            for entry in batch:
                if entry["id"] in claimed:
                    continue
                identity = resolved.get(entry["id"], cached.get(entry["id"]))
                if identity and "error" in identity:
                    unavailable.append({"id": entry["id"], "detail": identity["error"]})
                elif (
                    identity
                    and identity["kind"] == "User"
                    and identity["owner_id"] == user["user_id"]
                ):
                    candidates.append(entry["id"])
            return {
                "items": candidates,
                "unavailable": unavailable,
                "next_after": batch[-1]["id"]
                if batch and len(batch) < len(ordered)
                else None,
            }
        finally:
            self.discovery_lock.release()
