// Dates are stored and passed around as ISO calendar dates: "YYYY-MM-DD".

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** True for a real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isIsoDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

/** "2026-11-04" -> "4 Nov 2026" */
export function formatIsoDate(text) {
  return new Date(`${text}T00:00:00`).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
}
