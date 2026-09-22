const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

/** 校验公历日期字符串 YYYY-MM-DD（拒绝 2026-02-30 之类） */
export function isValidDate(s) {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(`${s}T00:00:00`);
  return !Number.isNaN(d.getTime()) && localDateOf(d) === s;
}

export function isValidTime(s) {
  if (typeof s !== "string") return false;
  const m = TIME_RE.exec(s);
  if (!m) return false;
  const [, h, min] = m.map(Number);
  return h <= 23 && min <= 59;
}

/** 跨日时段的结束日期：crossDay 时为开班日的次日 */
export function anchorEndDate(date, slot) {
  if (!slot.crossDay) return date;
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return localDateOf(d);
}

/** 构造本地时区的 Date（与服务器本地时区一致） */
export function atLocal(date, hhmm) {
  return new Date(`${date}T${hhmm}:00`);
}

/** 某一时段相对 now 的毫秒差：正数表示尚未结束 */
export function msUntilSlotEnd(date, slot, now = new Date()) {
  return atLocal(anchorEndDate(date, slot), slot.end).getTime() - now.getTime();
}

export function localDateOf(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return localDateOf(d);
}
