from datetime import datetime, timezone
import json
import sqlite3

import export_snapshot
from test_security import login, setup


def test_download_windows_and_public_release_projection(tmp_path, monkeypatch):
    now = 1800000000
    monkeypatch.setattr(export_snapshot.time, "time", lambda: now)
    database = tmp_path / "legacy.db"
    with sqlite3.connect(database) as db:
        db.executescript(
            "CREATE TABLE plugin_download_events(plugin_id TEXT,created_at TEXT,counted INTEGER);"
            "CREATE TABLE plugin_votes(plugin_id TEXT,vote INTEGER);"
            "CREATE TABLE plugin_ratings(plugin_id TEXT,comment TEXT,rating INTEGER);"
        )
        for seconds, counted, plugin in [
            (1, 1, "test.plugin"), (7 * 86400, 1, "test.plugin"),
            (7 * 86400 + 1, 1, "test.plugin"), (30 * 86400, 1, "test.plugin"),
            (30 * 86400 + 1, 1, "test.plugin"), (2, 0, "test.plugin"),
            (-100, 1, "test.plugin"), (1, 1, "other.plugin"),
        ]:
            db.execute("INSERT INTO plugin_download_events VALUES (?,?,?)", (
                plugin, datetime.fromtimestamp(now - seconds, timezone.utc).isoformat(), counted,
            ))
    bundle = tmp_path / "bundle.json"
    bundle.write_text(json.dumps({
        "synced_at": "2026-10-26T00:00:00Z", "details": [],
        "versions": {"plugins": [{
            "id": "Test.Plugin", "manifest_id": "test.plugin",
            "repositoryUrl": "https://github.com/owner/repo", "mode": "releases",
            "versions": [
                {"version": "1.0", "tag": "v1.0", "manifest": {"secret": "not-exported"}, "release_url": "javascript:alert(1)"},
                {"version": "2.0", "tag": "v2.0", "prerelease": True},
                {"version": "0.1", "tag": "v0.1", "yanked": True},
            ],
            "rejected_releases": [{"tag": "v3.0", "version": "3.0", "error": "version mismatch"}],
            "ignored_tags": ["test/tag"],
        }]},
    }))
    before = database.read_bytes()
    result = export_snapshot.export(database, bundle, tmp_path / "out.json", b"k" * 32)
    plugin = result["plugins"]["test.plugin"]
    assert (plugin["downloads"], plugin["downloads_7d"], plugin["downloads_30d"]) == (5, 2, 4)
    assert [r["status"] for r in plugin["releases"]] == ["published", "prerelease", "yanked", "rejected", "ignored"]
    assert plugin["releases"][-1]["url"].endswith("test%2Ftag")
    assert "not-exported" not in json.dumps(result)
    assert "javascript:" not in json.dumps(result)
    assert database.read_bytes() == before


def test_release_endpoint_requires_login_and_omits_history_from_list(setup):
    settings, payload, _, client = setup
    payload["catalog_synced_at"] = "2026-10-26T00:00:00Z"
    entry = payload["plugins"]["test.plugin"]
    entry.update(release_mode="releases", releases=[{"tag": "v1.0"}])
    settings.snapshot.write_text(json.dumps(payload))
    path = "/api/developer/plugins/test.plugin/releases"
    assert client.get(path).status_code == 401
    login(client)
    assert client.get(path).json()["items"] == [{"tag": "v1.0"}]
    assert "releases" not in client.get("/api/developer/plugins").json()["items"][0]
    assert client.get("/api/developer/plugins/missing/releases").status_code == 404


def test_public_catalog_is_read_only_and_excludes_review_and_account_data(setup):
    settings, payload, _, client = setup
    payload["catalog_synced_at"] = "2026-10-26T00:00:00Z"
    entry = payload["plugins"]["test.plugin"]
    entry.update(manifest={"name": "test"}, downloads=12, downloads_7d=2, downloads_30d=3,
                 rating=4.5, rating_count=2, release_mode="releases", releases=[])
    settings.snapshot.write_text(json.dumps(payload))
    response = client.get("/api/market/catalog")
    assert response.status_code == 200
    public = response.json()["items"][0]
    assert public["downloads"] == 12 and public["comments"] == 1
    assert "reviews" not in public and "claim" not in public and "user_id" not in public
    assert client.get("/api/market/plugins/test.plugin/releases").status_code == 200
    assert client.post("/api/market/catalog").status_code in (403, 405)
