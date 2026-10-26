export const formatCount = (value: number) => value.toLocaleString();

export const percent = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";

/**
 * Numbers are API timestamps in seconds. Today shows the time, this year the month
 * and day, and anything older the full date.
 */
export function shortDate(value: number | string) {
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  const now = new Date();
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString(
    undefined,
    date.getFullYear() === now.getFullYear()
      ? { month: "2-digit", day: "2-digit" }
      : { year: "numeric", month: "2-digit", day: "2-digit" },
  );
}
