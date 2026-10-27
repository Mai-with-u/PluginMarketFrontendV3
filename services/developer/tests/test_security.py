from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import json
import hashlib
import sqlite3
import time

import pytest
import admin

from developer.app import SESSION, STATE, create_app
from deploy.migrate_revision_hashes import migrate
from developer.notifications import refresh
from developer.storage import Settings, connect
from export_snapshot import export


class FakeGitHub:
    user_id = 42
    owner_id = 42
    owner_type = "User"
    repo_id = 100
    can_push = True

    def login(self, code, verifier):
        assert verifier and code == "valid"
        return {
            "id": self.user_id,
            "login": "developer" + str(self.user_id),
            "token": "secret-github-token",
            "lifetime": 3600,
        }

    def repository(self, name, token):
        assert token == "secret-github-token"
        return {
            "id": self.repo_id,
            "full_name": name,
            "private": False,
            "owner": {"id": self.owner_id, "type": self.owner_type},
            "permissions": {"push": self.can_push},
        }


@pytest.fixture
def setup(tmp_path):
    settings = Settings(
        tmp_path / "developer.db",
        tmp_path / "market.json",
        "https://plugin.maibot.chat",
        "client-id",
        "client-secret",
        Fernet.generate_key().decode(),
        "ingress-" + "x" * 40,
    )
    payload = {
        "schema": 1,
        "exported_at": int(time.time()),
        "plugins": {
            "test.plugin": {
                "id": "test.plugin",
                "market_id": "Test.Plugin",
                "name": "test",
                "repository": "owner/repo",
                "likes": 3,
                "dislikes": 1,
                "reviews": [
                    {
                        "id": "a" * 64,
                        "revision": "b" * 64,
                        "comment": "<script>bad()</script>",
                        "rating": 5,
                        "username": None,
                        "created_at": "2026-01-01",
                        "updated_at": "2026-01-01",
                    }
                ],
            }
        },
    }
    settings.snapshot.write_text(json.dumps(payload))
    gh = FakeGitHub()
    client = TestClient(
        create_app(settings, gh),
        base_url=settings.public_origin,
        headers={"x-market-ingress": settings.ingress_key},
    )
    return settings, payload, gh, client


def login(client):
    start = client.get("/api/auth/github/start", follow_redirects=False)
    assert start.status_code == 302
    params = parse_qs(urlparse(start.headers["location"]).query)
    assert params["code_challenge_method"] == ["S256"]
    callback = client.get(
        "/api/auth/github/callback",
        params={"code": "valid", "state": params["state"][0]},
        follow_redirects=False,
    )
    assert callback.status_code == 302
    cookie = callback.headers["set-cookie"]
    assert "HttpOnly" in cookie and "Secure" in cookie and "SameSite=lax" in cookie
    session = client.get("/api/auth/session").json()
    client.headers.update(
        {
            "origin": str(client.base_url).rstrip("/"),
            "x-csrf-token": session["csrf"],
            "content-type": "application/json",
        }
    )
    return params["state"][0]


def claim(client):
    return client.post("/api/developer/claims", json={"plugin_id": "Test.Plugin"})


def reply(client, body=None):
    return client.put(
        "/api/developer/plugins/Test.Plugin/reviews/" + "a" * 64 + "/reply",
        json=body or {"revision": "b" * 64, "body": "thanks"},
    )


def test_ingress_and_csrf(setup):
    settings, _, _, client = setup
    assert (
        client.get(
            "/api/auth/session", headers={"x-market-ingress": "wrong"}
        ).status_code
        == 403
    )
    assert client.get("/api/auth/session").status_code == 401
    login(client)
    assert (
        client.post(
            "/api/developer/claims",
            json={"plugin_id": "test.plugin"},
            headers={"origin": "https://evil.test"},
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/developer/claims",
            json={"plugin_id": "test.plugin"},
            headers={"x-csrf-token": "wrong"},
        ).status_code
        == 403
    )
    assert client.get("/api/auth/session").headers["cache-control"] == "no-store"
    with connect(settings) as db:
        row = db.execute("SELECT * FROM sessions").fetchone()
        assert row["hash"] != client.cookies.get(SESSION)
        assert "secret-github-token" not in row["token"]


