import { DomainError } from "./errors.js";
import { isValidDate, isValidTime, anchorEndDate } from "../util/time.js";

/**
 * 只读事项目录与窗口班次。
 * 容量基准来自班次配置；运行期容量只能通过事件（缩容/恢复）调整，
 * 因此改文件不会改写已经发生的历史。
 */
export class Catalog {
  constructor({ services, windows }) {
    this.services = new Map();
    for (const s of services) this.#addService(s);
    this.windows = new Map();
    for (const w of windows) this.#addWindow(w);
  }

  #addService(s) {
    if (!s?.code || !s?.name) throw new Error(`事项目录条目缺少 code/name`);
    this.services.set(s.code, {
      code: s.code,
      name: s.name,
      windowType: s.windowType ?? "general",
      windowMinutes: Number(s.windowMinutes) || 0,
      requiredMaterials: Array.isArray(s.requiredMaterials) ? [...s.requiredMaterials] : [],
    });
  }

  #addWindow(w) {
    if (!w?.id || !Array.isArray(w.services) || !Array.isArray(w.slots)) {
      throw new Error(`窗口 ${w?.id ?? "?"} 配置不完整`);
    }
    for (const code of w.services) {
      if (!this.services.has(code)) throw new Error(`窗口 ${w.id} 引用了未登记事项 ${code}`);
    }
    const slots = new Map();
    for (const slot of w.slots) {
      if (!slot?.id || !isValidTime(slot.start) || !isValidTime(slot.end)) {
        throw new Error(`窗口 ${w.id} 存在非法时段配置`);
      }
      slots.set(slot.id, {
        id: slot.id,
        label: slot.label ?? `${slot.start}-${slot.end}`,
        start: slot.start,
        end: slot.end,
        crossDay: slot.crossDay === true || slot.end <= slot.start,
        baseCapacity: Number.isInteger(slot.capacity) ? slot.capacity : 0,
        note: slot.note,
      });
    }
    this.windows.set(w.id, {
      id: w.id,
      name: w.name ?? w.id,
      type: w.type ?? "general",
      services: new Set(w.services),
      slots,
    });
  }

  getService(code) {
    const s = this.services.get(code);
    if (!s) throw new DomainError("SERVICE_UNKNOWN", `事项 ${code} 未在目录中登记`, { status: 404 });
    return s;
  }

  getWindow(id) {
    const w = this.windows.get(id);
    if (!w) throw new DomainError("WINDOW_UNKNOWN", `窗口 ${id} 不存在`, { status: 404 });
    return w;
  }

  /** 找到在 date 当天、slotId 时段可受理 serviceCode 的窗口 */
  resolveSlot({ windowId, slotId, serviceCode, date }) {
    if (!isValidDate(date)) throw new DomainError("INVALID_DATE", "日期格式应为 YYYY-MM-DD");
    const service = this.getService(serviceCode);
    let windowIds;
    if (windowId) {
      windowIds = [windowId];
    } else {
      windowIds = [...this.windows.values()]
        .filter((w) => w.services.has(serviceCode))
        .map((w) => w.id);
      if (windowIds.length === 0) {
        throw new DomainError("NO_WINDOW_FOR_SERVICE", `事项 ${serviceCode} 暂无可受理窗口`, { status: 404 });
      }
    }
    const matches = [];
    for (const wid of windowIds) {
      const w = this.getWindow(wid);
      if (!w.services.has(serviceCode)) {
        if (windowId) throw new DomainError("SERVICE_NOT_AT_WINDOW", `窗口 ${w.name} 不受理事项 ${service.name}`);
        continue;
      }
      for (const sid of slotId ? [slotId] : w.slots.keys()) {
        const slot = w.slots.get(sid);
        if (!slot) {
          if (windowId && slotId) {
            throw new DomainError("SLOT_UNKNOWN", `窗口 ${w.name} 无 ${slotId} 时段`, { status: 404 });
          }
          continue;
        }
        matches.push({ window: w, slot, service, date, endDate: anchorEndDate(date, slot) });
      }
    }
    if (matches.length === 0) throw new DomainError("NO_SLOT", "没有匹配的可办理时段", { status: 404 });
    return windowId ? matches[0] : matches;
  }

  listCatalog() {
    return {
      services: [...this.services.values()].map((s) => ({ ...s })),
      windows: [...this.windows.values()].map((w) => ({
        id: w.id,
        name: w.name,
        type: w.type,
        services: [...w.services],
        slots: [...w.slots.values()].map((s) => ({ ...s })),
      })),
    };
  }
}

export function slotKey(date, windowId, slotId) {
  return `${date}|${windowId}|${slotId}`;
}
