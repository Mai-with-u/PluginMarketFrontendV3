"""Public host release metadata, independently cached from plugin statistics."""

from fastapi import HTTPException
from threading import Lock
from typing import Any, Dict, Optional
import re
import time

import httpx


_lock = Lock()
_cached: Optional[Dict[str, Any]] = None
_expires_at = 0.0
_version = re.compile(r"v?\d+\.\d+\.\d+\Z")


def get_host_releases() -> Dict[str, Any]:
    global _cached, _expires_at
    # Serialize cold requests so concurrent visitors don't exhaust GitHub's public quota.
    with _lock:
        if _cached is not None and time.monotonic() < _expires_at:
            return _cached
        try:
            with httpx.Client(timeout=5, headers={
                "User-Agent": "MaiBotPluginMarket/1.0",
                "Accept": "application/vnd.github+json",
            }) as client:
                base = "https://api.github.com/repos/Mai-with-u/MaiBot/releases"
                latest_response = client.get(base + "/latest")
                latest_response.raise_for_status()
                history_response = client.get(base, params={"per_page": 100})
                history_response.raise_for_status()
                latest = latest_response.json()
                history = history_response.json()
            if (not isinstance(history, list) or latest.get("draft") or latest.get("prerelease")
                    or not _version.fullmatch(latest["tag_name"])):
                raise ValueError("Invalid stable release metadata")
            versions: Dict[str, Any] = {}
            for release in [latest, *history]:
                tag = release["tag_name"]
                if release.get("draft") or release.get("prerelease") or not _version.fullmatch(tag):
                    continue
                version = tag.removeprefix("v")
                versions.setdefault(version, {"version": version, "tag": tag})
            _cached = {"latest": latest["tag_name"].removeprefix("v"), "items": list(versions.values())}
            _expires_at = time.monotonic() + 900
            return _cached
        except (httpx.HTTPError, ValueError, TypeError, KeyError) as error:
            raise HTTPException(503, "MaiBot 发布版本读取失败，请点击刷新重试。") from error
