"""Read-only export; this process never imports or writes the running market service.

Only public review fields and aggregate votes leave the legacy database. The
HMAC key prevents guessing a guest's legacy user_id from the public review ID.
"""

from pathlib import Path
from typing import Any, Dict
from urllib.parse import quote
import argparse
import hashlib
import hmac
import json
import os
import re
import sqlite3
import time


def export(
    database: Path, bundle: Path, destination: Path, key: bytes
) -> Dict[str, Any]:
    if len(key) < 32:
        raise ValueError("Export key must contain at least 32 bytes")
    exported_at = int(time.time())
    catalog = json.loads(bundle.read_text(encoding="utf-8"))
    details = {entry["id"].casefold(): entry for entry in catalog["details"]}
    plugins: Dict[str, Any] = {}
    for entry in catalog["versions"]["plugins"]:
        manifest = details.get(entry["id"].casefold(), {}).get("manifest", {})
        canonical = entry.get("manifest_id") or manifest.get("id") or entry["id"]
        repo = entry.get("repositoryUrl", "")
        match = re.fullmatch(
            r"https://github\.com/([\w.-]+)/([\w.-]+?)(?:\.git)?/?", repo
        )
        if not match:
            continue
        # Preserve the exact canonical ID: legacy SQLite keys are case sensitive.
        if canonical in plugins:
            raise ValueError("Duplicate canonical plugin id: " + canonical)
        plugins[canonical] = {
            "id": canonical,
            "market_id": entry["id"],
            "name": manifest.get("name", entry["id"]),
            "repository": "/".join(match.groups()),
            "likes": 0,
            "dislikes": 0,
            "downloads": 0,
            "downloads_7d": 0,
            "downloads_30d": 0,
            "rating": 0,
            "rating_count": 0,
            "manifest": {field: manifest[field] for field in (
                "id", "name", "description", "version", "author", "license", "urls",
                "host_application", "sdk", "keywords", "categories", "plugin_type",
                "capabilities", "dependencies", "manifest_version",
            ) if field in manifest},
            "release_mode": entry.get("mode", "releases"),
            "releases": [],
            "reviews": [],
        }
        # Export only public release metadata, never the full manifest or arbitrary URLs.
        releases = plugins[canonical]["releases"]
        for version in entry.get("versions", []):
            tag = version.get("tag")
            release_manifest = version.get("manifest", {})
            releases.append({
                "version": version["version"], "tag": tag,
                "status": "yanked" if version.get("yanked") else (
                    "prerelease" if version.get("prerelease") else "published"
                ),
                "published_at": version.get("published_at"),
                "notes": version.get("release_notes", ""),
                "commit": version.get("commit"),
                "url": "https://github.com/" + "/".join(match.groups()) + (
                    "/releases/tag/" + quote(tag, safe="") if tag else ""
                ),
                "host": release_manifest.get("host_application", {}),
                "sdk": release_manifest.get("sdk", {}),
                "error": None,
            })
        for rejected in entry.get("rejected_releases", []):
            releases.append({
                "version": rejected.get("version"), "tag": rejected["tag"],
                "status": "rejected", "published_at": None,
                "url": "https://github.com/" + "/".join(match.groups())
                + "/releases/tag/" + quote(rejected["tag"], safe=""),
                "host": {}, "sdk": {}, "error": rejected.get("error"),
            })
        for tag in entry.get("ignored_tags", []):
            releases.append({
                "version": None, "tag": tag, "status": "ignored",
                "published_at": None,
                "url": "https://github.com/" + "/".join(match.groups())
                + "/releases/tag/" + quote(tag, safe=""),
                "host": {}, "sdk": {}, "error": None,
            })
    db = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        # One aggregate query over the existing read-only database; no per-plugin queries.
        # Use UTC epoch conversion so offsets and fractional ISO timestamps compare correctly.
        for row in db.execute(
            "SELECT plugin_id, COUNT(*) AS downloads, "
            "SUM(CASE WHEN julianday(created_at) >= julianday(?, 'unixepoch') THEN 1 ELSE 0 END) AS downloads_7d, "
            "SUM(CASE WHEN julianday(created_at) >= julianday(?, 'unixepoch') THEN 1 ELSE 0 END) AS downloads_30d "
            "FROM plugin_download_events WHERE counted = 1 "
            "AND julianday(created_at) <= julianday(?, 'unixepoch') GROUP BY plugin_id",
            (exported_at - 7 * 86400, exported_at - 30 * 86400, exported_at),
        ):
            if row["plugin_id"] in plugins:
                for field in ("downloads", "downloads_7d", "downloads_30d"):
                    plugins[row["plugin_id"]][field] = row[field]
        for row in db.execute(
            "SELECT plugin_id, vote, COUNT(*) AS n FROM plugin_votes GROUP BY plugin_id,vote"
        ):
            if row["plugin_id"] in plugins:
                plugins[row["plugin_id"]][
                    "likes" if row["vote"] == 1 else "dislikes"
                ] = row["n"]
        for row in db.execute(
            "SELECT plugin_id, AVG(rating) AS rating, COUNT(rating) AS rating_count "
            "FROM plugin_ratings WHERE rating IS NOT NULL GROUP BY plugin_id"
        ):
            if row["plugin_id"] in plugins:
                plugins[row["plugin_id"]].update(rating=round(row["rating"], 2), rating_count=row["rating_count"])
        for row in db.execute(
            "SELECT * FROM plugin_ratings WHERE comment IS NOT NULL AND TRIM(comment) != ''"
        ):
            if row["plugin_id"] not in plugins:
                continue
            identity = json.dumps(
                [row["plugin_id"], row["user_id"], row["created_at"]],
                separators=(",", ":"),
            )
            revision = json.dumps(
                [
                    row["comment"],
                    row["rating"],
                    row["updated_at"],
                    row["anonymous"],
                    row["username"],
                ]
            )
            plugins[row["plugin_id"]]["reviews"].append(
                {
                    "id": hmac.new(key, identity.encode(), hashlib.sha256).hexdigest(),
                    # A public unkeyed hash of the hidden username permits dictionary attacks.
                    "revision": hmac.new(
                        key, b"revision:" + revision.encode(), hashlib.sha256
                    ).hexdigest(),
                    "comment": row["comment"],
                    "rating": row["rating"],
                    "username": row["username"] if not row["anonymous"] else None,
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                }
            )
    finally:
        db.close()
    for plugin in plugins.values():
        plugin["reviews"].sort(
            key=lambda item: (item["updated_at"], item["id"]), reverse=True
        )
    payload = {
        "schema": 1,
        "exported_at": exported_at,
        "catalog_synced_at": catalog["synced_at"],
        "plugins": plugins,
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".tmp")
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        temporary.chmod(0o640)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return payload


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    args = parser.parse_args()
    result = export(
        args.database, args.bundle, args.destination, args.key_file.read_bytes()
    )
    print("Exported", len(result["plugins"]), "plugins")
