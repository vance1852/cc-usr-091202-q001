import { isValidDate, addDays } from "../util/time.js";

/**
 * 有效政策日历：
 * - holidays：放假日，整日不开放
 * - makeupWorkdays：调休上班日（即使落在周末也开放）
 * - 默认周一至周五开放
 * 以正式发布的国务院办公厅放假安排为准，数据文件可逐年替换。
 */
export class Calendar {
  constructor({ holidays = [], makeupWorkdays = [], defaultWorkdays = [1, 2, 3, 4, 5] } = {}) {
    this.makeup = new Set(makeupWorkdays.filter(isValidDate));
    this.holiday = new Map();
    this.defaultWorkdays = new Set(defaultWorkdays);
    for (const h of holidays) this.#addRange(h);
  }

  #addRange({ name, from, to }) {
    let cur = from;
    while (cur <= to) {
      this.holiday.set(cur, name);
      cur = addDays(cur, 1);
    }
  }

  inspect(date) {
    if (!isValidDate(date)) return { open: false, reason: "日期无效" };
    if (this.makeup.has(date)) {
      return { open: true, reason: "调休上班日，正常开放" };
    }
    const holidayName = this.holiday.get(date);
    if (holidayName) return { open: false, reason: `法定节假日：${holidayName}` };
    const weekday = new Date(`${date}T00:00:00`).getDay();
    if (!this.defaultWorkdays.has(weekday)) {
      return { open: false, reason: "非工作日（周末）" };
    }
    return { open: true, reason: "工作日" };
  }

  isOpen(date) {
    return this.inspect(date).open;
  }
}
