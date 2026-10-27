import json

import pytest

from developer.storage import connect
from test_security import claim, login, setup  # noqa: F401


PATH = "/api/developer/plugins/Test.Plugin/reviews/" + "a" * 64 + "/fold-request"


def submit(client, **changes):
    return client.post(
        PATH, json={"revision": "b" * 64, "reason": "  包含无关广告  ", **changes}
    )


def test_request_is_persisted_idempotent_private_and_does_not_fold(setup):
    settings, _, _, client = setup
    login(client)
    claim(client)
    before = client.get("/api/feedback/Test.Plugin").json()
    result = submit(client)
    assert result.status_code == 200
    assert result.json()["status"] == "pending"
    assert submit(client, reason="不要覆盖原申请").json() == result.json()
    with connect(settings) as db:
        rows = db.execute("SELECT * FROM comment_fold_requests").fetchall()
        assert len(rows) == 1
        row = dict(rows[0])
        assert row["user_id"] == 42
        assert row["requester_login"] == "developer42"
        assert row["repo_id"] == 100 and row["owner_id"] == 42
        assert row["reason"] == "包含无关广告"
        assert json.loads(row["review_snapshot"])["comment"] == "<script>bad()</script>"
        assert (
            db.execute(
                "SELECT count(*) FROM audit WHERE action='comment_fold_request'"
            ).fetchone()[0]
            == 1
        )
    assert client.get("/api/feedback/Test.Plugin").json() == before
    private = client.get("/api/developer/plugins/Test.Plugin/feedback").json()
    assert private["items"][0]["fold_request"] == result.json()
    assert "reason" not in private["items"][0]["fold_request"]


def test_request_requires_login_claim_and_csrf(setup):
    settings, _, _, client = setup
    assert submit(client).status_code == 403  # Missing browser Origin.
    login(client)
    assert submit(client).status_code == 403
    assert client.get("/api/developer/plugins/Test.Plugin/feedback").status_code == 403
    claim(client)
    assert (
        client.post(
            PATH,
            headers={"x-csrf-token": "wrong"},
            json={"revision": "b" * 64, "reason": "reason"},
        ).status_code
        == 403
    )
    client.post("/api/auth/logout", json={})
    assert submit(client).status_code == 401
    assert client.get("/api/developer/plugins/Test.Plugin/feedback").status_code == 401
    with connect(settings) as db:
        assert (
            db.execute("SELECT count(*) FROM comment_fold_requests").fetchone()[0] == 0
        )


@pytest.mark.parametrize(
    "changes",
    [
        {"reason": " "},
        {"reason": "x" * 1001},
        {"user_id": 99},
        {"status": "approved"},
        {"revision": "bad"},
    ],
)
def test_invalid_request_cannot_be_saved(setup, changes):
    settings, _, _, client = setup
    login(client)
    claim(client)
    assert submit(client, **changes).status_code == 422
    with connect(settings) as db:
        assert (
            db.execute("SELECT count(*) FROM comment_fold_requests").fetchone()[0] == 0
        )


def test_stale_deleted_or_other_plugin_comment_rejected(setup):
    settings, payload, _, client = setup
    login(client)
    claim(client)
    assert submit(client, revision="c" * 64).status_code == 409
    assert (
        client.post(
            PATH.replace("a" * 64, "c" * 64),
            json={"revision": "b" * 64, "reason": "reason"},
        ).status_code
        == 404
    )
    assert submit(client).status_code == 200
    payload["plugins"]["test.plugin"]["reviews"] = []
    settings.snapshot.write_text(json.dumps(payload))
    assert submit(client).status_code == 404
    with connect(settings) as db:
        assert (
            db.execute("SELECT count(*) FROM comment_fold_requests").fetchone()[0] == 1
        )


def test_revision_change_keeps_original_evidence_and_allows_new_request(setup):
    settings, payload, _, client = setup
    login(client)
    claim(client)
    submit(client)
    review = payload["plugins"]["test.plugin"]["reviews"][0]
    review.update(revision="c" * 64, comment="edited")
    settings.snapshot.write_text(json.dumps(payload))
    assert (
        client.get("/api/developer/plugins/Test.Plugin/feedback").json()["items"][0][
            "fold_request"
        ]
        is None
    )
    assert submit(client, revision="c" * 64).status_code == 200
    with connect(settings) as db:
        rows = db.execute(
            "SELECT review_snapshot FROM comment_fold_requests ORDER BY id"
        ).fetchall()
        assert len(rows) == 2
        assert json.loads(rows[0][0])["comment"] == "<script>bad()</script>"
        assert json.loads(rows[1][0])["comment"] == "edited"


def test_transfer_and_revocation_during_check_cannot_submit(setup, monkeypatch):
    settings, _, gh, client = setup
    login(client)
    claim(client)
    original = gh.repository

    def revoke(name, token):
        with connect(settings) as db:
            db.execute("UPDATE claims SET status='revoked'")
        return original(name, token)

    monkeypatch.setattr(gh, "repository", revoke)
    assert submit(client).status_code == 403
    with connect(settings) as db:
        assert (
            db.execute("SELECT count(*) FROM comment_fold_requests").fetchone()[0] == 0
        )


def test_applications_are_not_shared_with_other_accounts(setup):
    _, _, gh, client = setup
    login(client)
    claim(client)
    submit(client)
    gh.user_id = 99
    gh.owner_id = 99
    login(client)
    assert client.get("/api/developer/plugins/Test.Plugin/feedback").status_code == 403
    assert claim(client).status_code == 200
    assert (
        client.get("/api/developer/plugins/Test.Plugin/feedback").json()["items"][0][
            "fold_request"
        ]
        is None
    )
