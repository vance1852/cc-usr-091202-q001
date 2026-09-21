// 状态投影：把事件流折叠成当前状态。纯函数、无副作用，
// 重启时重放全部事件即可恢复队列顺序、取消状态与剩余容量。
import { shiftIdOf } from "./catalog.js";

export const TicketStatus = Object.freeze({
  ISSUED: "ISSUED", // 在队列中，占号
  SERVED: "SERVED", // 已办结
  CANCELLED: "CANCELLED", // 已退号
  NOSHOW: "NOSHOW", // 爽约
  RESCHEDULED: "RESCHEDULED", // 已改签（旧场次记录）
  DISPLACED: "DISPLACED", // 缩容/停办被挤出，待改签或退号
});

function priorityScore(p = {}) {
  return (p.elderly ? 4 : 0) + (p.accessibility ? 3 : 0) + (p.proxy ? 2 : 0);
}

/** 按优先标记插入队列；同优先级按取号先后，稳定排序。 */
function insertIntoQueue(queue, ticketId, tickets) {
  const score = priorityScore(tickets.get(ticketId).priorities);
  let idx = queue.length;
  for (let i = 0; i < queue.length; i++) {
    if (priorityScore(tickets.get(queue[i]).priorities) < score) {
      idx = i;
      break;
    }
  }
  queue.splice(idx, 0, ticketId);
}

export class BookingState {
  constructor() {
    this.runtime = new Map(); // shiftId -> { suspended, suspendReason, capacity, capacityHistory:[] }
    this.tickets = new Map(); // ticketId -> ticket
    this.queues = new Map(); // shiftId -> [ticketId]（仅 ISSUED 在队）
    this.displacements = new Map(); // displacementId -> 记录
    this.idempotency = new Map(); // idemKey -> { fingerprint, result, eventSeq }
    this.nextTicketNo = 1;
  }

  _runtime(shiftId, baseCapacity) {
    let rt = this.runtime.get(shiftId);
    if (!rt) {
      rt = {
        suspended: false,
        suspendReason: "",
        capacity: baseCapacity,
        capacityHistory: baseCapacity != null ? [{ capacity: baseCapacity, reason: "班次计划容量" }] : [],
      };
      this.runtime.set(shiftId, rt);
    }
    return rt;
  }

  _queue(shiftId) {
    let q = this.queues.get(shiftId);
    if (!q) {
      q = [];
      this.queues.set(shiftId, q);
    }
    return q;
  }

