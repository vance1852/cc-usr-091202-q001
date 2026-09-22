import { randomBytes } from "node:crypto";
import { DomainError, conflict, notFound } from "./errors.js";
import { slotKey } from "./catalog.js";
import { Projection, slotSummary } from "./state.js";
import {
  PRIORITY_FLAGS,
  assertNoIdentityLeak,
  hasPriority,
  maskRef,
  parseApplicantRef,
  sanitizePriority,
} from "./privacy.js";
import { isValidDate, msUntilSlotEnd } from "../util/time.js";

const newId = (p) => `${p}${randomBytes(9).toString("hex")}`;

/** 进程内命令串行锁：单进程部署下保证"校验→落盘→投影"原子，挡住并发重复点击 */
function mutexRunner() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(() => fn(), () => fn());
    tail = run.then(
      () => {},
      () => {}
    );
    return run;
  };
}

export class ReservationService {
  constructor({ store, catalog, calendar, clock = () => new Date() }) {
    this.store = store;
    this.catalog = catalog;
    this.calendar = calendar;
    this.now = clock;
    this.projection = new Projection(catalog);
    this.#withLock = mutexRunner();
  }

  async start() {
    const events = await this.store.start();
    for (const ev of events) this.projection.apply(ev);
    return events.length;
  }

  #withLock;

  // ---------- 查询 ----------

  /** 当天每个窗口时段的真实余量（含节假日政策与临时停办标记） */
  overview(date) {
    if (!isValidDate(date)) throw new DomainError("INVALID_DATE", "日期格式应为 YYYY-MM-DD");
    const policy = this.calendar.inspect(date);
    const rows = [];
    for (const win of this.catalog.windows.values()) {
      for (const slot of win.slots.values()) {
        const state = this.projection.slotState(date, win.id, slot.id);
        const row = state
          ? slotSummary(state, this.catalog)
          : {
              date,
              windowId: win.id,
              windowName: win.name,
              slotId: slot.id,
              slotLabel: slot.label,
              start: slot.start,
              end: slot.end,
              crossDay: slot.crossDay,
              baseCapacity: slot.baseCapacity,
              capacity: slot.baseCapacity,
              used: 0,
              remaining: slot.baseCapacity,
              displaced: 0,
              served: 0,
              noShow: 0,
              cancelled: 0,
              adjusted: false,
            };
        row.policy = policy.open ? "open" : "closed";
        row.policyReason = policy.reason;
        row.suspended = row.adjusted && row.capacity === 0;
        row.ended = msUntilSlotEnd(date, slot, this.now()) <= 0;
        rows.push(row);
      }
    }
    return { date, ...policy, slots: rows };
  }

  queue(date, windowId, slotId) {
    if (!isValidDate(date)) throw new DomainError("INVALID_DATE", "日期格式应为 YYYY-MM-DD");
    const win = this.catalog.getWindow(windowId);
    if (!win.slots.has(slotId)) throw new DomainError("SLOT_UNKNOWN", `窗口 ${win.name} 无 ${slotId} 时段`, { status: 404 });
    return {
      date,
      windowId,
      windowName: win.name,
      slotId,
      queued: this.projection.queueOf(date, windowId, slotId).map((t) => this.#ticketView(t)),
      displaced: this.projection.displacedOf(date, windowId, slotId).map((t) => this.#ticketView(t)),
    };
  }

  ticket(ticketId) {
    const t = this.projection.tickets.get(ticketId);
    if (!t) throw notFound(`预约 ${ticketId}`);
    return this.#ticketView(t, { detailed: true });
  }

  // ---------- 命令 ----------

  book(rawInput = {}) {
    return this.#withLock(() => this.#book(rawInput));
  }

  async #book(input) {
    assertNoIdentityLeak(input);
    const applicantRef = parseApplicantRef(input.applicantRef);
    const serviceCode = req(input.serviceCode, "serviceCode");
    const date = req(input.date, "date");
    if (!isValidDate(date)) throw new DomainError("INVALID_DATE", "日期格式应为 YYYY-MM-DD");
    const priority = sanitizePriority(input.priority);
    const materials = Array.isArray(input.materials) ? input.materials.filter((m) => typeof m === "string") : [];
    const idemKey = input.idempotencyKey ? String(input.idempotencyKey) : null;

    if (idemKey) {
      const hit = this.projection.idempotency.get(idemKey);
      if (hit) {
        if (hit.kind !== "book") throw conflict("IDEMPOTENCY_CONFLICT", "同一幂等键被用于不同操作");
        return this.#ticketView(this.projection.tickets.get(hit.ticketId), { replayed: true });
      }
    }

    const policy = this.calendar.inspect(date);
    if (!policy.open) throw new DomainError("SLOT_CLOSED_BY_POLICY", policy.reason);

    const dup = this.projection.findDuplicate(applicantRef, serviceCode, date);
    if (dup) {
      throw conflict(
        "DUPLICATE_BOOKING",
        `该办事人当天已存在事项 ${serviceCode} 的有效预约（${dup.number}，状态 ${dup.status}），请改签或退号后再办理`,
        { existingTicketId: dup.ticketId, number: dup.number, status: dup.status }
      );
    }

    const choice = this.#chooseSlot({
      windowId: input.windowId,
      slotId: input.slotId,
      serviceCode,
      date,
    });

