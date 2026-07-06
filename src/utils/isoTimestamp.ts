/**
 * @description Pure formatter for the `/timestamps` prompt injection: an
 * ISO-8601 wall-clock timestamp carrying the host's LOCAL UTC offset
 * (`2026-06-27T19:42:10+04:00`), never the `Z` suffix `toISOString()` emits.
 * The agent-facing use case is absolute-time context for long multi-day
 * sessions ("yesterday", "2-3 days ago"), so the operator's local clock — not
 * UTC — is the meaningful frame of reference.
 */

const minutesPerHour = 60;

/** Zero-pad a calendar/clock component to two digits. */
function padTwo(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * @description Format an epoch-ms instant as local-offset ISO-8601, second
 * precision: `YYYY-MM-DDTHH:mm:ss±HH:MM`. Uses the host timezone in effect for
 * that instant (DST-correct — the offset comes from the Date itself), so
 * parsing the result back yields the same instant.
 */
export function formatIsoLocalOffset(epochMs: number): string {
  const date = new Date(epochMs);
  const offsetTotalMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetTotalMinutes >= 0 ? '+' : '-';
  const offsetAbsMinutes = Math.abs(offsetTotalMinutes);
  const offsetHours = Math.floor(offsetAbsMinutes / minutesPerHour);
  const offsetMinutes = offsetAbsMinutes % minutesPerHour;

  const datePart = `${date.getFullYear()}-${padTwo(date.getMonth() + 1)}-${padTwo(date.getDate())}`;
  const timePart = `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}:${padTwo(date.getSeconds())}`;
  return `${datePart}T${timePart}${offsetSign}${padTwo(offsetHours)}:${padTwo(offsetMinutes)}`;
}
