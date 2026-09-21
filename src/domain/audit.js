// 审计重放：
// - replayTicket：重放任意一笔取号涉及的全部事件，核对它"为何占用或释放号源"；
// - verifyLog：离线校验整条事件日志的哈希链；
// - explainCapacity：复盘某场次容量变化与号源占用/释放的对应关系。
import { EventLog } from "../store/event-log.js";

/** 取与某号票相关的全部事件（按序号），并给出逐步解释。 */
export function replayTicket(events, ticketId) {
  const related = events.filter(
    (e) =>
      e.data.ticketId === ticketId ||
      (e.type === "TicketDisplaced" && e.data.ticketIds.includes(ticketId))
  );
  if (related.length === 0) return null;

  const timeline = [];
  let shiftId = null;
  let holdsCapacity = false;
  for (const e of related) {
    let effect = "";
    switch (e.type) {
      case "TicketIssued":
        shiftId = e.data.shiftId;
        holdsCapacity = true;
        effect = `占用号源：${e.data.shiftId}，队列号 ${e.data.ticketNo}`;
        break;
      case "TicketCancelled":
        holdsCapacity = false;
        effect = `释放号源：退号（${e.data.reason}）${e.data.displacementId ? `，处置单 ${e.data.displacementId}` : ""}`;
        break;
      case "TicketRescheduled":
        shiftId = e.data.toShiftId;
        holdsCapacity = true;
        effect = `号源迁移并在新场次占位：${e.data.fromShiftId} → ${e.data.toShiftId}（${e.data.reason}）${e.data.displacementId ? `，处置单 ${e.data.displacementId}` : ""}`;
        break;
      case "TicketDisplaced":
        holdsCapacity = false;
        effect = `暂离队列、释放原号源：被挤出待改签/退号（${e.data.reason}），处置单 ${e.data.displacementId}`;
        break;
      case "TicketServed":
        holdsCapacity = false;
        effect = `释放号源：已办结`;
        break;
      case "TicketNoShowMarked":
        holdsCapacity = false;
        effect = `释放号源：场次结束后爽约`;
        break;
    }
    timeline.push({ seq: e.seq, ts: e.ts, type: e.type, actor: e.meta?.actor || null, effect, data: redact(e.data) });
  }

  const issued = related.find((e) => e.type === "TicketIssued");
  return {
    ticketId,
    ticketNo: issued?.data.ticketNo,
    itemCode: issued?.data.itemCode,
    currentShiftId: shiftId,
    currentlyHoldsCapacity: holdsCapacity,
    eventCount: related.length,
    timeline,
  };
}

/** 对外审计数据再次脱敏（事件本身已最小化，这里做防御性裁剪）。 */
function redact(data) {
  if (!data || typeof data !== "object") return data;
  const out = { ...data };
  if (out.identity) {
    out.identity = {
      maskedName: out.identity.maskedName,
      idTail: out.identity.idTail,
      idType: out.identity.idType,
      // pseudonym 是不可逆假名，可保留用于跨事件关联
      pseudonym: out.identity.pseudonym,
    };
  }
  return out;
}

/** 校验事件日志完整性，供启动与离线审计共用。 */
export function verifyLog(filePath) {
  const log = new EventLog(filePath);
  const events = log.readAll();
  return { ok: true, events: events.length, lastSeq: events.at(-1)?.seq || 0, lastHash: events.at(-1)?.hash || null };
}

/** 复盘一场次：计划容量 → 每次调整/停办 → 每张号的占用与释放。 */
export function explainCapacity(events, shiftId) {
  const changes = [];
  const ticketEffects = [];
  for (const e of events) {
    if (e.type === "CapacityChanged" && e.data.shiftId === shiftId) {
      changes.push({ seq: e.seq, at: e.ts, from: e.data.oldCapacity, to: e.data.newCapacity, reason: e.data.reason, actor: e.meta?.actor });
    }
    if (e.type === "ShiftSuspended" && e.data.shiftId === shiftId) {
      changes.push({ seq: e.seq, at: e.ts, suspended: true, reason: e.data.reason, actor: e.meta?.actor });
    }
    if (e.type === "ShiftResumed" && e.data.shiftId === shiftId) {
      changes.push({ seq: e.seq, at: e.ts, suspended: false, actor: e.meta?.actor });
    }
    const touches =
      (e.data.shiftId === shiftId && e.data.ticketId) ||
      (e.type === "TicketRescheduled" && (e.data.fromShiftId === shiftId || e.data.toShiftId === shiftId)) ||
      (e.type === "TicketDisplaced" && e.data.shiftId === shiftId);
    if (touches) {
      const ids = e.data.ticketIds || [e.data.ticketId];
      for (const id of ids) {
        ticketEffects.push({ seq: e.seq, ts: e.ts, type: e.type, ticketId: id, data: redact(e.data) });
      }
    }
  }
  return { shiftId, capacityChanges: changes, ticketEffects };
}
