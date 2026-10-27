"""Local-only organization claim review. There is deliberately no public admin API."""

from cryptography.fernet import Fernet
import argparse
import time

from developer.app import GitHub
from developer.storage import Settings, connect


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action", choices=["list", "approve", "reject", "revoke", "reopen"]
    )
    parser.add_argument("--plugin")
    parser.add_argument("--user", type=int)
    parser.add_argument("--reason")
    args = parser.parse_args()
    settings = Settings.environment()
    with connect(settings) as db:
        if args.action == "list":
            for row in db.execute(
                "SELECT c.*,u.login FROM claims c JOIN users u ON u.id=c.user_id WHERE status='pending'"
            ):
                print(dict(row))
            return
        if not args.plugin or not args.user or not args.reason:
            parser.error("--plugin, --user and --reason are required")
        row = db.execute(
            "SELECT * FROM claims WHERE plugin_id=? AND user_id=?",
            (args.plugin, args.user),
        ).fetchone()
        if row is None:
            parser.error("Claim not found")
        if args.action == "reopen" and row["status"] not in ("revoked", "rejected"):
            parser.error("Only revoked or rejected claims can be reopened")
        if args.action == "approve":
            if row["kind"] != "Organization" or row["status"] != "pending":
                parser.error("Only pending organization claims can be approved")
            session = db.execute(
                "SELECT token FROM sessions WHERE user_id=? AND expires>? ORDER BY expires DESC LIMIT 1",
                (args.user, int(time.time())),
            ).fetchone()
            if session is None:
                parser.error("Applicant must sign in again before approval")
            token = (
                Fernet(settings.encryption_key)
                .decrypt(session["token"].encode())
                .decode()
            )
            # Numeric repository ID survives renames; owner ID detects transfers.
            gh = GitHub(settings)
            repo = gh.json(
                "GET",
                "https://api.github.com/repositories/" + str(row["repo_id"]),
                headers=gh.headers(token),
            )
            if (
                repo["owner"]["id"] != row["owner_id"]
                or repo["owner"]["type"] != "Organization"
                or repo.get("private", True)
                or not repo.get("permissions", {}).get("push")
            ):
                parser.error(
                    "Applicant no longer has push permission on the claimed public organization repository"
                )
        status = {
            "approve": "active",
            "reject": "rejected",
            "revoke": "revoked",
            "reopen": "pending",
        }[args.action]
        changed = db.execute(
            "UPDATE claims SET status=? WHERE plugin_id=? AND user_id=? AND status=? AND repo_id=? AND owner_id=? AND created=?",
            (
                status,
                args.plugin,
                args.user,
                row["status"],
                row["repo_id"],
                row["owner_id"],
                row["created"],
            ),
        )
        if changed.rowcount != 1:
            parser.error("Claim changed during review; inspect it again")
        db.execute(
            "INSERT INTO audit(actor,action,plugin_id,created) VALUES (?,?,?,?)",
            (
                "local-admin",
                args.action + ":user=" + str(args.user) + ":" + args.reason[:500],
                args.plugin,
                int(time.time()),
            ),
        )
        print("Claim", status)


if __name__ == "__main__":
    main()
