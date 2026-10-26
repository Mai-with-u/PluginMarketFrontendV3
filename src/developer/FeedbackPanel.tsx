import { Component, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";

import { mutate, useResource } from "./api.ts";
import type { Feedback, Review, Session } from "./api.ts";

import "./developer.css";

function ReviewItem({
  review,
  pluginId,
  session,
  refresh,
}: {
  review: Review;
  pluginId: string;
  session?: Session;
  refresh: () => void;
}) {
  const [draft, setDraft] = useState(review.reply?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const save = async (remove: boolean) => {
    if (!session) return;
    setBusy(true);
    setError("");
    try {
      await mutate(
        `/api/developer/plugins/${encodeURIComponent(pluginId)}/reviews/${review.id}/reply`,
        session.csrf,
        remove ? "DELETE" : "PUT",
        remove ? {} : { revision: review.revision, body: draft },
      );
      refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "回复未保存");
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="feedback-review" id={`review-${review.id}`}>
      <p className="developer-muted">
        {review.username ?? "匿名用户"} · {review.updated_at.slice(0, 10)}
        {review.rating !== null && ` · ${review.rating}/5`}
      </p>
      <p className="feedback-content">{review.comment}</p>
      {review.reply && (
        <blockquote>
          <strong>开发者回复 · @{review.reply.login}</strong>
          <p className="feedback-content">{review.reply.body}</p>
        </blockquote>
      )}
      {session && !editing && (
        <button className="developer-link" type="button" onClick={() => setEditing(true)}>
          {review.reply ? "编辑回复" : "回复评论"}
        </button>
      )}
      {session && editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(false);
          }}
        >
          <label>
            开发者回复
            <textarea
              value={draft}
              maxLength={2000}
              required
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <div className="developer-actions">
            <button
              className="developer-button"
              type="submit"
              disabled={busy || draft.trim() === ""}
            >
              {busy ? "正在保存…" : "发布回复"}
            </button>
            {review.reply && (
              <button
                className="developer-link"
                type="button"
                disabled={busy}
                onClick={() => {
                  void save(true);
                }}
              >
                删除回复
              </button>
            )}
            <button
              className="developer-link"
              type="button"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              取消
            </button>
          </div>
          {error && (
            <p className="developer-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </article>
  );
}

class FeedbackBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[feedback]", error, info.componentStack);
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="feedback-panel">
        <p className="developer-muted">评论暂时无法显示，插件目录仍可使用。</p>
        <button
          className="developer-link"
          type="button"
          onClick={() => this.setState({ failed: false })}
        >
          重新读取评论
        </button>
      </section>
    );
  }
}

export function FeedbackPanel({ pluginId, session }: { pluginId: string; session?: Session }) {
  return (
    <FeedbackBoundary key={pluginId}>
      <FeedbackContent pluginId={pluginId} session={session} />
    </FeedbackBoundary>
  );
}

function FeedbackContent({ pluginId, session }: { pluginId: string; session?: Session }) {
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const result = useResource<Feedback>(
    `/api/feedback/${encodeURIComponent(pluginId)}?offset=${offset}`,
    revision,
  );
  return (
    <section className="feedback-panel" aria-label="评论与开发者回复">
      <div className="developer-actions">
        <h3>评论与回复</h3>
        <button
          type="button"
          className="developer-link"
          onClick={() => setRevision((value) => value + 1)}
        >
          刷新
        </button>
      </div>
      {result?.error && <output className="developer-muted">{result.error.message}</output>}
      {!result && <output className="developer-muted">正在读取评论…</output>}
      {result?.data && (
        <>
          <p className="developer-muted">
            {result.data.likes} 赞 · {result.data.dislikes} 踩 · {result.data.total} 条评论
          </p>
          <p className="developer-caption">
            来自现有市场的用户反馈，署名不代表 GitHub 身份。约每分钟同步。
          </p>
          {result.data.items.length === 0 && <p className="developer-muted">暂无评论。</p>}
          {result.data.items.map((review) => (
            <ReviewItem
              key={`${review.id}:${review.revision}:${review.reply?.updated ?? 0}`}
              review={review}
              pluginId={pluginId}
              session={session}
              refresh={() => setRevision((value) => value + 1)}
            />
          ))}
          <div className="developer-actions">
            <button
              type="button"
              className="developer-link"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              上一页
            </button>
            <span className="developer-muted">第 {Math.floor(offset / 20) + 1} 页</span>
            <button
              type="button"
              className="developer-link"
              disabled={result.data.next_offset === null}
              onClick={() => {
                if (result.data?.next_offset !== null && result.data?.next_offset !== undefined)
                  setOffset(result.data.next_offset);
              }}
            >
              下一页
            </button>
          </div>
        </>
      )}
    </section>
  );
}
