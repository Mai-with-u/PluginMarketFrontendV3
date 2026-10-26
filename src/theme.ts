export type ThemePreference = "system" | "light" | "dark";

const media = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();
let preference: ThemePreference = "system";
let resolved: "light" | "dark" = "light";

function parse(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

function apply() {
  resolved = preference === "system" ? (media.matches ? "dark" : "light") : preference;
  document.documentElement.dataset["theme"] = resolved;
  document.documentElement.dataset["themePreference"] = preference;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolved === "light" ? "#f5f2eb" : "#0c0b0a");
  listeners.forEach((listener) => listener());
}

// The head script applies the saved theme before the first paint.
preference = parse(document.documentElement.dataset["themePreference"]);
apply();
media.addEventListener("change", apply);
window.addEventListener("storage", (event) => {
  if (event.key === "plugin-market-theme" || event.key === null) {
    preference = parse(event.newValue);
    apply();
  }
});

export const getThemePreference = () => preference;
export const getResolvedTheme = () => resolved;
export function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function setThemePreference(value: ThemePreference) {
  preference = value;
  apply();
  try {
    localStorage.setItem("plugin-market-theme", value);
  } catch {
    // Storage can be disabled by the browser; switching still works for this visit.
  }
}
