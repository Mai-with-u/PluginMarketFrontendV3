import { useSyncExternalStore } from "react";

import { getResolvedTheme, setThemePreference, subscribeTheme } from "../theme.ts";

export function ThemeSwitch() {
  const theme = useSyncExternalStore(subscribeTheme, getResolvedTheme);
  const label = theme === "dark" ? "切换到白天模式" : "切换到夜间模式";
  return (
    <button
      type="button"
      className="theme-switch"
      aria-label={label}
      title={label}
      onClick={() => setThemePreference(theme === "dark" ? "light" : "dark")}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        {theme === "dark" ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2" />
          </>
        ) : (
          <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z" />
        )}
      </svg>
    </button>
  );
}
