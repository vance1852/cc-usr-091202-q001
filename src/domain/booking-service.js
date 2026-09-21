// 预约分流命令服务：
// 所有写操作串行化（单进程事件存储），配合幂等键抵抗重复点击与网络重试；
// 所有判定（节假日、容量、重复预约、优先入队）都在这里完成，只通过事件落盘。
import { createHash } from "node:crypto";
import { TicketStatus } from "./state.js";
import { todayCst } from "../util/time.js";
import { attestIdentity } from "../security/privacy.js";

export class BookingError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

/** 规范化 JSON 指纹（不含幂等键本身），用于识别"同键不同请求"的冲突。 */
export function requestFingerprint(obj) {
  const canon = JSON.stringify(obj, (k, v) => {
    if (k === "idempotencyKey") return undefined;
    return v;
  });
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

let chain = Promise.resolve();
/** 串行化全部命令：单进程内把事件追加与状态更新作为临界区。 */
function withLock(task) {
  const run = chain.then(() => task());
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export class BookingService {
  /**
   * @param {object} deps
   * @param {import('./event-log.js').EventLog} deps.log
   * @param {import('./state.js').BookingState} deps.state
   * @param {import('./catalog.js').Catalog} deps.catalog
   * @param {import('./calendar.js').HolidayCalendar} deps.calendar
   * @param {Buffer} deps.hmacKey
   */
  constructor({ log, state, catalog, calendar, hmacKey, clock = () => Date.now() }) {
    this.log = log;
    this.state = state;
    this.catalog = catalog;
    this.calendar = calendar;
    this.hmacKey = hmacKey;
    this.clock = clock;
    this.inFlight = new Map(); // idemKey -> Promise（并发同键去重）
  }

  _nowIso() {
    return new Date(this.clock()).toISOString();
  }

  _assertShiftOpen(shift) {
    const day = this.calendar.resolve(shift.date);
    if (!day.open) {
      throw new BookingError("SHIFT_HOLIDAY_CLOSED", `该日期${day.reason}，场次不可办理`, { shiftId: shift.id, reason: day.reason });
    }
    const rt = this.state.runtime.get(shift.id);
    if (rt?.suspended) {
      throw new BookingError("SHIFT_SUSPENDED", `窗口临时停办：${rt.suspendReason}`, { shiftId: shift.id, reason: rt.suspendReason });
    }
    return day;
  }

  _getShift(shiftId) {
    const shift = this.catalog.getShift(shiftId);
    if (!shift) throw new BookingError("SHIFT_NOT_FOUND", `班次不存在：${shiftId}`);
    return shift;
  }

  /**
   * 取号。
   * input: { idempotencyKey, shiftId, itemCode, materials, identity:{name,idType,idNumber},
   *          flags:{proxy,needAccessibility,declaredElderly}, note }
   */
  issueTicket(input) {
    return this._idem(input, "issue", () => this._issueTicket(input));
  }

  _issueTicket(input) {
    const shift = this._getShift(input.shiftId);
    const item = this.catalog.getItem(input.itemCode);
    if (!item) throw new BookingError("ITEM_NOT_FOUND", `事项不存在：${input.itemCode}`);
    if (!shift.services.includes(input.itemCode)) {
      throw new BookingError("ITEM_NOT_SERVED", `${shift.window} 本场次不办理「${item.name}」`);
    }
    this._assertShiftOpen(shift);

    const today = todayCst(this.clock());
    if (input.flags?.needAccessibility && !shift.accessible) {
      // 无障碍需要无障碍窗口；仅提示不强制（中心可人工安排），但必须显式确认
      if (!input.flags.accessibilityConfirmed) {
        throw new BookingError("ACCESSIBLE_WINDOW_REQUIRED", "该窗口无无障碍设施，请改挂无障碍窗口或由导办员确认", {
          accessibleShifts: this.catalog.shiftsForItem(input.itemCode, shift.date).filter((s) => s.accessible).map((s) => s.id),
        });
      }
    }

    // 身份证明：此后只持有假名/脱敏视图
    const attested = attestIdentity(input.identity || {}, input.flags || {}, this.hmacKey, today);
    const { identity, priorities } = attested;

    // 同一人当天同一事项唯一有效预约（重复预约拦截，不含已退/已办/爽约）
    if (this.state.hasActiveBooking(identity.pseudonym, input.itemCode, shift.date)) {
      throw new BookingError("DUPLICATE_BOOKING", "您当天已持有该事项的有效预约，请勿重复取号", {
        date: shift.date,
        itemCode: input.itemCode,
      });
    }

    // 容量判定
    const capacity = this.state.capacityOf(shift.id, shift.baseCapacity);
    const used = this.state.activeCount(shift.id);
    if (used >= capacity) {
      throw new BookingError("SHIFT_FULL", "该场次号源已满", {
        shiftId: shift.id,
        capacity,
        remaining: 0,
      });
    }

    // 材料登记：仅记录材料名称齐全性，不记录证件影像
    const materials = [...(input.materials || [])];
    const missingMaterials = item.requiredMaterials.filter((m) => !materials.includes(m));

    const number = this.state.nextTicketNo;
    const ticketId = `T${String(number).padStart(4, "0")}`;
    const event = this.log.append(
      "TicketIssued",
      {
        ticketId,
        ticketNumber: number,
        ticketNo: `${shift.code.slice(0, 1)}${String(number).padStart(3, "0")}`,
        shiftId: shift.id,
        window: shift.window,
        itemCode: item.code,
        itemName: item.name,
        materials,
        missingMaterials,
        identity, // 仅 {pseudonym, maskedName, idTail, idType}
        priorities,
        issuedAt: this._nowIso(),
        idempotencyKey: input.idempotencyKey || null,
        fingerprint: input.idempotencyKey ? requestFingerprint(input) : null,
      },
      { actor: input.actor || "citizen" }
    );
    this.state.apply(event);

    return {
      ticketId,
      ticketNo: event.data.ticketNo,
      shiftId: shift.id,
      window: shift.window,
      itemCode: item.code,
      itemName: item.name,
      date: shift.date,
      startLabel: shift.startLabel,
      endLabel: shift.endLabel,
      queuePosition: this.state.queues.get(shift.id).length,
      remaining: this.state.capacityOf(shift.id, shift.baseCapacity) - this.state.activeCount(shift.id),
      priorities,
      missingMaterials,
    };
  }

  /** 退号（市民主动；挤出后的退号须带 displacementId 以串起来龙去脉）。 */
  cancelTicket(input) {
    return this._idem(input, "cancel", () => this._cancelTicket(input));
  }

  _cancelTicket(input) {
    const t = this.state.tickets.get(input.ticketId);
    if (!t) throw new BookingError("TICKET_NOT_FOUND", `号票不存在：${input.ticketId}`);
    if (!input.reason) throw new BookingError("REASON_REQUIRED", "退号必须填写原因");

    if (t.status === TicketStatus.CANCELLED) {
      throw new BookingError("TICKET_ALREADY_CANCELLED", "该号已退号，请勿重复操作");
    }
    if (t.status === TicketStatus.SERVED) {
      throw new BookingError("TICKET_ALREADY_SERVED", "该号已办结，不能退号");
    }
    if (t.status === TicketStatus.NOSHOW) {
      throw new BookingError("TICKET_NOSHOW", "该号已记爽约，不能退号");
    }
    if (t.displacementId && input.displacementId !== t.displacementId) {
      throw new BookingError("DISPLACEMENT_LINK_REQUIRED", "挤出号退号必须关联对应的处置单号", {
        expectedDisplacementId: t.displacementId,
      });
    }

    const event = this.log.append(
      "TicketCancelled",
      {
        ticketId: t.ticketId,
        shiftId: t.shiftId,
        reason: input.reason,
        displacementId: t.displacementId || input.displacementId || null,
        cancelledAt: this._nowIso(),
        idempotencyKey: input.idempotencyKey || null,
        fingerprint: input.idempotencyKey ? requestFingerprint(input) : null,
      },
      { actor: input.actor || "citizen" }
    );
    this.state.apply(event);
    return { ticketId: t.ticketId, status: TicketStatus.CANCELLED, shiftId: t.shiftId };
  }

  /**
   * 改签：换到另一场次。
   * 挤出后改签须带 displacementId；目标场次同样校验节假日/停办/容量/重复预约。
   */
  rescheduleTicket(input) {
    return this._idem(input, "reschedule", () => this._rescheduleTicket(input));
  }

  _rescheduleTicket(input) {
    const t = this.state.tickets.get(input.ticketId);
    if (!t) throw new BookingError("TICKET_NOT_FOUND", `号票不存在：${input.ticketId}`);
    if (![TicketStatus.ISSUED, TicketStatus.DISPLACED].includes(t.status)) {
      throw new BookingError("RESCHEDULE_NOT_ALLOWED", `当前状态 ${t.status} 不允许改签`);
    }
    if (!input.reason) throw new BookingError("REASON_REQUIRED", "改签必须填写原因");
    const target = this._getShift(input.toShiftId);
    if (!target.services.includes(t.itemCode)) {
      throw new BookingError("ITEM_NOT_SERVED", `目标窗口不办理该事项`);
    }
    if (target.id === t.shiftId) throw new BookingError("SAME_SHIFT", "目标场次与原场次相同");
    this._assertShiftOpen(target);
    if (t.displacementId && input.displacementId !== t.displacementId) {
      throw new BookingError("DISPLACEMENT_LINK_REQUIRED", "挤出号改签必须关联对应的处置单号", {
        expectedDisplacementId: t.displacementId,
      });
    }
    if (this.state.hasActiveBooking(t.identity.pseudonym, t.itemCode, target.date, t.ticketId)) {
      throw new BookingError("DUPLICATE_BOOKING", "目标日期已有该事项的有效预约");
    }
    const capacity = this.state.capacityOf(target.id, target.baseCapacity);
    if (this.state.activeCount(target.id) >= capacity) {
      throw new BookingError("SHIFT_FULL", "目标场次号源已满");
    }

    const event = this.log.append(
      "TicketRescheduled",
      {
        ticketId: t.ticketId,
        fromShiftId: t.shiftId,
        toShiftId: target.id,
        reason: input.reason,
        displacementId: t.displacementId || input.displacementId || null,
        rescheduledAt: this._nowIso(),
        idempotencyKey: input.idempotencyKey || null,
        fingerprint: input.idempotencyKey ? requestFingerprint(input) : null,
      },
      { actor: input.actor || "staff" }
    );
    this.state.apply(event);
    return {
      ticketId: t.ticketId,
      fromShiftId: event.data.fromShiftId,
      toShiftId: event.data.toShiftId,
      queuePosition: this.state.queues.get(target.id).indexOf(t.ticketId) + 1,
      remaining: this.state.capacityOf(target.id, target.baseCapacity) - this.state.activeCount(target.id),
    };
  }

  /** 窗口临时停办：登记停办并把在场号全部挤出（等待改签/退号）。 */
  suspendShift(input) {
    return withLock(() => {
      const shift = this._getShift(input.shiftId);
      if (this.state.isSuspended(shift.id)) {
        throw new BookingError("SHIFT_ALREADY_SUSPENDED", "该场次已处于停办状态");
      }
      if (!input.reason) throw new BookingError("REASON_REQUIRED", "临时停办必须填写原因");
      const ev1 = this.log.append(
        "ShiftSuspended",
        { shiftId: shift.id, window: shift.window, reason: input.reason, at: this._nowIso() },
        { actor: input.actor || "staff" }
      );
      this.state.apply(ev1);
      const displacement = this._displaceOverflow(shift.id, 0, input.reason, input.actor || "staff");
      return { shiftId: shift.id, suspended: true, ...displacement };
    });
  }

  /** 恢复窗口（不自动恢复被挤出的号，需逐笔改签/退号，避免号源超卖）。 */
  resumeShift(input) {
    return withLock(() => {
      const shift = this._getShift(input.shiftId);
      if (!this.state.isSuspended(shift.id)) throw new BookingError("SHIFT_NOT_SUSPENDED", "该场次未停办");
      const ev = this.log.append(
        "ShiftResumed",
        { shiftId: shift.id, at: this._nowIso() },
        { actor: input.actor || "staff" }
      );
      this.state.apply(ev);
      return { shiftId: shift.id, suspended: false };
    });
  }

  /**
   * 缩容/扩容。容量下调时，按队列尾部（优先级最低、取号最晚）挤出超出的号，
   * 生成一笔处置单，留待改签或退号。
   */
  changeCapacity(input) {
    return withLock(() => {
      const shift = this._getShift(input.shiftId);
      if (!Number.isInteger(input.newCapacity) || input.newCapacity < 0) {
        throw new BookingError("BAD_CAPACITY", "新容量必须为非负整数");
      }
      if (!input.reason) throw new BookingError("REASON_REQUIRED", "容量调整必须填写原因");
      const oldCapacity = this.state.capacityOf(shift.id, shift.baseCapacity);
      if (oldCapacity === input.newCapacity) {
        return { shiftId: shift.id, capacity: oldCapacity, displaced: [] };
      }
      const ev = this.log.append(
        "CapacityChanged",
        {
          shiftId: shift.id,
          window: shift.window,
          oldCapacity,
          newCapacity: input.newCapacity,
          reason: input.reason,
          at: this._nowIso(),
        },
        { actor: input.actor || "staff" }
      );
      this.state.apply(ev);
      const displacement = this._displaceOverflow(shift.id, input.newCapacity, input.reason, input.actor || "staff");
      return { shiftId: shift.id, capacity: input.newCapacity, ...displacement };
    });
  }

  /** 把超出有效容量的在队号挤出，生成处置单；停办时 newCapacity=0。 */
  _displaceOverflow(shiftId, newCapacity, reason, actor) {
    const queue = this.state.queues.get(shiftId) || [];
    const overflow = queue.length > newCapacity ? queue.slice(newCapacity) : [];
    if (overflow.length === 0) return { displacementId: null, displaced: [] };
    const seq = this.state.displacements.size + 1;
    const displacementId = `D${String(seq).padStart(4, "0")}`;
    const ev = this.log.append(
      "TicketDisplaced",
      {
        displacementId,
        shiftId,
        newCapacity,
        reason,
        ticketIds: overflow,
        createdAt: this._nowIso(),
      },
      { actor }
    );
    this.state.apply(ev);
    return {
      displacementId,
      displaced: overflow.map((id) => {
        const t = this.state.tickets.get(id);
        return { ticketId: id, maskedName: t.identity.maskedName, priorities: t.priorities };
      }),
    };
  }

  /**
   * 爽约扫描：已过结束时刻仍在队的号标记爽约并释放号源。
   * 跨零点夜班按真实结束时刻（次日凌晨）判定。
   */
  sweepNoShows(nowMs = this.clock()) {
    return withLock(() => {
      const marked = [];
      for (const [shiftId, queue] of this.state.queues) {
        if (queue.length === 0) continue;
        const shift = this.catalog.getShift(shiftId);
        if (!shift || nowMs < shift.end) continue;
        for (const ticketId of [...queue]) {
          const ev = this.log.append(
            "TicketNoShowMarked",
            { ticketId, shiftId, markedAt: new Date(nowMs).toISOString() },
            { actor: "system" }
          );
          this.state.apply(ev);
          marked.push(ticketId);
        }
      }
      return { marked };
    });
  }

  /** 办结：窗口叫号办理完成。 */
  markServed(input) {
    return withLock(() => {
      const t = this.state.tickets.get(input.ticketId);
      if (!t) throw new BookingError("TICKET_NOT_FOUND", `号票不存在：${input.ticketId}`);
      if (t.status !== TicketStatus.ISSUED) throw new BookingError("NOT_IN_QUEUE", `号票当前状态 ${t.status}，无法办结`);
      const ev = this.log.append(
        "TicketServed",
        { ticketId: t.ticketId, shiftId: t.shiftId, servedAt: this._nowIso() },
        { actor: input.actor || "staff" }
      );
      this.state.apply(ev);
      return { ticketId: t.ticketId, status: TicketStatus.SERVED };
    });
  }

  /**
   * 导办员调整队列顺序：只能重排当前在场在队的号，
   * 投影会校验集合一致，任何静默增删都被拒绝。
   */
  reorderQueue(input) {
    return withLock(() => {
      const shift = this._getShift(input.shiftId);
      const ticketIds = input.ticketIds || [];
      // 关键：在事件落盘前校验集合一致，避免非法事件污染只能追加的日志
      const current = this.state.queues.get(shift.id) || [];
      if (ticketIds.length !== current.length || new Set(ticketIds).size !== ticketIds.length || !ticketIds.every((id) => current.includes(id))) {
        throw new BookingError("QUEUE_REORDER_INVALID", "调整后的队列与当前在队号票不一致，拒绝重排（不可夹带增删或重复）");
      }
      const ev = this.log.append(
        "QueueReordered",
        { shiftId: shift.id, ticketIds, reason: input.reason || "导办员人工调整", at: this._nowIso() },
        { actor: input.actor || "staff" }
      );
      this.state.apply(ev);
      return { shiftId: shift.id, queue: this.state.queues.get(shift.id) };
    });
  }

  /**
   * 幂等执行：
   * - 同键重放：请求指纹一致 → 返回首次结果（不重复占号/释放）；
   * - 同键异请求：拒绝，防止键被复用掩盖误操作；
   * - 同键并发：合并到同一个在途 Promise，防止双击同时穿过容量检查。
   */
  _idem(input, kind, fn) {
    const key = input.idempotencyKey;
    if (!key) return withLock(fn);

    const fp = requestFingerprint(input);
    const seen = this.state.idempotency.get(key);
    if (seen) {
      if (seen.fingerprint !== fp) {
        return Promise.reject(new BookingError("IDEMPOTENCY_CONFLICT", "相同幂等键对应了不同的请求内容"));
      }
      return Promise.resolve(this._reconstructIdempotentResult(seen, kind));
    }
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const p = withLock(() => {
      // 拿到锁后再查一次（在途同键请求可能已提交）
      const seen2 = this.state.idempotency.get(key);
      if (seen2) {
        if (seen2.fingerprint !== fp) {
          throw new BookingError("IDEMPOTENCY_CONFLICT", "相同幂等键对应了不同的请求内容");
        }
        return this._reconstructIdempotentResult(seen2, kind);
      }
      return fn();
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  /** 重放命中幂等键时，从当前状态重建可对外返回的结果（不新增事件）。 */
  _reconstructIdempotentResult(seen, kind) {
    const result = seen.result;
    if (result.kind === "ISSUE") {
      const t = this.state.tickets.get(result.ticketId);
      if (!t) return { ticketId: result.ticketId, replayed: true };
      const shift = this.catalog.getShift(t.shiftId);
      return {
        ticketId: t.ticketId,
        ticketNo: t.ticketNo,
        shiftId: t.shiftId,
        window: shift?.window,
        itemCode: t.itemCode,
        date: shift?.date,
        startLabel: shift?.startLabel,
        endLabel: shift?.endLabel,
        queuePosition: t.status === TicketStatus.ISSUED ? this.state.queues.get(t.shiftId).indexOf(t.ticketId) + 1 : null,
        status: t.status,
        replayed: true,
        note: "重复请求已去重，返回首次取号结果",
      };
    }
    if (result.kind === "CANCEL") {
      const t = this.state.tickets.get(result.ticketId);
      return { ticketId: result.ticketId, status: t?.status, replayed: true, note: "重复退号请求已去重" };
    }
    if (result.kind === "RESCHEDULE") {
      const t = this.state.tickets.get(result.ticketId);
      return { ticketId: result.ticketId, status: t?.status, shiftId: t?.shiftId, replayed: true, note: "重复改签请求已去重" };
    }
    return { replayed: true };
  }
}
