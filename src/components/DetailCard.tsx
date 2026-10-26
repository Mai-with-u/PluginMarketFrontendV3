import { hostRange, sdkRange, sectorCode } from "../data/catalog.ts";
import type { Catalog } from "../data/types.ts";
import { FeedbackPanel } from "../developer/FeedbackPanel.tsx";
import type { Pin } from "../map/layout.ts";
import { Icon } from "./Icon.tsx";
import { CopyRepoButton, Monogram } from "./parts.tsx";

const CAP_LIMIT = 12;

/** 名称里括号中的英文名拆出来做副标题：群聊禁言管理插件 (Mute Plugin) */
function splitName(name: string): [string, string | null] {
  const m = /^(.*?)\s*[(（]([^()（）]*[A-Za-z][^()（）]*)[)）]\s*$/.exec(name);
  if (m?.[1] !== undefined && m[2] !== undefined && m[1] !== "") return [m[1], m[2]];
  return [name, null];
}

export function DetailCard({
  catalog,
  pin,
  onClose,
}: {
  catalog: Catalog;
  pin: Pin;
  onClose: () => void;
}) {
  const p = pin.plugin;
  const [title, subtitle] = splitName(p.name);
  const caps = p.capabilities.slice(0, CAP_LIMIT);
  const extra = p.capabilities.length - caps.length;
  const repo = p.repositoryUrl?.replace(/^https?:\/\//, "") ?? null;

  return (
    <article className="card" aria-labelledby="card-title">
      <header className="card__head">
        <p className="card__where">
          <span>{sectorCode(catalog, p.categoryId)}</span>
          {pin.region.label}
          <i>{pin.region.latin}</i>
        </p>
        <button type="button" className="card__close" onClick={onClose} aria-label="关闭">
          <Icon name="close" size={16} />
        </button>
      </header>

      <div className="card__body">
        <div className="card__ident">
          <Monogram plugin={p} size="md" />
          <div>
            <h2 id="card-title" className="card__title">
              {title}
            </h2>
            {subtitle !== null && <p className="card__subtitle">{subtitle}</p>}
          </div>
        </div>
        <p className="card__author">
          <a href={p.authorUrl} target="_blank" rel="noreferrer">
            {p.authorName}
          </a>
          <span>@{p.authorLogin}</span>
          {p.featured && <em>精选</em>}
        </p>

        {p.hasDetails ? (
          <p className="card__desc">{p.description || "作者没有写简介。"}</p>
        ) : (
          <p className="card__desc card__desc--missing">
            清单未同步。索引里有这个插件，但还没拿到它的
            manifest，版本、许可证和权限都为空，装前请到仓库确认。
          </p>
        )}

        <p className="card__elev">
          <span>▲</span>
          {p.version ?? "—"}
          <small>版本 · 标高</small>
        </p>

        <dl className="card__spec">
          <div>
            <dt>许可证</dt>
            <dd>{p.license ?? "未声明"}</dd>
          </div>
          <div>
            <dt>适用 MaiBot</dt>
            <dd>{hostRange(p)}</dd>
          </div>
          <div>
            <dt>SDK</dt>
            <dd>{sdkRange(p)}</dd>
          </div>
          <div>
            <dt>清单</dt>
            <dd>{p.manifestVersion === null ? "未同步" : `v${p.manifestVersion}`}</dd>
          </div>
          <div>
            <dt>测绘坐标</dt>
            <dd>
              N {String(Math.round(pin.y)).padStart(4, "0")} · E{" "}
              {String(Math.round(pin.x)).padStart(4, "0")}
            </dd>
          </div>
        </dl>

        <section className="card__caps" aria-labelledby="caps-title">
          <h3 id="caps-title">
            权限声明 <b>{p.capabilities.length}</b>
          </h3>
          {caps.length > 0 ? (
            <ul>
              {caps.map((c) => (
                <li key={c}>{c}</li>
              ))}
              {extra > 0 && <li className="card__more">+{extra}</li>}
            </ul>
          ) : (
            <p>未声明。旧版 manifest 没有这一项。</p>
          )}
        </section>
        <FeedbackPanel key={p.id} pluginId={p.id} />
      </div>

      <footer className="card__foot">
        <CopyRepoButton url={p.repositoryUrl} />
        {repo !== null && p.repositoryUrl !== null && (
          <a className="card__repo" href={p.repositoryUrl} target="_blank" rel="noreferrer">
            {repo}
            <Icon name="external" size={12} />
          </a>
        )}
        <p className="card__hint">复制地址，粘进麦麦 WebUI 的插件管理即可安装。</p>
      </footer>
    </article>
  );
}
