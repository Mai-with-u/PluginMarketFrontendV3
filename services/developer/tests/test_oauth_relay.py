from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
import hashlib
import hmac
import json

from fastapi import HTTPException
import httpx
import pytest

from developer.app import GitHub
from developer.storage import Settings


def settings():
    return Settings(Path("unused"), Path("unused"), "https://plugin.maibot.chat",
                    "our-client", "secret-stays-out-of-request", "unused", "ingress-key",
                    "independent-relay-key-" + "a" * 40)


def test_signed_exchange_preserves_pkce_and_verifies_identity():
    config = settings()
    calls = []

    def request(client, method, url, **kwargs):
        calls.append(url)
        if url.endswith("/api/internal/github/token"):
            assert method == "POST"
            body = kwargs["content"]
            headers = kwargs["headers"]
            expected = hmac.new(config.oauth_relay_key.encode(),
                                ("github-token-v1\n" + headers["X-OAuth-Timestamp"] + "\n" + body).encode(),
                                hashlib.sha256).hexdigest()
            assert hmac.compare_digest(expected, headers["X-OAuth-Signature"])
            assert json.loads(body) == {"code": "code", "verifier": "v" * 64}
            assert config.client_secret not in body
            assert kwargs["timeout"] == 20
            return httpx.Response(200, json={"access_token": "gho_token", "expires_in": 28800})
        assert url == "https://api.github.com/user"
        assert kwargs["headers"]["Authorization"] == "Bearer gho_token"
        return httpx.Response(200, json={"id": 42, "login": "verified-user"})

    with patch.object(httpx.Client, "request", request):
        assert GitHub(config).login("code", "v" * 64) == {
            "id": 42, "login": "verified-user", "token": "gho_token", "lifetime": 28800,
        }
    assert len(calls) == 2


@pytest.mark.parametrize("response", [
    httpx.Response(503, json={"detail": "unavailable"}),
    httpx.Response(200, json={"error": "bad_verification_code"}),
])
def test_failed_exchange_does_not_retry_or_create_identity(response):
    with patch.object(httpx.Client, "request", return_value=response) as request:
        with pytest.raises(HTTPException):
            GitHub(settings()).login("code", "v" * 64)
        assert request.call_count == 1


def test_short_relay_key_is_rejected_before_network():
    with patch.object(httpx.Client, "request") as request:
        with pytest.raises(HTTPException):
            GitHub(replace(settings(), oauth_relay_key="weak")).login("code", "v" * 64)
        request.assert_not_called()