    const ticketId = newId("TK_");
    const state = this.projection.slotState(date, choice.window.id, choice.slot.id);
    const number = `${choice.window.id}-${choice.slot.id}-${String(state ? state.nextNumber : 1).padStart(3, "0")}`;

    const events = await this.store.commit("TicketIssued", {
      ticketId,
      number,
      date,
      windowId: choice.window.id,
      slotId: choice.slot.id,
      serviceCode,
      applicantRef,
      priority,
      materials,
      source: input.source === "online" ? "online" : "walk-in",
      idempotencyKey: idemKey,
    });
    this.projection.apply(events[0]);
    return this.#ticketView(this.projection.tickets.get(ticketId));
  }

  #chooseSlot({ windowId, slotId, serviceCode, date }) {
    const candidates = this.catalog.resolveSlot({ windowId, slotId, serviceCode, date });
    const list = Array.isArray(candidates) ? candidates : [candidates];
    const live = [];
    for (const c of list) {
      if (msUntilSlotEnd(date, c.slot, this.now()) <= 0) {
        if (windowId && slotId) {
          throw new DomainError("SLOT_ENDED", `${c.slot.label}已结束，无法再取号`);
        }
        continue;
      }
      const state = this.projection.slotState(date, c.window.id, c.slot.id);
      const capacity = state?.capacity ?? c.slot.baseCapacity;
      const used = state?.queued.size ?? 0;
      if (used >= capacity) {
        if (windowId && slotId) {
          throw conflict("SLOT_FULL", `${c.window.name}${c.slot.label}号源已满（容量 ${capacity}）`, {
            capacity,
            used,
          });
        }
        continue;
      }
      live.push({ ...c, remaining: capacity - used });
    }
    if (live.length === 0) {
      throw conflict("NO_AVAILABLE_SLOT", `事项 ${serviceCode} 在 ${date} 没有可预约的剩余时段`);
    }
    // 余量最多的窗口时段优先，起到分流作用
    live.sort((a, b) => b.remaining - a.remaining);
    return live[0];
  }

  reschedule(rawInput = {}) {
    return this.#withLock(() => this.#reschedule(rawInput));
  }

  async #reschedule(input) {
    assertNoIdentityLeak(input);
    const ticketId = req(input.ticketId, "ticketId");
    const ticket = this.projection.tickets.get(ticketId);
    if (!ticket) throw notFound(`预约 ${ticketId}`);
    if (!["queued", "displaced"].includes(ticket.status)) {
      throw conflict("TICKET_NOT_RESCHEDULABLE", `当前状态 ${ticket.status} 不能改签`);
    }
    const idemKey = input.idempotencyKey ? String(input.idempotencyKey) : null;
    if (idemKey) {
      const hit = this.projection.idempotency.get(idemKey);
      if (hit) {
        if (hit.kind !== "reschedule") throw conflict("IDEMPOTENCY_CONFLICT", "同一幂等键被用于不同操作");
        return this.#ticketView(this.projection.tickets.get(hit.ticketId), { replayed: true });
      }
    }

    const toDate = req(input.to?.date, "to.date");
    if (!isValidDate(toDate)) throw new DomainError("INVALID_DATE", "日期格式应为 YYYY-MM-DD");
    const policy = this.calendar.inspect(toDate);
    if (!policy.open) throw new DomainError("SLOT_CLOSED_BY_POLICY", policy.reason);

    const target = this.#chooseSlot({
      windowId: input.to.windowId,
      slotId: input.to.slotId,
      serviceCode: ticket.serviceCode,
      date: toDate,
    });

    const sameTarget =
      ticket.date === toDate && ticket.windowId === target.window.id && ticket.slotId === target.slot.id;
    if (sameTarget && ticket.status === "queued") {
      throw conflict("SAME_SLOT", "改签目标与当前时段相同");
    }

    const events = await this.store.commit("TicketRescheduled", {
      ticketId,
      from: { date: ticket.date, windowId: ticket.windowId, slotId: ticket.slotId },
      to: { date: toDate, windowId: target.window.id, slotId: target.slot.id },
      reason: input.reason ? String(input.reason) : ticket.status === "displaced" ? "窗口缩容改签" : "申请人改签",
      idempotencyKey: idemKey,
    });
    for (const ev of events) this.projection.apply(ev);
    return this.#ticketView(this.projection.tickets.get(ticketId));
  }

  cancel(rawInput = {}) {
    return this.#withLock(() => this.#cancel(rawInput));
  }

  async #cancel(input) {
    assertNoIdentityLeak(input);
    const ticketId = req(input.ticketId, "ticketId");
    const ticket = this.projection.tickets.get(ticketId);
    if (!ticket) throw notFound(`预约 ${ticketId}`);
    if (!["queued", "displaced"].includes(ticket.status)) {
      throw conflict("TICKET_NOT_CANCELLABLE", `当前状态 ${ticket.status} 不能退号`);
    }
    const idemKey = input.idempotencyKey ? String(input.idempotencyKey) : null;
    if (idemKey) {
      const hit = this.projection.idempotency.get(idemKey);
      if (hit) {
        if (hit.kind !== "cancel") throw conflict("IDEMPOTENCY_CONFLICT", "同一幂等键被用于不同操作");
        return this.#ticketView(this.projection.tickets.get(hit.ticketId), { replayed: true });
      }
    }
    const reason = input.reason ? String(input.reason) : "申请人退号";
    const events = await this.store.commit("TicketCancelled", { ticketId, reason, idempotencyKey: idemKey });
    for (const ev of events) this.projection.apply(ev);
    return this.#ticketView(this.projection.tickets.get(ticketId));
  }

  /**
   * 窗口缩容 / 临时停办：把容量调到 to（0 即停办）。
   * 超出新容量的在排队列从队尾挤压出队；优先标记（老年人代办、无障碍）受到保护，
   * 即先挤压普通号的队尾，普通号不足时才动优先号。被挤出的票变为 displaced，
   * 必须改签或退号，全过程各有事件可查。
   */
  shrinkCapacity(rawInput = {}) {
    return this.#withLock(() => this.#shrinkCapacity(rawInput));
  }

  async #shrinkCapacity(input) {
    const date = req(input.date, "date");
    const windowId = req(input.windowId, "windowId");
    const slotId = req(input.slotId, "slotId");
    if (!isValidDate(date)) throw new DomainError("INVALID_DATE", "日期格式应为 YYYY-MM-DD");
    const win = this.catalog.getWindow(windowId);
    const slot = win.slots.get(slotId);
    if (!slot) throw new DomainError("SLOT_UNKNOWN", `窗口 ${win.name} 无 ${slotId} 时段`, { status: 404 });
    const to = input.to;
    if (!Number.isInteger(to) || to < 0 || to > slot.baseCapacity) {
      throw new DomainError("INVALID_CAPACITY", `新容量须为 0-${slot.baseCapacity} 的整数（缩容不能超过基准容量）`);
    }
    const reason = input.reason ? String(input.reason) : "窗口临时缩容";
    const state = this.projection.slotState(date, windowId, slotId);
    const current = state?.capacity ?? slot.baseCapacity;
    if (to > current) {
      throw conflict("CAPACITY_ONLY_SHRINK", `缩容目标 ${to} 大于当前容量 ${current}，恢复请使用恢复接口`);
    }

    const queued = state
      ? [...state.queued].map((id) => this.projection.tickets.get(id)).sort((a, b) => a.queueSeq - b.queueSeq)
      : [];
    const overflow = queued.length - to;
    const victims = [];
    if (overflow > 0) {
      const normal = queued.filter((t) => !hasPriority(t.priority));
      const priority = queued.filter((t) => hasPriority(t.priority));
      // 先从普通号队尾取
      for (let i = normal.length - 1; i >= 0 && victims.length < overflow; i--) victims.push(normal[i]);
      // 普通号不够，再从优先号队尾取（优先号内部仍保持晚到先挤出）
      for (let i = priority.length - 1; i >= 0 && victims.length < overflow; i--) victims.push(priority[i]);
      victims.sort((a, b) => b.queueSeq - a.queueSeq);
    }

    const items = [{ type: "CapacityChanged", payload: { date, windowId, slotId, from: current, to, reason } }];
    for (const t of victims) {
      items.push({
        type: "TicketDisplaced",
        payload: { ticketId: t.ticketId, reason: `${reason}：容量 ${current}→${to}，队尾挤出` },
      });
    }
    const events = await this.store.commitBatch(items);
    for (const ev of events) this.projection.apply(ev);

    const after = this.projection.slotState(date, windowId, slotId);
    const summary = slotSummary(after, this.catalog);
    summary.suspended = summary.capacity === 0;
    return {
      slot: summary,
      displaced: victims.map((t) => this.#ticketView(this.projection.tickets.get(t.ticketId))),
      note: victims.length
        ? "被挤出的办事人需改签或退号；其优先标记已保留"
        : "当前在排人数不超过新容量，无需挤出",
    };
  }

  /** 窗口恢复：容量回调（不超过基准），被挤票不自动回队，由导办员逐笔改签，留下决策链 */
  restoreCapacity(rawInput = {}) {
    return this.#withLock(() => this.#restoreCapacity(rawInput));
  }

  async #restoreCapacity(input) {
    const date = req(input.date, "date");
    const windowId = req(input.windowId, "windowId");
    const slotId = req(input.slotId, "slotId");
    const win = this.catalog.getWindow(windowId);
    const slot = win.slots.get(slotId);
    if (!slot) throw new DomainError("SLOT_UNKNOWN", `窗口 ${win.name} 无 ${slotId} 时段`, { status: 404 });
    const state = this.projection.slotState(date, windowId, slotId);
    const current = state?.capacity ?? slot.baseCapacity;
    const to = input.to === undefined ? slot.baseCapacity : input.to;
    if (!Number.isInteger(to) || to <= current || to > slot.baseCapacity) {
      throw conflict("INVALID_RESTORE", `恢复容量须大于当前 ${current} 且不超过基准 ${slot.baseCapacity}`);
    }
    const reason = input.reason ? String(input.reason) : "窗口恢复";
    const events = await this.store.commitBatch([
      { type: "CapacityChanged", payload: { date, windowId, slotId, from: current, to, reason } },
    ]);
    for (const ev of events) this.projection.apply(ev);
    return { slot: slotSummary(this.projection.slotState(date, windowId, slotId), this.catalog) };
  }

  markServed(rawInput = {}) {
    return this.#withLock(() => this.#markTerminal(rawInput, "TicketServed", "served"));
  }

  markNoShow(rawInput = {}) {
    return this.#withLock(() => this.#markTerminal(rawInput, "TicketNoShowMarked", "no-show"));
  }

  async #markTerminal(input, eventType, status) {
    const ticketId = req(input.ticketId, "ticketId");
    const ticket = this.projection.tickets.get(ticketId);
    if (!ticket) throw notFound(`预约 ${ticketId}`);
    if (ticket.status !== "queued") throw conflict("TICKET_NOT_QUEUED", `当前状态 ${ticket.status}，无法标记为${status}`);
    const events = await this.store.commit(eventType, { ticketId });
    for (const ev of events) this.projection.apply(ev);
    return this.#ticketView(this.projection.tickets.get(ticketId));
  }

  /** 傍晚收号：把所有已结束时段仍在排队的票批量记为爽约，释放号源并计入爽约统计 */
  sweepNoShow(rawInput = {}) {
    return this.#withLock(() => this.#sweepNoShow(rawInput));
  }

  async #sweepNoShow(input) {
    const date = input.date ? String(input.date) : null;
    const items = [];
    for (const [key, state] of this.projection.slots) {
      if (date && state.date !== date) continue;
      const win = this.catalog.windows.get(state.windowId);
      const slotCfg = win?.slots.get(state.slotId);
      if (!slotCfg) continue;
      if (msUntilSlotEnd(state.date, slotCfg, this.now()) > 0) continue;
      for (const id of state.queued) items.push({ type: "TicketNoShowMarked", payload: { ticketId: id } });
    }
    if (items.length === 0) return { swept: 0, tickets: [] };
    const events = await this.store.commitBatch(items);
    for (const ev of events) this.projection.apply(ev);
    return { swept: items.length, tickets: items.map((i) => this.#ticketView(this.projection.tickets.get(i.payload.ticketId))) };
  }

  // ---------- 重放 / 审计 ----------

  /** 重放任意一笔取号：逐条事件解释它为何占用或释放号源 */
  replayTicket(ticketId) {
    const t = this.projection.tickets.get(ticketId);
    if (!t) throw notFound(`预约 ${ticketId}`);
    const trace = [];
    for (const ref of t.events) {
      trace.push({ seq: ref.seq, at: ref.at, type: ref.type, explanation: explainTicketEvent(ref.type, ref, t) });
    }
    return { ticket: this.#ticketView(t, { detailed: true }), trace };
  }

  /** 整卷事件流（管理端审计/导出） */
  async eventStream({ sinceSeq = 0 } = {}) {
    const all = await this.store.readAll();
    return all.filter((e) => e.seq > sinceSeq);
  }

  // ---------- 视图 ----------

  #ticketView(t, { detailed = false, replayed = false } = {}) {
    const service = this.catalog.services.get(t.serviceCode);
    const win = this.catalog.windows.get(t.windowId);
    const slot = win?.slots.get(t.slotId);
    const view = {
      ticketId: t.ticketId,
      number: t.number,
      status: t.status,
      applicant: maskRef(t.applicantRef),
      serviceCode: t.serviceCode,
      serviceName: service?.name ?? t.serviceCode,
      date: t.date,
      windowId: t.windowId,
      windowName: win?.name ?? t.windowId,
      slotId: t.slotId,
      slotLabel: slot?.label ?? t.slotId,
      timeRange: slot ? `${slot.start}-${slot.end}${slot.crossDay ? "（跨日）" : ""}` : undefined,
      priority: t.priority ?? {},
      priorityLabels: Object.entries(t.priority ?? {})
        .filter(([, v]) => v === true)
        .map(([k]) => PRIORITY_FLAGS[k] ?? k),
      materials: t.materials ?? [],
      missingMaterials: (service?.requiredMaterials ?? []).filter((m) => !(t.materials ?? []).includes(m)),
      source: t.source,
      issuedAt: t.issuedAt,
      queueSeq: t.queueSeq,
    };
    if (t.cancelReason) view.cancelReason = t.cancelReason;
    if (detailed) {
      view.eventCount = t.events.length;
      view.timeline = t.events.map((ref) => ({
        seq: ref.seq,
        type: ref.type,
        at: ref.at,
        reason: ref.reason,
        explanation: explainTicketEvent(ref.type, ref, t),
      }));
    }
    if (replayed) view.idempotentReplay = true;
    return view;
  }
}

