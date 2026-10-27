from typing import Any, Dict
import json
import sqlite3
import time

from .storage import Settings, connect


def synchronize(db: sqlite3.Connection, entry: Dict[str, Any], user_id: int) -> None:
    current = {review["id"]: review["revision"] for review in entry["reviews"]}
    old = db.execute(
        "SELECT * FROM baselines WHERE plugin_id=? AND user_id=?",
        (entry["id"], user_id),
    ).fetchone()
    now = int(time.time())
    if old is not None:
        previous = json.loads(old["reviews"])
        for review_id, revision in current.items():
            if previous.get(review_id) != revision:
                message = "收到新评论" if review_id not in previous else "有评论更新"
                db.execute(
                    "INSERT INTO notifications(plugin_id,user_id,kind,message,review_id,created) VALUES (?,?,?,?,?,?)",
                    (entry["id"], user_id, "review", message, review_id, now),
                )
        delta = entry["likes"] - old["likes"]
        if delta != 0:
            db.execute(
                "INSERT INTO notifications(plugin_id,user_id,kind,message,created) VALUES (?,?,?,?,?)",
                (
                    entry["id"],
                    user_id,
                    "likes",
                    "点赞净变化 " + ("+" if delta > 0 else "") + str(delta),
                    now,
                ),
            )
    db.execute(
        "INSERT INTO baselines VALUES (?,?,?,?) ON CONFLICT(plugin_id,user_id) DO UPDATE SET likes=excluded.likes,reviews=excluded.reviews",
        (entry["id"], user_id, entry["likes"], json.dumps(current)),
    )
    db.execute(
        "DELETE FROM notifications WHERE user_id=? AND id NOT IN (SELECT id FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 1000)",
        (user_id, user_id),
    )


def refresh(settings: Settings) -> None:
    data = json.loads(settings.snapshot.read_text(encoding="utf-8"))
    if data["schema"] != 1 or not -30 <= time.time() - data["exported_at"] <= 300:
        raise RuntimeError("Source snapshot is stale")
    with connect(settings) as db:
        # Serialize baseline advancement so timer and inbox reads cannot duplicate events.
        db.execute("BEGIN IMMEDIATE")
        claims = db.execute(
            "SELECT plugin_id,user_id FROM claims WHERE status='active'"
        ).fetchall()
        for claim in claims:
            if claim["plugin_id"] in data["plugins"]:
                synchronize(db, data["plugins"][claim["plugin_id"]], claim["user_id"])
        db.execute("DELETE FROM sessions WHERE expires<?", (int(time.time()),))
        db.execute("DELETE FROM oauth_states WHERE expires<?", (int(time.time()),))


if __name__ == "__main__":
    refresh(Settings.environment())
