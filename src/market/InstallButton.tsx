import { useRef, useState } from "react";

const KEY = "maibot-webui-address";
export function validateAddress(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("请输入不含账号、密码或查询参数的 HTTP / HTTPS WebUI 地址。");
  if (url.pathname !== "/" && url.pathname !== "/plugins")
    throw new Error("请填写 WebUI 首页地址，例如 http://127.0.0.1:8001。");
  return url.origin;
}
export function installUrl(address: string, pluginId: string, version?: string): string {
  const url = new URL("/plugins", validateAddress(address));
  url.searchParams.set("pluginId", pluginId);
  url.searchParams.set("installPluginId", pluginId);
  if (version) url.searchParams.set("installVersion", version);
  return url.href;
}
export function InstallButton({
  pluginId,
  version,
  settings = false,
  label = "在 MaiBot 中安装",
  detailOnly = false,
}: {
  pluginId: string;
  version?: string;
  settings?: boolean;
  label?: string;
  detailOnly?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [address, setAddress] = useState(() => {
    const supplied = new URLSearchParams(location.hash.slice(1)).get("maibot");
    return supplied ?? localStorage.getItem(KEY) ?? "http://127.0.0.1:8001";
  });
  const [error, setError] = useState("");
  const open = (value: string) => {
    const target = new URL(installUrl(value, pluginId, version));
    if (detailOnly) {
      target.searchParams.delete("installPluginId");
      target.searchParams.delete("installVersion");
    }
    window.open(target.href, "_blank", "noopener,noreferrer");
  };
  return (
    <>
      <button
        type="button"
        className={settings ? "market-secondary" : "market-primary"}
        onClick={() => {
          const saved = localStorage.getItem(KEY);
          const incoming = new URLSearchParams(location.hash.slice(1)).get("maibot");
          if (!settings && saved && (!incoming || incoming === saved)) {
            open(saved);
            return;
          }
          dialog.current?.showModal();
        }}
      >
        {settings ? "MaiBot 地址" : label}
      </button>
      <dialog className="market-connect" ref={dialog} aria-label="连接 MaiBot">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            try {
              const normalized = validateAddress(address);
              localStorage.setItem(KEY, normalized);
              history.replaceState(history.state, "", location.pathname + location.search);
              setAddress(normalized);
              setError("");
              dialog.current?.close();
              if (!settings) open(normalized);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "地址无效");
            }
          }}
        >
          <h2>打开你的 MaiBot</h2>
          <p>填写已运行的 MaiBot WebUI 地址。地址仅保存在此浏览器，安装会在 MaiBot 内确认。</p>
          <label>
            WebUI 地址
            <input
              type="url"
              required
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="market-error">
              {error}
            </p>
          )}
          <div className="market-actions">
            <button className="market-primary" type="submit">
              {settings ? "保存地址" : "保存并打开"}
            </button>
            <button
              className="market-secondary"
              type="button"
              onClick={() => dialog.current?.close()}
            >
              取消
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