function req(v, field) {
  if (v === undefined || v === null || v === "") {
    throw new DomainError("MISSING_FIELD", `缺少必填字段 ${field}`);
  }
  return v;
}

/** 把单笔票据的事件翻译成"占用/释放号源"的人话，供导办员核对 */
export function explainTicketEvent(type, ref, t) {
  switch (type) {
    case "TicketIssued":
      return `取号 ${t.number}：在 ${ref.date ?? t.date} ${ref.slotId ?? t.slotId} 时段占用 1 个号源，加入队尾`;
    case "TicketRescheduled": {
      const f = ref.from;
      const to = ref.to;
      return f
        ? `改签：退出 ${f.date} ${f.slotId} 队列（释放原号源），进入 ${to.date} ${to.slotId} 队尾（占用新号源）`
        : "改签：退出原时段队列（释放原号源），进入目标时段队尾（占用新号源）";
    }
    case "TicketDisplaced":
      return `缩容挤出：${ref.reason ?? ""}；该票退出排队、释放当前号源，但保留改签/退号资格`;
    case "TicketCancelled":
      return `退号：${ref.reason ?? "申请人退号"}，号源释放且可再次发放`;
    case "TicketNoShowMarked":
      return "超过时段未到场，记为爽约，号源释放";
    case "TicketServed":
      return "窗口叫号并办结，号源正常核销";
    default:
      return type;
  }
}
