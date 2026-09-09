'use strict';
/**
 * All scheduling logic in this app is expressed in America/Chicago (Central).
 * We never store local times - everything on disk is an ISO-8601 UTC string.
 * These helpers convert to/from Central for display and for "is this a Sunday
 * game?" style questions.
 */

const TZ = 'America/Chicago';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'long',
  hour12: false,
});

/** Break a Date (or ISO string) into Central-time calendar parts. */
function ctParts(input) {
  const d = input instanceof Date ? input : new Date(input);
  const out = {};
  for (const p of partsFmt.formatToParts(d)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  let hour = parseInt(out.hour, 10);
  if (hour === 24) hour = 0; // en-US hour12:false can emit "24" at midnight
  return {
    year: parseInt(out.year, 10),
    month: parseInt(out.month, 10),
    day: parseInt(out.day, 10),
    hour,
    minute: parseInt(out.minute, 10),
    second: parseInt(out.second, 10),
    weekday: out.weekday,
    weekdayIndex: WEEKDAYS.indexOf(out.weekday),
    date: `${out.year}-${out.month}-${out.day}`,
  };
}

/** "2026-09-13" for the Central-time calendar date of an instant. */
function ctDate(input) {
  return ctParts(input).date;
}

/** Weekday name in Central time, e.g. "Sunday". */
function ctWeekday(input) {
  return ctParts(input).weekday;
}

/** Central-time UTC offset in minutes for a given instant (e.g. -300 for CDT). */
function ctOffsetMinutes(input) {
  const d = input instanceof Date ? input : new Date(input);
  const p = ctParts(d);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUTC - d.getTime()) / 60000);
}

/**
 * Build a UTC Date from a Central-time wall clock.
 * ctToUtc('2026-09-11', 10, 0) -> Date for Fri Sep 11 2026 10:00 CT
 */
function ctToUtc(dateStr, hour = 0, minute = 0) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // First guess using the offset that applies around that date, then correct once.
  let guess = new Date(Date.UTC(y, m - 1, d, hour, minute, 0));
  let off = ctOffsetMinutes(guess);
  let fixed = new Date(Date.UTC(y, m - 1, d, hour, minute, 0) - off * 60000);
  const off2 = ctOffsetMinutes(fixed);
  if (off2 !== off) fixed = new Date(Date.UTC(y, m - 1, d, hour, minute, 0) - off2 * 60000);
  return fixed;
}

/** Add whole days to a "YYYY-MM-DD" string. */
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/**
 * The next Sunday on/after a Central date. If `from` is already a Sunday it is
 * returned unchanged (useful for "which Sunday does this week cover?").
 */
function nextSunday(fromDateStr) {
  const [y, m, d] = fromDateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(fromDateStr, (7 - dow) % 7);
}

/** "Sun 12:00 PM CT" */
function formatKickoff(input) {
  const p = ctParts(input);
  return `${p.weekday.slice(0, 3)} ${formatClock(p)} CT`;
}

/** "12:00 PM" */
function formatClock(p) {
  const h24 = p.hour;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  let h = h24 % 12;
  if (h === 0) h = 12;
  return `${h}:${String(p.minute).padStart(2, '0')} ${ampm}`;
}

/** "Friday, Sep 11 at 10:04 AM CT" - used for the "lines locked" stamp. */
function formatStamp(input) {
  const p = ctParts(input);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${p.weekday}, ${months[p.month - 1]} ${p.day} at ${formatClock(p)} CT`;
}

module.exports = {
  TZ,
  ctParts,
  ctDate,
  ctWeekday,
  ctOffsetMinutes,
  ctToUtc,
  addDays,
  nextSunday,
  formatKickoff,
  formatStamp,
};
