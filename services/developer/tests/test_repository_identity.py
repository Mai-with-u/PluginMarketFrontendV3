from unittest.mock import patch
import json
import time

from fastapi import HTTPException
import httpx
import pytest

from developer.identities import github_repository
from developer.storage import connect
from test_security import claim, login, reply, setup  # noqa: F401


def discover(client, after=""):
    return client.get("/api/developer/claim-candidates", params={"after": after})


def test_renamed_user_and_repository_are_discovered_by_ids(setup, monkeypatch):
    settings, _, gh, client = setup
    original = gh.repository
    calls = []

    def renamed(name, token):
        calls.append(name)
        return original(name, token) | {"full_name": "new-login/new-repo"}

    monkeypatch.setattr(gh, "repository", renamed)
    login(client)
    assert discover(client).json()["items"] == ["test.plugin"]
    assert discover(client).json()["items"] == ["test.plugin"]
    assert calls == ["owner/repo"]  # Discovery cache avoids repeated GitHub calls.
    assert claim(client).json()["status"] == "active"
    assert reply(client).status_code == 200
    assert calls[-2:] == ["#100", "#100"]
    with connect(settings) as db:
        assert db.execute(
            "SELECT repo_id,owner_id FROM repository_identities"
        ).fetchone()[:] == (100, 42)


def test_existing_claim_pins_identity_before_old_username_can_be_reused(
    setup, monkeypatch
):
    settings, _, gh, client = setup
    login(client)
    assert claim(client).status_code == 200
    with connect(settings) as db:
        db.execute("DELETE FROM repository_identities")
    original = gh.repository

    def reused(name, token):
        result = original(name, token)
        if name != "#100":
            result["id"] = 999
            result["owner"]["id"] = 99
        return result

    monkeypatch.setattr(gh, "repository", reused)
    assert reply(client).status_code == 200


def test_transfer_between_discovery_and_claim_does_not_grant_permission(setup):
    _, _, gh, client = setup
    login(client)
    assert discover(client).json()["items"] == ["test.plugin"]
    gh.owner_id = 99
    assert claim(client).status_code == 403
    assert reply(client).status_code == 403


def test_transferred_repository_revokes_existing_reply_permission(setup):
    _, _, gh, client = setup
    login(client)
    assert claim(client).status_code == 200
    gh.owner_id = 99
    assert reply(client).status_code == 403


def test_source_url_can_change_only_to_same_repository_id(setup):
    settings, payload, gh, client = setup
    login(client)
    assert claim(client).status_code == 200
    payload["plugins"]["test.plugin"]["repository"] = "new-login/new-repo"
    settings.snapshot.write_text(json.dumps(payload))
    assert reply(client).status_code == 200
    payload["plugins"]["test.plugin"]["repository"] = "new-login/replacement"
    settings.snapshot.write_text(json.dumps(payload))
    gh.repo_id = 101
    assert reply(client).status_code == 403


def test_org_revoked_and_rejected_are_never_automatic_candidates(setup):
    settings, _, gh, client = setup
    login(client)
    gh.owner_type = "Organization"
    assert discover(client).json()["items"] == []
    gh.owner_type = "User"
    assert claim(client).status_code == 200
    for status in ("revoked", "rejected"):
        with connect(settings) as db:
            db.execute("UPDATE claims SET status=?", (status,))
        assert discover(client).json()["items"] == []
        assert claim(client).status_code == 403


def test_discovery_is_authenticated_paged_and_cache_refreshes(setup):
    settings, payload, gh, client = setup
    assert discover(client).status_code == 401
    login(client)
    original = payload["plugins"]["test.plugin"]
    payload["plugins"] = {
        f"plugin-{i:02}": original | {"id": f"plugin-{i:02}"} for i in range(10)
    }
    settings.snapshot.write_text(json.dumps(payload))
    first = discover(client).json()
    assert len(first["items"]) == 8
    assert first["next_after"] == "plugin-07"
    second = discover(client, first["next_after"]).json()
    assert second["items"] == ["plugin-08", "plugin-09"]
    assert second["next_after"] is None
    gh.owner_id = 99
    with connect(settings) as db:
        db.execute(
            "UPDATE repository_identities SET checked=?", (int(time.time()) - 3601,)
        )
    assert discover(client).json()["items"] == []


def test_unavailable_repo_is_reported_but_auth_outage_is_not_hidden(setup, monkeypatch):
    _, _, gh, client = setup
    login(client)

    def unavailable(name, token):
        raise HTTPException(409, "gone")

    monkeypatch.setattr(gh, "repository", unavailable)
    result = discover(client).json()
    assert result["items"] == []
    assert result["unavailable"] == [{"id": "test.plugin", "detail": "gone"}]

    def unauthorized(name, token):
        raise HTTPException(401, "expired")

    monkeypatch.setattr(gh, "repository", unauthorized)
    assert discover(client).status_code == 401


def test_only_github_repository_redirect_receives_authorization():
    calls = []

    def request(client, url, **kwargs):
        calls.append(url)
        assert kwargs["headers"]["Authorization"] == "Bearer test"
        if len(calls) == 1:
            return httpx.Response(
                301, headers={"location": "https://api.github.com/repositories/100"}
            )
        return httpx.Response(200, json={"id": 100})

    with patch.object(httpx.Client, "get", request):
        assert github_repository("old/repo", {"Authorization": "Bearer test"}) == {
            "id": 100
        }
    assert calls == [
        "https://api.github.com/repos/old/repo",
        "https://api.github.com/repositories/100",
    ]


@pytest.mark.parametrize(
    "target",
    [
        "https://evil.test/repositories/100",
        "http://api.github.com/repositories/100",
        "https://api.github.com@evil.test/repositories/100",
        "https://api.github.com/user",
        "https://api.github.com/repositories/100?token=x",
        "https://api.github.com:444/repositories/100",
        "https://api.github.com/repos/../user",
        "https://api.github.com/repositories/100#fragment",
    ],
)
def test_redirect_rejects_token_exfiltration(target):
    with patch.object(
        httpx.Client,
        "get",
        return_value=httpx.Response(301, headers={"location": target}),
    ) as request:
        with pytest.raises(HTTPException):
            github_repository("owner/repo", {"Authorization": "Bearer secret"})
        assert request.call_count == 1


def test_redirect_loop_is_bounded():
    with patch.object(
        httpx.Client,
        "get",
        return_value=httpx.Response(301, headers={"location": "/repositories/100"}),
    ) as request:
        with pytest.raises(HTTPException):
            github_repository("owner/repo", {})
        assert request.call_count == 4
