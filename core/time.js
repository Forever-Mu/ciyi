/**
 * time.js —— 本地日期处理
 *
 * 所有"今天"的判断都走这里，保证跨午夜、时区一致。
 * 日期一律用本地时区的 YYYY-MM-DD 字符串，便于 SQL 比较与索引。
 */

export function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** Date -> 'YYYY-MM-DD'（本地时区，不用 toISOString 以免 UTC 偏移） */
export function toDateStr(d = new Date()) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 当前本地日期 */
export function today() {
  return toDateStr(new Date());
}

/** 'YYYY-MM-DD' -> 本地 0 点 Date */
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return d;
}

export function isValidDate(s) {
  return parseDate(s) !== null;
}

/** 日期加减天数 */
export function addDays(dateStr, n) {
  const d = parseDate(dateStr) || new Date();
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

/** 两个日期相差的天数（b - a） */
export function diffDays(a, b) {
  const da = parseDate(a), db = parseDate(b);
  if (!da || !db) return 0;
  return Math.round((db - da) / 86400000);
}

/** 当前时间 ISO 字符串（用于 created_at 等审计字段） */
export function nowIso() {
  return new Date().toISOString();
}
