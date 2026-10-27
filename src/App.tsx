import { Component, lazy, Suspense } from "react";
import type { ErrorInfo, ReactNode } from "react";

import { Icon, LogoMark } from "./components/Icon.tsx";

const DeveloperPage = lazy(() => import("./developer/DeveloperPage.tsx"));
const CardMarket = lazy(() => import("./market/CardMarket.tsx"));

function Boot() {
  return (
    <output className="boot">
      <LogoMark size={40} />
      <span className="boot__title">正在读取社区索引</span>
      <span className="boot__bar" aria-hidden="true" />
      <span className="boot__code" aria-hidden="true">
        MPD·V3 / SYNC INDEX
      </span>
    </output>
  );
}

class CatalogBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[catalog]", error, info.componentStack);
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="boot boot--error" role="alert">
        <Icon name="warn" size={36} />
        <p className="boot__title">索引没读出来</p>
        <p className="boot__body">{this.state.error.message}。请检查网络后重试。</p>
        <button
          type="button"
          className="btn btn--signal"
          onClick={() => {
            window.location.reload();
            this.setState({ error: null });
          }}
        >
          重新读取
        </button>
      </div>
    );
  }
}

export function App() {
  if (window.location.pathname === "/developer" || window.location.pathname === "/developer/") {
    return (
      <Suspense fallback={<Boot />}>
        <DeveloperPage />
      </Suspense>
    );
  }
  return (
    <>
      <CatalogBoundary>
        <Suspense fallback={<Boot />}>
          <CardMarket />
        </Suspense>
      </CatalogBoundary>
    </>
  );
}
