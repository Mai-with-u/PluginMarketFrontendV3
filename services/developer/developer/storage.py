from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator
import os
import sqlite3


@dataclass(frozen=True)
class Settings:
    database: Path
    snapshot: Path
    public_origin: str
    client_id: str
    client_secret: str
    encryption_key: str
    ingress_key: str
    oauth_relay_key: str = ""

    @classmethod
    def environment(cls) -> "Settings":
        return cls(
            Path(
                os.environ.get(
                    "DEVELOPER_DB", "/var/lib/maibot-developer/developer.sqlite3"
                )
            ),
            Path(
                os.environ.get(
                    "MARKET_SNAPSHOT", "/var/lib/maibot-developer-source/market.json"
                )
            ),
            os.environ.get("PUBLIC_ORIGIN", "https://plugin.maibot.chat").rstrip("/"),
            os.environ.get("GITHUB_CLIENT_ID", ""),
            os.environ.get("GITHUB_CLIENT_SECRET", ""),
            os.environ["ENCRYPTION_KEY"],
            os.environ["INGRESS_KEY"],
            os.environ.get("GITHUB_OAUTH_RELAY_KEY", ""),
        )


SCHEMA = """
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, login TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
 hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
 token TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_states(hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS claims(
 plugin_id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
 repo_id INTEGER NOT NULL, owner_id INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','pending','revoked','rejected')),
 kind TEXT NOT NULL CHECK(kind IN ('User','Organization')),
 created INTEGER NOT NULL, PRIMARY KEY(plugin_id,user_id));
CREATE TABLE IF NOT EXISTS repository_identities(
 plugin_id TEXT PRIMARY KEY, repository TEXT NOT NULL, repo_id INTEGER NOT NULL,
 owner_id INTEGER NOT NULL, kind TEXT NOT NULL, checked INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS replies(
 review_id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
 revision TEXT NOT NULL, body TEXT NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS comment_fold_requests(
 id INTEGER PRIMARY KEY, plugin_id TEXT NOT NULL, review_id TEXT NOT NULL,
 revision TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
 requester_login TEXT NOT NULL, repo_id INTEGER NOT NULL, owner_id INTEGER NOT NULL,
 reason TEXT NOT NULL, review_snapshot TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 created INTEGER NOT NULL, UNIQUE(plugin_id,review_id,revision,user_id));
CREATE TABLE IF NOT EXISTS baselines(
 plugin_id TEXT NOT NULL, user_id INTEGER NOT NULL, likes INTEGER NOT NULL,
 reviews TEXT NOT NULL, PRIMARY KEY(plugin_id,user_id));
CREATE TABLE IF NOT EXISTS notifications(
 id INTEGER PRIMARY KEY, plugin_id TEXT NOT NULL, user_id INTEGER NOT NULL,
 kind TEXT NOT NULL, message TEXT NOT NULL, review_id TEXT,
 created INTEGER NOT NULL, read_at INTEGER);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id,id DESC);
CREATE TABLE IF NOT EXISTS rate_limits(key TEXT NOT NULL, bucket INTEGER NOT NULL,
 count INTEGER NOT NULL, PRIMARY KEY(key,bucket));
CREATE TABLE IF NOT EXISTS audit(
 id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
 plugin_id TEXT NOT NULL, created INTEGER NOT NULL);
"""


@contextmanager
def connect(settings: Settings) -> Iterator[sqlite3.Connection]:
    db = sqlite3.connect(settings.database, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    try:
        with db:
            yield db
    finally:
        db.close()


def initialize(settings: Settings) -> None:
    settings.database.parent.mkdir(parents=True, exist_ok=True)
    with connect(settings) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript(SCHEMA)
