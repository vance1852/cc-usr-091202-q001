import { slotKey } from "./catalog.js";

/**
 * 纯函数式投影：把事件日志重放成当前状态。
 * 进程重启时从零开始 apply 全部事件，因此排队顺序、取消状态、剩余容量
 * 全部由日志决定，不存在另一份需要同步的数据库。
 */
export class Projection {
  constructor(catalog) {
    this.catalog = catalog;
    this.slots = new Map(); // key -> slotState
    this.tickets = new Map(); // ticketId -> ticket
    this.idempotency = new Map(); // key -> { kind, ticketId, seq }
  }

  #slot(date, windowId, slotId) {
    const key = slotKey(date, windowId, slotId);
    let s = this.slots.get(key);
    if (!s) {
      const win = this.catalog.windows.get(windowId);
      const base = win?.slots.get(slotId)?.baseCapacity ?? 0;
      s = {
        key,
        date,
        windowId,
        slotId,
        baseCapacity: base,
        capacity: base,
        queued: new Set(),
        displaced: new Set(),
        served: new Set(),
        noShow: new Set(),
        cancelled: new Set(),
        nextSeq: 1,
        nextNumber: 1,
      };
      this.slots.set(key, s);
    }
    return s;
  }

  #dupKey(t) {
    return `${t.applicantRef}|${t.serviceCode}|${t.date}`;
  }

  #indexPut(t) {
    if (!this.dupIndex) this.dupIndex = new Map();
    this.dupIndex.set(this.#dupKey(t), t.ticketId);
  }

  #indexDelete(t) {
    this.dupIndex?.delete(this.#dupKey(t));
  }

  apply(event) {
    const { type, payload: p } = event;
    switch (type) {
      case "TicketIssued": {
        const slot = this.#slot(p.date, p.windowId, p.slotId);
        const number = p.number ?? `${p.windowId}-${p.slotId}-${String(slot.nextNumber).padStart(3, "0")}`;
        slot.nextNumber += 1;
        const queueSeq = slot.nextSeq++;
        const ticket = {
          ticketId: p.ticketId,
          number,
          date: p.date,
          windowId: p.windowId,
          slotId: p.slotId,
          serviceCode: p.serviceCode,
          applicantRef: p.applicantRef,
          priority: p.priority ?? {},
          materials: p.materials ?? [],
          source: p.source ?? "walk-in",
          status: "queued",
          queueSeq,
          issuedAt: event.at,
          events: [
            { seq: event.seq, type, at: event.at, date: p.date, windowId: p.windowId, slotId: p.slotId },
          ],
        };
        slot.queued.add(ticket.ticketId);
        this.tickets.set(ticket.ticketId, ticket);
        this.#indexPut(ticket);
        if (p.idempotencyKey) {
          this.idempotency.set(p.idempotencyKey, { kind: "book", ticketId: ticket.ticketId, seq: event.seq });
        }
        return;
      }
      case "TicketRescheduled": {
        const ticket = this.tickets.get(p.ticketId);
        if (!ticket) return;
        const old = this.#slot(ticket.date, ticket.windowId, ticket.slotId);
        this.#indexDelete(ticket);
        if (ticket.status === "queued") old.queued.delete(ticket.ticketId);
        if (ticket.status === "displaced") old.displaced.delete(ticket.ticketId);
        const target = this.#slot(p.to.date, p.to.windowId, p.to.slotId);
        ticket.date = p.to.date;
        ticket.windowId = p.to.windowId;
        ticket.slotId = p.to.slotId;
        ticket.status = "queued";
        ticket.queueSeq = target.nextSeq++;
        target.queued.add(ticket.ticketId);
        ticket.events.push({
          seq: event.seq,
          type,
          at: event.at,
          from: p.from,
          to: p.to,
          reason: p.reason,
        });
        this.#indexPut(ticket);
        if (p.idempotencyKey) {
          this.idempotency.set(p.idempotencyKey, { kind: "reschedule", ticketId: ticket.ticketId, seq: event.seq });
        }
        return;
      }
      case "TicketDisplaced": {
        const ticket = this.tickets.get(p.ticketId);
        if (!ticket || ticket.status !== "queued") return;
        const slot = this.#slot(ticket.date, ticket.windowId, ticket.slotId);
        slot.queued.delete(ticket.ticketId);
        slot.displaced.add(ticket.ticketId);
        ticket.status = "displaced";
        // 仍占用当日该事项的"预约关系"（dupIndex 保留），引导走改签而非重复取号
        ticket.events.push({ seq: event.seq, type, at: event.at, reason: p.reason });
        return;
      }
      case "TicketCancelled": {
        const ticket = this.tickets.get(p.ticketId);
        if (!ticket || ticket.status === "cancelled") return;
        const slot = this.#slot(ticket.date, ticket.windowId, ticket.slotId);
        slot.queued.delete(ticket.ticketId);
        slot.displaced.delete(ticket.ticketId);
        slot.cancelled.add(ticket.ticketId);
        ticket.status = "cancelled";
        ticket.cancelReason = p.reason;
        ticket.events.push({ seq: event.seq, type, at: event.at, reason: p.reason });
        this.#indexDelete(ticket);
        if (p.idempotencyKey) {
          this.idempotency.set(p.idempotencyKey, { kind: "cancel", ticketId: ticket.ticketId, seq: event.seq });
        }
        return;
      }
      case "TicketNoShowMarked": {
        const ticket = this.tickets.get(p.ticketId);
        if (!ticket || ticket.status !== "queued") return;
        const slot = this.#slot(ticket.date, ticket.windowId, ticket.slotId);
        slot.queued.delete(ticket.ticketId);
        slot.noShow.add(ticket.ticketId);
        ticket.status = "no-show";
        ticket.events.push({ seq: event.seq, type, at: event.at });
        this.#indexDelete(ticket);
        return;
      }
      case "TicketServed": {
        const ticket = this.tickets.get(p.ticketId);
        if (!ticket || ticket.status !== "queued") return;
        const slot = this.#slot(ticket.date, ticket.windowId, ticket.slotId);
        slot.queued.delete(ticket.ticketId);
        slot.served.add(ticket.ticketId);
        ticket.status = "served";
        ticket.events.push({ seq: event.seq, type, at: event.at });
        this.#indexDelete(ticket);
        return;
      }
      case "CapacityChanged": {
        const slot = this.#slot(p.date, p.windowId, p.slotId);
        slot.capacity = p.to;
        slot.adjusted = true;
        return;
      }
      default:
        return;
    }
  }

  findDuplicate(applicantRef, serviceCode, date) {
    const id = this.dupIndex?.get(`${applicantRef}|${serviceCode}|${date}`);
    return id ? this.tickets.get(id) : null;
  }

  /** 按入队顺序列出某时段在排队列（优先标记不改变排队次序，仅作窗口叫号提示） */
  queueOf(date, windowId, slotId) {
    const slot = this.slots.get(slotKey(date, windowId, slotId));
    if (!slot) return [];
    return [...slot.queued].map((id) => this.tickets.get(id)).sort((a, b) => a.queueSeq - b.queueSeq);
  }

  displacedOf(date, windowId, slotId) {
    const slot = this.slots.get(slotKey(date, windowId, slotId));
    if (!slot) return [];
    return [...slot.displaced].map((id) => this.tickets.get(id));
  }

  slotState(date, windowId, slotId) {
    return this.slots.get(slotKey(date, windowId, slotId)) ?? null;
  }
}

/** 当前有效容量：无调整事件时回落到班次基准容量 */
export function slotSummary(slot, catalog) {
  const win = catalog.getWindow(slot.windowId);
  const cfg = win.slots.get(slot.slotId);
  return {
    date: slot.date,
    windowId: slot.windowId,
    windowName: win.name,
    slotId: slot.slotId,
    slotLabel: cfg.label,
    start: cfg.start,
    end: cfg.end,
    crossDay: cfg.crossDay,
    baseCapacity: slot.baseCapacity,
    capacity: slot.capacity,
    used: slot.queued.size,
    remaining: slot.capacity - slot.queued.size,
    displaced: slot.displaced.size,
    served: slot.served.size,
    noShow: slot.noShow.size,
    cancelled: slot.cancelled.size,
    adjusted: slot.adjusted === true,
  };
}
