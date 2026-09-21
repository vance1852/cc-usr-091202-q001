// 只读查询：导办员当天视图——每个窗口的真实余量、在队队列、处置单。
// 不返回任何完整身份信息，仅脱敏称呼与优先标记。
import { TicketStatus } from "./state.js";
import { todayCst } from "../util/time.js";

export class QueryService {
  constructor({ catalog, calendar, state, clock = () => Date.now() }) {
    this.catalog = catalog;
    this.calendar = calendar;
    this.state = state;
    this.clock = clock;
  }

  /** 单个班次的实时余量视图。 */
  shiftView(shiftId) {
    const shift = this.catalog.getShift(shiftId);
    if (!shift) return null;
    const day = this.calendar.resolve(shift.date);
    const rt = this.state.runtime.get(shift.id);
    const suspended = Boolean(rt?.suspended);
    const capacity = this.state.capacityOf(shift.id, shift.baseCapacity);
    const queueIds = this.state.queues.get(shift.id) || [];
    const queue = queueIds.map((id, idx) => {
      const t = this.state.tickets.get(id);
      return {
        position: idx + 1,
        ticketId: t.ticketId,
        ticketNo: t.ticketNo,
        itemCode: t.itemCode,
        maskedName: t.identity.maskedName,
        idTail: t.identity.idTail,
        priorities: t.priorities,
        missingMaterials: t.materials
          ? this.catalog.getItem(t.itemCode)?.requiredMaterials.filter((m) => !t.materials.includes(m))
          : [],
      };
    });
    const used = queue.length;
    return {
      shiftId: shift.id,
      window: shift.window,
      shiftCode: shift.code,
      date: shift.date,
      timeRange: shift.crossMidnight ? `${shift.startLabel}–次日${shift.endLabel}` : `${shift.startLabel}–${shift.endLabel}`,
      crossMidnight: shift.crossMidnight,
      accessible: shift.accessible,
      services: shift.services,
      calendarStatus: day,
      suspended,
      suspendReason: rt?.suspendReason || null,
      baseCapacity: shift.baseCapacity,
      capacity,
      used,
      remaining: day.open && !suspended ? Math.max(0, capacity - used) : 0,
      bookable: day.open && !suspended && used < capacity,
      queue,
    };
  }

  /** 当天（或指定日期）全部窗口视图，按开始时刻排序。 */
  dailyBoard(dateStr = todayCst(this.clock())) {
    return this.catalog
      .listShifts(dateStr)
      .map((s) => this.shiftView(s.id))
      .sort((a, b) => a.shiftId.localeCompare(b.shiftId));
  }

  /** 待处置的挤出号（改签/退号未完成）。 */
  pendingDisplacements() {
    const result = [];
    for (const d of this.state.displacements.values()) {
      const pending = d.ticketIds.filter((id) => this.state.tickets.get(id)?.status === TicketStatus.DISPLACED);
      if (pending.length === 0) continue;
      const shift = this.catalog.getShift(d.shiftId);
      result.push({
        displacementId: d.displacementId,
        shiftId: d.shiftId,
        window: shift?.window,
        date: shift?.date,
        reason: d.reason,
        createdAt: d.createdAt,
        tickets: pending.map((id) => {
          const t = this.state.tickets.get(id);
          return { ticketId: id, maskedName: t.identity.maskedName, itemCode: t.itemCode, priorities: t.priorities };
        }),
      });
    }
    return result;
  }

  getTicket(ticketId) {
    return this.state.tickets.get(ticketId) || null;
  }
}
