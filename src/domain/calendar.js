// 有效政策日历：综合法定节假日表、调休上班日、普通周末判定某日期是否开放。
// 政策优先级：调休上班日 > 法定节假日 > 普通周末规则。
import { weekdayOfDate } from "../util/time.js";

export class HolidayCalendar {
  constructor(holidayData) {
    this.holidayMap = new Map();
    for (const h of holidayData.holidays || []) {
      this.holidayMap.set(h.date, h.name || "法定节假日");
    }
    this.makeupMap = new Map();
    for (const m of holidayData.makeupWorkdays || []) {
      this.makeupMap.set(m.date, m);
    }
    this.weekendOpen = Boolean(holidayData.weekendOpen);
  }

  /**
   * 判定指定日期的开放状态。
   * 返回 { open: boolean, reason: string, holidayName?: string }
   */
  resolve(dateStr) {
    if (this.makeupMap.has(dateStr)) {
      const m = this.makeupMap.get(dateStr);
      return { open: true, reason: `调休上班日（${m.name || ""}，按${m.workAs || "工作日"}上班）` };
    }
    if (this.holidayMap.has(dateStr)) {
      return { open: false, reason: `法定节假日：${this.holidayMap.get(dateStr)}`, holidayName: this.holidayMap.get(dateStr) };
    }
    const wd = weekdayOfDate(dateStr);
    if (wd === 0 || wd === 6) {
      return this.weekendOpen
        ? { open: true, reason: "周末开放日" }
        : { open: false, reason: "普通周末停办" };
    }
    return { open: true, reason: "工作日" };
  }

  isOpen(dateStr) {
    return this.resolve(dateStr).open;
  }
}
