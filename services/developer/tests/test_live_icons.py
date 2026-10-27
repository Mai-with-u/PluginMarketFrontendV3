import json

import pytest

from export_snapshot import icon_url
from test_security import setup  # noqa: F401


def test_normalized_icon_tracks_registry_commit():
    detail = {"assets": {"icon_64": "icons/omsociety.schedule-assistant.webp"}}
    assert icon_url(detail, "a" * 40) == "/api/market/icons/" + "a" * 40 + "/omsociety.schedule-assistant.webp"
    assert icon_url(detail, "a" * 40) != icon_url(detail, "b" * 40)
    assert icon_url({"manifest": {"display": {"icon": {"value": "https://evil.test"}}}}, "") is None


@pytest.mark.parametrize("asset", ["https://evil.test/a.webp", "icons/../a.webp", "icons/a.svg", "icons/x.webp?x", "icons/a/b.webp"])
def test_untrusted_assets_are_not_exported(asset):
    with pytest.raises(ValueError):
        icon_url({"assets": {"icon_64": asset}}, "a" * 40)


def test_icons_need_immutable_commit():
    with pytest.raises(ValueError):
        icon_url({"assets": {"icon_64": "icons/a.webp"}}, "main")


def test_public_catalog_exposes_only_normalized_icon(setup):
    settings, payload, _, client = setup
    entry = payload["plugins"]["test.plugin"]
    entry.update(manifest={}, downloads=0, downloads_7d=0, downloads_30d=0, rating=0,
                 rating_count=0, releases=[], icon_url="/api/market/icons/" + "a" * 40 + "/test.webp")
    payload["catalog_synced_at"] = "now"
    settings.snapshot.write_text(json.dumps(payload))
    response = client.get("/api/market/catalog")
    assert response.status_code == 200
    assert response.json()["items"][0]["icon_url"] == entry["icon_url"]
    assert "reviews" not in response.json()["items"][0]
