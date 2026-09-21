// 事项目录与窗口班次装载：静态 JSON 是"计划态"，运行期的停办/缩容以事件为准。
import { parseShiftRange } from "../util/time.js";

export class Catalog {
  constructor(catalogData, shiftsData) {
    this.items = new Map();
    for (const item of catalogData.items || []) {
      if (this.items.has(item.code)) throw new Error(`事项目录存在重复编码：${item.code}`);
      this.items.set(item.code, { ...item });
    }
    this.shifts = new Map();
    for (const s of shiftsData.shifts || []) {
      const id = shiftIdOf(s);
      if (this.shifts.has(id)) throw new Error(`班次重复：${id}`);
      const { start, end } = parseShiftRange(s.date, s.start, s.end, s.crossMidnight);
      this.shifts.set(id, {
        id,
        code: s.code,
        window: s.window,
        windowType: s.windowType,
        date: s.date,
        start,
        end,
        startLabel: s.start,
        endLabel: s.end,
        crossMidnight: Boolean(s.crossMidnight),
        services: [...(s.services || [])],
        baseCapacity: s.capacity,
        accessible: Boolean(s.accessible),
        note: s.note || "",
      });
    }
  }

  getItem(code) {
    return this.items.get(code);
  }

  getShift(id) {
    return this.shifts.get(id);
  }

  /** 某事项在某天可预约的班次（不考虑节假日与运行期停办，仅做目录匹配）。 */
  shiftsForItem(itemCode, dateStr) {
    return [...this.shifts.values()].filter(
      (s) => s.date === dateStr && s.services.includes(itemCode)
    );
  }

  listShifts(dateStr) {
    const all = [...this.shifts.values()];
    return dateStr ? all.filter((s) => s.date === dateStr) : all;
  }
}

/** 班次稳定标识：开始日期 + 窗口名 + 班次码（跨日夜班归入开始日期）。 */
export function shiftIdOf(s) {
  return `${s.date}#${s.window}#${s.code}`;
}
