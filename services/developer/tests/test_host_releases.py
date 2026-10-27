import httpx
import pytest

from developer import host_releases
from fastapi import HTTPException


def test_latest_is_authoritative_and_success_is_cached(monkeypatch):
    calls = []
    latest = {"tag_name": "v1.3.15", "draft": False, "prerelease": False}
    def handle(request):
        calls.append(request)
        assert "authorization" not in request.headers
        return httpx.Response(200, json=latest if request.url.path.endswith("/latest") else [
            {"tag_name": "v2.0.0", "prerelease": True},
            {"tag_name": "v1.4.0", "draft": True}, latest, {"tag_name": "1.3.14"},
        ])
    client = httpx.Client(transport=httpx.MockTransport(handle))
    monkeypatch.setattr(host_releases.httpx, "Client", lambda **kwargs: client)
    monkeypatch.setattr(host_releases, "_cached", None)
    monkeypatch.setattr(host_releases, "_expires_at", 0)
    result = host_releases.get_host_releases()
    assert result == {"latest": "1.3.15", "items": [
        {"version": "1.3.15", "tag": "v1.3.15"}, {"version": "1.3.14", "tag": "1.3.14"},
    ]}
    assert host_releases.get_host_releases() == result
    assert len(calls) == 2


def test_upstream_failure_is_explicit_and_not_cached(monkeypatch):
    client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(403)))
    monkeypatch.setattr(host_releases.httpx, "Client", lambda **kwargs: client)
    monkeypatch.setattr(host_releases, "_cached", None)
    monkeypatch.setattr(host_releases, "_expires_at", 0)
    with pytest.raises(HTTPException) as error:
        host_releases.get_host_releases()
    assert error.value.status_code == 503
    assert host_releases._cached is None
