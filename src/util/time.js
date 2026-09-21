// 统一按北京时间（UTC+8，中国大陆自 1992 年起无夏令时）计算业务日期，
// 避免容器默认 UTC 导致"跨日窗口归账日期"偏差。
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

const pad2 = (n) => String(n).padStart(2, "0");

/** 把毫秒时间戳转换为北京时间各分量。 */
export function cstParts(ms) {
  const d = new Date(ms + CST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(), // 0=周日
  };
}

/** 当前北京时间日期串 YYYY-MM-DD。 */
export function todayCst(now = Date.now()) {
  const p = cstParts(now);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** 日期串对应星期几（0=周日），纯日期运算不受运行时区影响。 */
export function weekdayOfDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * 解析场次开始/结束时刻。
 * 跨零点场次（end <= start）的结束时间自动加一天。
 * 返回 { start, end } 毫秒时间戳。
 */
export function parseShiftRange(dateStr, startHHMM, endHHMM, crossMidnight = false) {
  const start = Date.parse(`${dateStr}T${startHHMM}:00+08:00`);
  if (Number.isNaN(start)) throw new Error(`非法时间：${dateStr} ${startHHMM}`);
  let end = Date.parse(`${dateStr}T${endHHMM}:00+08:00`);
  if (Number.isNaN(end)) throw new Error(`非法时间：${dateStr} ${endHHMM}`);
  if (crossMidnight || end <= start) end += 24 * 60 * 60 * 1000;
  return { start, end };
}

/** 在北京时间日期上加减天数。 */
export function shiftCstDate(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + deltaDays * 24 * 60 * 60 * 1000);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** HH:MM 形式的北京时间时刻。 */
export function formatHHMM(ms) {
  const p = cstParts(ms);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}