def test_oauth_binding_and_replay(setup):
    _, _, _, client = setup
    assert (
        client.get("/api/auth/github/callback?state=evil&code=valid").status_code == 400
    )
    state = login(client)
    client.cookies.set(STATE, state, domain="plugin.maibot.chat")
    assert (
        client.get(
            "/api/auth/github/callback", params={"state": state, "code": "valid"}
        ).status_code
        == 400
    )


def test_no_impersonation_or_cross_plugin_write(setup):
    _, _, gh, client = setup
    login(client)
    assert reply(client).status_code == 403
    gh.owner_id = 99
    assert claim(client).status_code == 403
    gh.owner_id = 42
    assert (
        client.post(
            "/api/developer/claims", json={"plugin_id": "test.plugin", "user_id": 99}
        ).status_code
        == 422
    )
    assert claim(client).json()["status"] == "active"
    assert reply(client).status_code == 200
    assert (
        client.get("/api/feedback/Test.Plugin").json()["items"][0]["reply"]["body"]
        == "thanks"
    )
    gh.repo_id = 101
    assert reply(client).status_code == 403
    assert client.get("/api/feedback/Test.Plugin").json()["items"][0]["reply"] is None


def test_org_requires_approval_and_continued_permission(setup):
    settings, _, gh, client = setup
    gh.owner_type = "Organization"
    gh.owner_id = 500
    login(client)
    assert claim(client).json()["status"] == "pending"
    assert reply(client).status_code == 403
    with connect(settings) as db:
        db.execute("UPDATE claims SET status='active'")
    assert reply(client).status_code == 200
    gh.can_push = False
    assert reply(client).status_code == 403


def test_changed_deleted_comments_and_stale_source(setup):
    settings, payload, _, client = setup
    login(client)
    claim(client)
    assert reply(client).status_code == 200
    payload["plugins"]["test.plugin"]["reviews"][0]["revision"] = "c" * 64
    settings.snapshot.write_text(json.dumps(payload))
    assert reply(client).status_code == 409
    assert client.get("/api/feedback/Test.Plugin").json()["items"][0]["reply"] is None
    payload["plugins"]["test.plugin"]["reviews"] = []
    settings.snapshot.write_text(json.dumps(payload))
    assert reply(client).status_code == 404
    payload["exported_at"] -= 400
    settings.snapshot.write_text(json.dumps(payload))
    assert client.get("/api/feedback/Test.Plugin").status_code == 503
    assert client.get("/api/auth/session").status_code == 200


def test_notification_baseline_dedup_and_account_isolation(setup):
    settings, payload, gh, client = setup
    login(client)
    claim(client)
    assert client.get("/api/developer/inbox").json()["items"] == []
    payload["plugins"]["test.plugin"]["likes"] += 2
    payload["plugins"]["test.plugin"]["reviews"][0]["revision"] = "c" * 64
    settings.snapshot.write_text(json.dumps(payload))
    inbox = client.get("/api/developer/inbox").json()
    assert len(inbox["items"]) == 2
    assert len(client.get("/api/developer/inbox").json()["items"]) == 2
    notification_id = inbox["items"][0]["id"]
    assert (
        client.post(f"/api/developer/inbox/{notification_id}/read", json={}).status_code
        == 200
    )
    assert client.get("/api/developer/inbox").json()["unread"] == 1
    gh.user_id = 55
    login(client)
    assert client.get("/api/developer/inbox").json()["items"] == []
    assert (
        client.post(f"/api/developer/inbox/{notification_id}/read", json={}).status_code
        == 404
    )


def test_limits_logout_and_payload_validation(setup):
    _, _, _, client = setup
    login(client)
    assert client.post("/api/developer/claims", content=b"x" * 13000).status_code == 413
    assert (
        client.post(
            "/api/developer/claims",
            content="text",
            headers={"content-type": "text/plain"},
        ).status_code
        == 415
    )
    claim(client)
    assert reply(client, {"revision": "b" * 64, "body": "  "}).status_code == 422
    assert client.post("/api/auth/logout", json={}).status_code == 200
    assert client.get("/api/auth/session").status_code == 401


