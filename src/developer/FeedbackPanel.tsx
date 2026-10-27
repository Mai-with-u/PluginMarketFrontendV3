import { Component, useEffect, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";

import { Icon } from "../components/Icon.tsx";
import { mutate, useResource } from "./api.ts";
import type { Feedback, Review, Session } from "./api.ts";
import { shortDate } from "./format.ts";

import "./developer.css";

function Rating({ value }: { value: number }) {
  return (
    <span className="feedback-rating" title={`${value}/5`}>
      {[1, 2, 3, 4, 5].map((step) => (
        <span key={step} aria-hidden="true" data-on={step <= Math.round(value)} />
      ))}
      <span className="visually-hidden">评分 {value}/5</span>
    </span>
  );
}

function FoldRequest({
  review,
  pluginId,
  session,
  refresh,
}: {
  review: Review;
  pluginId: string;
  session: Session;
  refresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (busy || !reason.trim()) return;
    setBusy(true);
    setError("");
    try {
      await mutate(
        `/api/developer/plugins/${encodeURIComponent(pluginId)}/reviews/${review.id}/fold-request`,
        session.csrf,
        "POST",
        { revision: review.revision, reason: reason.trim() },
      );
      setSubmitted(true);
      refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "申请未保存，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  if (review.fold_request || submitted) {
    const status = review.fold_request?.status ?? "pending";
    return (
      <output className="developer-hint">
        {status === "pending"
          ? "已申请折叠 · 待管理员审核"
          : status === "approved"
            ? "折叠申请已通过"
            : "折叠申请未通过"}
      </output>
    );
  }
  if (!open)
    return (
      <button type="button" className="developer-text-button" onClick={() => setOpen(true)}>
        申请折叠评论
      </button>
    );
  return (
    <form
      className="feedback-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={`fold-reason-${review.id}`}>申请折叠的理由</label>
      <textarea
        id={`fold-reason-${review.id}`}
        value={reason}
        maxLength={1000}
        required
        disabled={busy}
        placeholder="请说明为什么需要折叠这条评论"
        onChange={(event) => setReason(event.target.value)}
      />
      <p className="developer-hint">申请会保存并等待管理员审核，评论目前仍会正常显示。</p>
      <div className="feedback-form-actions">
        <button
          type="button"
          className="developer-button is-quiet"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          取消
        </button>
        <button type="submit" className="developer-button" disabled={busy || !reason.trim()}>
          {busy ? "正在提交…" : "提交申请"}
        </button>
      </div>
      {error && (
        <p className="developer-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

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
  const name = review.username ?? "匿名用户";
  const pending = session !== undefined && review.reply === null;
  const own = review.reply?.login.toLowerCase() === session?.login.toLowerCase();
  return (
    <article className="feedback-review" id={`review-${review.id}`}>
      <span className="feedback-avatar" aria-hidden="true">
        {Array.from(name)[0]?.toUpperCase()}
        {pending && <span className="feedback-pending" />}
      </span>
      <div className="feedback-body">
        <div className="feedback-meta">
          <strong>{name}</strong>
          {review.rating !== null && <Rating value={review.rating} />}
          {pending && <span className="visually-hidden">，待回复</span>}
          <time dateTime={review.updated_at}>{shortDate(review.updated_at)}</time>
        </div>
        <p className="feedback-content">{review.comment}</p>
        {review.reply && !editing && (
          <div className="feedback-reply">
            <div className="feedback-reply-meta">
              <span>
                {own ? "你的回复" : `开发者回复 · @${review.reply.login}`} ·{" "}
                {shortDate(review.reply.updated)}
              </span>
              {session && (
                <button
                  type="button"
                  className="developer-ghost"
                  aria-label="编辑回复"
                  onClick={() => setEditing(true)}
                >
                  <Icon name="edit" size={14} />
                </button>
              )}
            </div>
            <p className="feedback-content">{review.reply.body}</p>
          </div>
        )}
        {session && !review.reply && !editing && (
          <button className="developer-text-button" type="button" onClick={() => setEditing(true)}>
            <Icon name="reply" size={14} />
            回复
          </button>
        )}
        {session && editing && (
          <form
            className="feedback-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save(false);
            }}
          >
            <label className="visually-hidden" htmlFor={`reply-${review.id}`}>
              回复 {name}
            </label>
            <textarea
              id={`reply-${review.id}`}
              value={draft}
              maxLength={2000}
              required
              disabled={busy}
              placeholder={`回复 ${name}，会公开显示在这条评论下方`}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="feedback-form-actions">
              {review.reply && (
                <button
                  className="developer-text-button is-danger"
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
                className="developer-button is-quiet"
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setDraft(review.reply?.body ?? "");
                }}
              >
                取消
              </button>
              <button
                className="developer-button"
                type="submit"
                disabled={busy || draft.trim() === ""}
              >
                {busy ? "正在保存…" : "发布回复"}
              </button>
            </div>
            {error && (
              <p className="developer-error" role="alert">
                {error}
              </p>
            )}
          </form>
        )}
        {session && (
          <FoldRequest review={review} pluginId={pluginId} session={session} refresh={refresh} />
        )}
      </div>
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

interface FeedbackProps {
  pluginId: string;
  session?: Session;
  /** Inside the developer center, where the surrounding tab already names and explains it. */
  embedded?: boolean;
  revision?: number;
  onPending?: (count: number) => void;
}

export function FeedbackPanel(props: FeedbackProps) {
  return (
    <FeedbackBoundary key={props.pluginId}>
      <FeedbackContent {...props} />
    </FeedbackBoundary>
  );
}

function FeedbackContent({
  pluginId,
  session,
  embedded = false,
  revision = 0,
  onPending,
}: FeedbackProps) {
  const [offset, setOffset] = useState(0);
  const [localRevision, setLocalRevision] = useState(0);
  const result = useResource<Feedback>(
    session
      ? `/api/developer/plugins/${encodeURIComponent(pluginId)}/feedback?offset=${offset}`
      : `/api/feedback/${encodeURIComponent(pluginId)}?offset=${offset}`,
    // Both counters only grow, so their sum changes whenever either one does.
    revision + localRevision,
  );
  const items = result?.data?.items ?? [];
  const pending = session ? items.filter((review) => review.reply === null).length : 0;
  const loaded = result?.data !== undefined;
  useEffect(() => {
    if (loaded) onPending?.(pending);
  }, [loaded, pending, onPending]);
  // Developers see unanswered reviews first; everyone else reads them in order.
  const ordered = session
    ? items.toSorted((a, b) => Number(a.reply !== null) - Number(b.reply !== null))
    : items;
  return (
    <section
      className={embedded ? "feedback-panel is-embedded" : "feedback-panel"}
      aria-label="评论与开发者回复"
    >
      {!embedded && (
        <>
          <div className="feedback-head">
            <h3>评论与回复</h3>
            {result?.data && (
              <span className="feedback-summary">
                {result.data.likes} 赞 · {result.data.dislikes} 踩 · {result.data.total} 条评论
              </span>
            )}
            <button
              type="button"
              className="developer-text-button"
              onClick={() => setLocalRevision((value) => value + 1)}
            >
              刷新
            </button>
          </div>
          <p className="developer-caption">
            来自现有市场的用户反馈，署名不代表 GitHub 身份。约每分钟同步。
          </p>
        </>
      )}
      {result?.error && <p className="developer-error">{result.error.message}</p>}
      {!result && <p className="developer-empty">正在读取评论…</p>}
      {result?.data && (
        <>
          {items.length === 0 && <p className="developer-empty">还没有评论</p>}
          <div className="feedback-list">
            {ordered.map((review) => (
              <ReviewItem
                key={`${review.id}:${review.revision}:${review.reply?.updated ?? 0}`}
                review={review}
                pluginId={pluginId}
                session={session}
                refresh={() => setLocalRevision((value) => value + 1)}
              />
            ))}
          </div>
          {(offset > 0 || result.data.next_offset !== null) && (
            <div className="feedback-pages">
              <button
                type="button"
                className="developer-text-button"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 20))}
              >
                上一页
              </button>
              <span>第 {Math.floor(offset / 20) + 1} 页</span>
              <button
                type="button"
                className="developer-text-button"
                disabled={result.data.next_offset === null}
                onClick={() => {
                  if (result.data?.next_offset !== null && result.data?.next_offset !== undefined)
                    setOffset(result.data.next_offset);
                }}
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
