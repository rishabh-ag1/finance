/** F136 / D33: the 13 weeks of the cash forecast, Monday to Sunday, starting this week. */

const DAY = 86_400_000;
const at = (d: string) => Date.parse(`${d}T00:00:00Z`);
const text = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function monday(d: string) {
  const ms = at(d);
  const dow = new Date(ms).getUTCDay(); // 0 Sunday
  return ms - ((dow + 6) % 7) * DAY;
}

export function forecastWeeks(today: string, weeks = 13) {
  const start = monday(today);
  return Array.from({ length: weeks }, (_, i) => ({ from: text(start + i * 7 * DAY), to: text(start + i * 7 * DAY + 6 * DAY) }));
}

/** Which week a dated item falls in: 0 for this week (or already due), null beyond the last week. */
export function weekIndex(date: string, today: string, weeks = 13): number | null {
  const i = Math.floor((at(date) - monday(today)) / (7 * DAY));
  if (i < 0) return 0;
  return i < weeks ? i : null;
}
