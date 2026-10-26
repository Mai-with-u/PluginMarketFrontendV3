import type { CategoryId } from "../data/types.ts";

const PATHS = {
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM15.2 15.2 20 20M10.5 8v5M8 10.5h5",
  copy: "M8 8h11v12H8zM5 16V4h11",
  check: "M4 12.5 9.5 18 20 6",
  arrowRight: "M4 12h15M13 6l6 6-6 6",
  arrowDown: "M12 4v15M6 13l6 6 6-6",
  external: "M8 6h10v10M18 6 6 18",
  close: "M5 5l14 14M19 5 5 19",
  prev: "M15 5l-7 7 7 7",
  next: "M9 5l7 7-7 7",
  warn: "M12 3 22 20H2zM12 10v4M12 16.5v1",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="square"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

const GLYPHS: Record<CategoryId, string> = {
  entertainment: "M12 3 21 12 12 21 3 12ZM12 8.5v.01M8.5 12h.01M15.5 12h.01M12 15.5v.01",
  moderation: "M12 3 20 6v6c0 4.5-3.4 7.7-8 9-4.6-1.3-8-4.5-8-9V6ZM8 12h8",
  utility: "M4 4h6v6H4zM14 14h6v6h-6zM14 4h6v6h-6zM4 17h6",
  integration: "M3 9h7v6H3zM14 9h7v6h-7zM10 12h4M6.5 5v4M17.5 15v4",
  generation:
    "M12 3c.6 4.4 2.6 6.4 7 7-4.4.6-6.4 2.6-7 7-.6-4.4-2.6-6.4-7-7 4.4-.6 6.4-2.6 7-7ZM19 17v4M17 19h4",
  search: "M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12ZM14.5 14.5 20 20M10 2v3M10 15v3M2 10h3M15 10h3",
  media: "M4 10v4M8 6v12M12 9v6M16 4v16M20 8v8",
  automation: "M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4M12 8v4l3 2",
  other: "M4 4h16v16H4zM8 12h.01M12 12h.01M16 12h.01",
};

export function CategoryGlyph({ id, size = 22 }: { id: CategoryId; size?: number }) {
  return (
    <svg
      className="glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
    >
      <path d={GLYPHS[id]} />
    </svg>
  );
}

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 2 30 16 16 30 2 16Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M16 8 24 16 16 24 8 16Z" fill="var(--signal)" />
      <path d="M16 8v16" stroke="var(--bg)" strokeWidth="1.5" />
      <path d="M2 16h4M26 16h4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