def test_notifications_are_collected_without_open_browser(setup):
    settings, payload, _, client = setup
    login(client)
    claim(client)
    payload["plugins"]["test.plugin"]["likes"] += 1
    settings.snapshot.write_text(json.dumps(payload))
    refresh(settings)
    refresh(settings)
    with connect(settings) as db:
        assert db.execute("SELECT count(*) FROM notifications").fetchone()[0] == 1


def test_write_rate_limit_is_persistent(setup):
    settings, _, _, client = setup
    login(client)
    with connect(settings) as db:
        db.execute(
            "INSERT INTO rate_limits VALUES (?,?,?)",
            ("60:write:42", int(time.time()) // 60, 30),
        )
    response = claim(client)
    assert response.status_code == 429
    assert response.headers["retry-after"] == "60"


@pytest.mark.parametrize("status", ["revoked", "rejected"])
def test_claim_cannot_undo_administrator_decision(setup, status):
    settings, _, _, client = setup
    login(client)
    assert claim(client).status_code == 200
    with connect(settings) as db:
        db.execute("UPDATE claims SET status=?", (status,))
    assert claim(client).status_code == 403
    with connect(settings) as db:
        assert db.execute("SELECT status FROM claims").fetchone()[0] == status


@pytest.mark.parametrize("delete", [False, True])
def test_revocation_during_github_check_blocks_write(setup, monkeypatch, delete):
    settings, _, gh, client = setup
    login(client)
    claim(client)
    original = gh.repository

    def revoke(name, token):
        with connect(settings) as db:
            db.execute("UPDATE claims SET status='revoked'")
        return original(name, token)

    monkeypatch.setattr(gh, "repository", revoke)
    response = client.request(
        "DELETE" if delete else "PUT",
        "/api/developer/plugins/Test.Plugin/reviews/" + "a" * 64 + "/reply",
        json={} if delete else {"revision": "b" * 64, "body": "unauthorized"},
    )
    assert response.status_code == 403


def test_repository_mapping_change_during_verification(setup, monkeypatch):
    settings, payload, gh, client = setup
    login(client)
    claim(client)
    original = gh.repository

    def replace_repository(name, token):
        payload["plugins"]["test.plugin"]["repository"] = "different-owner/repo"
        settings.snapshot.write_text(json.dumps(payload))
        return original(name, token)

    monkeypatch.setattr(gh, "repository", replace_repository)
    assert reply(client).status_code == 409


def test_unicode_oauth_state_is_rejected_without_server_error(setup):
    _, _, _, client = setup
    assert (
        client.get(
            "/api/auth/github/callback", params={"state": "伪造状态", "code": "valid"}
        ).status_code
        == 400
    )


def test_out_of_range_notification_ids_are_rejected(setup):
    _, _, _, client = setup
    login(client)
    huge = str(2**100)
    assert client.get("/api/developer/inbox?before=" + huge).status_code == 422
    assert (
        client.post("/api/developer/inbox/" + huge + "/read", json={}).status_code
        == 422
    )


def test_admin_can_explicitly_reopen_claim(setup, monkeypatch):
    settings, _, _, client = setup
    login(client)
    claim(client)
    with connect(settings) as db:
        db.execute("UPDATE claims SET status='revoked'")
    monkeypatch.setattr(admin.Settings, "environment", lambda: settings)
    monkeypatch.setattr(
        "sys.argv",
        [
            "admin.py",
            "reopen",
            "--plugin",
            "test.plugin",
            "--user",
            "42",
            "--reason",
            "reviewed",
        ],
    )
    admin.main()
    assert claim(client).status_code == 200


def test_blocked_ip_does_not_consume_global_budget(setup):
    settings, _, _, client = setup
    with connect(settings) as db:
        db.execute(
            "INSERT INTO rate_limits VALUES (?,?,?)",
            (
                "60:ip:" + hashlib.sha256(b"unknown").hexdigest(),
                int(time.time()) // 60,
                180,
            ),
        )
    assert client.get("/api/feedback/test.plugin").status_code == 429
    with connect(settings) as db:
        assert (
            db.execute("SELECT count FROM rate_limits WHERE key='60:global'").fetchone()
            is None
        )


def test_export_redacts_identifiers_and_never_changes_legacy(tmp_path):
    legacy = tmp_path / "legacy.db"
    with sqlite3.connect(legacy) as db:
        db.executescript(
            "CREATE TABLE plugin_download_events(plugin_id TEXT,created_at TEXT,counted INTEGER); CREATE TABLE plugin_votes(plugin_id TEXT,user_id TEXT,vote INTEGER); CREATE TABLE plugin_ratings(plugin_id TEXT,user_id TEXT,comment TEXT,rating INTEGER,created_at TEXT,updated_at TEXT,username TEXT,anonymous INTEGER);"
        )
        db.execute("INSERT INTO plugin_votes VALUES ('test.plugin','private-id',1)")
        db.execute(
            "INSERT INTO plugin_ratings VALUES ('test.plugin','private-id','hello',5,'created','updated','private-name',1)"
        )
    bundle = tmp_path / "bundle.json"
    bundle.write_text(
        json.dumps(
            {
                "synced_at": "now",
                "details": [],
                "versions": {
                    "plugins": [
                        {
                            "id": "Test.Plugin",
                            "manifest_id": "test.plugin",
                            "repositoryUrl": "https://github.com/owner/repo",
                        }
                    ]
                },
            }
        )
    )
    before = legacy.read_bytes()
    output = tmp_path / "market.json"
    first = export(legacy, bundle, output, b"k" * 32)
    second = export(legacy, bundle, output, b"k" * 32)
    assert before == legacy.read_bytes()
    assert (
        "private-id" not in output.read_text()
        and "private-name" not in output.read_text()
    )
    assert (
        first["plugins"]["test.plugin"]["reviews"]
        == second["plugins"]["test.plugin"]["reviews"]
    )
    assert first["plugins"]["test.plugin"]["likes"] == 1
    guessed_revision = hashlib.sha256(
        json.dumps(["hello", 5, "updated", 1, "private-name"]).encode()
    ).hexdigest()
    assert first["plugins"]["test.plugin"]["reviews"][0]["revision"] != guessed_revision
    old_id = first["plugins"]["test.plugin"]["reviews"][0]["id"]
    developer_path = tmp_path / "developer.db"
    with sqlite3.connect(developer_path) as db:
        db.executescript(
            "CREATE TABLE replies(review_id TEXT,revision TEXT); CREATE TABLE baselines(plugin_id TEXT,user_id INTEGER,reviews TEXT);"
        )
        db.execute("INSERT INTO replies VALUES (?,?)", (old_id, guessed_revision))
        db.execute("INSERT INTO replies VALUES (?,?)", (old_id, "outdated-revision"))
        db.execute(
            "INSERT INTO baselines VALUES ('test.plugin',42,?)",
            (json.dumps({old_id: guessed_revision}),),
        )
    assert migrate(legacy, developer_path, b"k" * 32) == {"replies": 1, "baselines": 1}
    assert migrate(legacy, developer_path, b"k" * 32) == {"replies": 0, "baselines": 0}
    with sqlite3.connect(developer_path) as db:
        assert (
            db.execute(
                "SELECT revision FROM replies WHERE revision!='outdated-revision'"
            ).fetchone()[0]
            == first["plugins"]["test.plugin"]["reviews"][0]["revision"]
        )
    assert before == legacy.read_bytes()
    with sqlite3.connect(legacy) as db:
        db.execute("UPDATE plugin_ratings SET created_at='recreated'")
    assert (
        export(legacy, bundle, output, b"k" * 32)["plugins"]["test.plugin"]["reviews"][
            0
        ]["id"]
        != old_id
    )
