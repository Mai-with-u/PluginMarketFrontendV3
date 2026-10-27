"""Private digest migration. Stop developer API/export/notifications first.

Preserves replies and notification baselines; legacy DB remains read-only.
"""

from pathlib import Path
from typing import Dict, Tuple
import argparse
import hashlib
import hmac
import json
import sqlite3


def migrate(legacy_path: Path, developer_path: Path, key: bytes) -> Dict[str, int]:
    if len(key) < 32:
        raise ValueError("Invalid export key")
    mappings: Dict[str, Tuple[str, str]] = {}
    source = sqlite3.connect(
        legacy_path.resolve().as_uri() + "?mode=ro", uri=True, timeout=2
    )
    source.row_factory = sqlite3.Row
    try:
        source.execute("PRAGMA query_only=ON")
        for row in source.execute(
            "SELECT * FROM plugin_ratings WHERE comment IS NOT NULL AND TRIM(comment) != ''"
        ):
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
            ).encode()
            review_id = hmac.new(key, identity.encode(), hashlib.sha256).hexdigest()
            mappings[review_id] = (
                hashlib.sha256(revision).hexdigest(),
                hmac.new(key, b"revision:" + revision, hashlib.sha256).hexdigest(),
            )
    finally:
        source.close()
    target = sqlite3.connect(developer_path, timeout=5)
    try:
        with target:
            target.execute("BEGIN IMMEDIATE")
            replies = 0
            baselines = 0
            for review_id, (old, new) in mappings.items():
                replies += target.execute(
                    "UPDATE replies SET revision=? WHERE review_id=? AND revision=?",
                    (new, review_id, old),
                ).rowcount
            for plugin_id, user_id, raw in target.execute(
                "SELECT plugin_id,user_id,reviews FROM baselines"
            ).fetchall():
                reviews = json.loads(raw)
                changed = False
                for review_id, current in reviews.items():
                    pair = mappings.get(review_id)
                    if pair and current == pair[0]:
                        reviews[review_id] = pair[1]
                        changed = True
                if changed:
                    target.execute(
                        "UPDATE baselines SET reviews=? WHERE plugin_id=? AND user_id=?",
                        (json.dumps(reviews), plugin_id, user_id),
                    )
                    baselines += 1
        return {"replies": replies, "baselines": baselines}
    finally:
        target.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--legacy-db", type=Path, required=True)
    parser.add_argument("--developer-db", type=Path, required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    args = parser.parse_args()
    print(migrate(args.legacy_db, args.developer_db, args.key_file.read_bytes()))