  apply(event) {
    const { type, data, seq } = event;
    switch (type) {
      case "ShiftSuspended": {
        const rt = this._runtime(data.shiftId);
        rt.suspended = true;
        rt.suspendReason = data.reason;
        break;
      }
      case "ShiftResumed": {
        const rt = this._runtime(data.shiftId);
        rt.suspended = false;
        rt.suspendReason = "";
        break;
      }
      case "CapacityChanged": {
        const rt = this._runtime(data.shiftId, data.oldCapacity);
        rt.capacity = data.newCapacity;
        rt.capacityHistory.push({ capacity: data.newCapacity, reason: data.reason, at: event.ts, eventSeq: seq });
        break;
      }
      case "TicketIssued": {
        const t = {
          ticketId: data.ticketId,
          ticketNo: data.ticketNo,
          shiftId: data.shiftId,
          itemCode: data.itemCode,
          materials: [...(data.materials || [])],
          identity: data.identity,
          priorities: data.priorities || {},
          status: TicketStatus.ISSUED,
          issuedAt: data.issuedAt,
          issueEventSeq: seq,
          history: [{ kind: "ISSUED", shiftId: data.shiftId, at: data.issuedAt, eventSeq: seq }],
          displacementId: null,
        };
        this.tickets.set(data.ticketId, t);
        insertIntoQueue(this._queue(data.shiftId), data.ticketId, this.tickets);
        if (data.idempotencyKey) {
          this.idempotency.set(data.idempotencyKey, {
            fingerprint: data.fingerprint,
            result: { kind: "ISSUE", ticketId: data.ticketId },
            eventSeq: seq,
          });
        }
        this.nextTicketNo = Math.max(this.nextTicketNo, data.ticketNumber + 1 || 1);
        break;
      }
      case "TicketCancelled": {
        const t = this.tickets.get(data.ticketId);
        if (t && t.status === TicketStatus.ISSUED) {
          const q = this.queues.get(t.shiftId);
          if (q) {
            const i = q.indexOf(t.ticketId);
            if (i >= 0) q.splice(i, 1);
          }
        }
        if (t) {
          t.status = TicketStatus.CANCELLED;
          t.cancelReason = data.reason;
          t.displacementId = data.displacementId || t.displacementId;
          t.history.push({ kind: "CANCELLED", reason: data.reason, at: data.cancelledAt, displacementId: data.displacementId || null, eventSeq: seq });
        }
        if (data.idempotencyKey) {
          this.idempotency.set(data.idempotencyKey, {
            fingerprint: data.fingerprint,
            result: { kind: "CANCEL", ticketId: data.ticketId },
            eventSeq: seq,
          });
        }
        break;
      }
      case "TicketRescheduled": {
        const t = this.tickets.get(data.ticketId);
        if (!t) break;
        const oldQ = this.queues.get(data.fromShiftId);
        if (oldQ) {
          const i = oldQ.indexOf(t.ticketId);
          if (i >= 0) oldQ.splice(i, 1);
        }
        t.shiftId = data.toShiftId;
        t.status = TicketStatus.ISSUED;
        t.displacementId = data.displacementId || t.displacementId;
        t.history.push({
          kind: "RESCHEDULED",
          fromShiftId: data.fromShiftId,
          toShiftId: data.toShiftId,
          reason: data.reason,
          at: data.rescheduledAt,
          displacementId: data.displacementId || null,
          eventSeq: seq,
        });
        insertIntoQueue(this._queue(data.toShiftId), t.ticketId, this.tickets);
        if (data.idempotencyKey) {
          this.idempotency.set(data.idempotencyKey, {
            fingerprint: data.fingerprint,
            result: { kind: "RESCHEDULE", ticketId: data.ticketId },
            eventSeq: seq,
          });
        }
        break;
      }
      case "TicketDisplaced": {
        this.displacements.set(data.displacementId, {
          displacementId: data.displacementId,
          shiftId: data.shiftId,
          reason: data.reason,
          createdAt: data.createdAt,
          ticketIds: [...data.ticketIds],
          eventSeq: seq,
        });
        for (const id of data.ticketIds) {
          const t = this.tickets.get(id);
          if (!t) continue;
          const q = this.queues.get(data.shiftId);
          if (q) {
            const i = q.indexOf(id);
            if (i >= 0) q.splice(i, 1);
          }
          t.status = TicketStatus.DISPLACED;
          t.displacementId = data.displacementId;
          t.history.push({ kind: "DISPLACED", reason: data.reason, at: data.createdAt, displacementId: data.displacementId, eventSeq: seq });
        }
        break;
      }
      case "TicketServed": {
        const t = this.tickets.get(data.ticketId);
        if (t && t.status === TicketStatus.ISSUED) {
          const q = this.queues.get(t.shiftId);
          if (q) {
            const i = q.indexOf(t.ticketId);
            if (i >= 0) q.splice(i, 1);
          }
          t.status = TicketStatus.SERVED;
          t.history.push({ kind: "SERVED", at: data.servedAt, eventSeq: seq });
        }
        break;
      }
      case "TicketNoShowMarked": {
        const t = this.tickets.get(data.ticketId);
        if (t && t.status === TicketStatus.ISSUED) {
          const q = this.queues.get(t.shiftId);
          if (q) {
            const i = q.indexOf(t.ticketId);
            if (i >= 0) q.splice(i, 1);
          }
          t.status = TicketStatus.NOSHOW;
          t.history.push({ kind: "NOSHOW", at: data.markedAt, eventSeq: seq });
        }
        break;
      }
      case "QueueReordered": {
        const q = this._queue(data.shiftId);
        const current = new Set(q);
        const next = [...data.ticketIds];
        if (next.length !== current.size || !next.every((id) => current.has(id))) {
          throw new Error("QueueReordered 与当前在队号票不一致（拒绝投影，队列不可被静默改写）");
        }
        this.queues.set(data.shiftId, next);
        break;
      }
      default:
        // 未知事件类型不致命，但显式暴露，避免新版本事件被旧进程静默吞掉
        throw new Error(`未知事件类型：${type}`);
    }
    return this;
  }

  activeCount(shiftId) {
    return (this.queues.get(shiftId) || []).length;
  }

  /** 当前有效容量（未初始化运行期记录时回退到计划容量）。 */
  capacityOf(shiftId, baseCapacity) {
    const rt = this.runtime.get(shiftId);
    return rt ? rt.capacity : baseCapacity;
  }

  isSuspended(shiftId) {
    return Boolean(this.runtime.get(shiftId)?.suspended);
  }

  /** 某假名在某天某事项是否已有有效预约（含待处置的挤出号）。 */
  hasActiveBooking(pseudonym, itemCode, dateStr, excludeTicketId = null) {
    for (const t of this.tickets.values()) {
      if (t.ticketId === excludeTicketId) continue;
      if (t.identity.pseudonym !== pseudonym || t.itemCode !== itemCode) continue;
      const d = t.shiftId.split("#")[0];
      if (d !== dateStr) continue;
      if (t.status === TicketStatus.ISSUED || t.status === TicketStatus.DISPLACED) return true;
    }
    return false;
  }
}

export function replay(events, state = new BookingState()) {
  for (const e of events) state.apply(e);
  return state;
}

export { priorityScore };
