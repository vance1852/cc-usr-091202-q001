// 无第三方依赖的 HTTP 入口。
// 注意：请求体（含身份证明信息）只在内存中解析并立即传递给服务层，
// 不写访问日志、不落临时文件；响应只含脱敏视图。
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { todayCst } from "./util/time.js";
import { replayTicket, explainCapacity, verifyLog } from "./domain/audit.js";

const MAX_BODY = 64 * 1024;

function send(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function ok(res, payload) {
  send(res, 200, { ok: true, ...payload });
}

function fail(res, err) {
  const status = err.code ? 400 : 500;
  send(res, status, { ok: false, error: { code: err.code || "INTERNAL", message: err.message, ...stripExtra(err) } });
}

function stripExtra(err) {
  const out = {};
  for (const k of ["shiftId", "date", "itemCode", "capacity", "remaining", "reason", "expectedDisplacementId", "accessibleShifts"]) {
    if (err[k] !== undefined) out[k] = err[k];
  }
  return out;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("请求体过大"), { code: "BODY_TOO_LARGE" });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { code: "BAD_JSON" });
  }
}

export function createHttpServer(app) {
  const { service, queries, log, catalog } = app;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const idemKey = req.headers["idempotency-key"];
    try {
      if (req.method === "GET" && path === "/health") {
        return ok(res, { status: "up", today: todayCst(), events: app.eventCount });
      }

      if (req.method === "GET" && path === "/board") {
        const date = url.searchParams.get("date") || todayCst();
        return ok(res, { date, windows: queries.dailyBoard(date) });
      }

      if (req.method === "GET" && path === "/displacements") {
        return ok(res, { pending: queries.pendingDisplacements() });
      }

      if (req.method === "POST" && path === "/system/sweep-no-shows") {
        const result = await service.sweepNoShows();
        return ok(res, result);
      }

      if (req.method === "GET" && path === "/audit/verify") {
        return ok(res, verifyLog(log.filePath));
      }

      let m;
      if ((m = path.match(/^\/shifts\/(.+)$/)) && req.method === "GET") {
        const shiftId = decodeURIComponent(m[1]);
        if (url.searchParams.get("explain") === "1") {
          return ok(res, explainCapacity(log.readAll(), shiftId));
        }
        const view = queries.shiftView(shiftId);
        if (!view) throw Object.assign(new Error("班次不存在"), { code: "SHIFT_NOT_FOUND" });
        return ok(res, { shift: view });
      }

      if ((m = path.match(/^\/shifts\/(.+)\/suspend$/)) && req.method === "POST") {
        const body = await readJson(req);
        return ok(res, await service.suspendShift({ shiftId: decodeURIComponent(m[1]), reason: body.reason, actor: body.actor }));
      }
      if ((m = path.match(/^\/shifts\/(.+)\/resume$/)) && req.method === "POST") {
        const body = await readJson(req);
        return ok(res, await service.resumeShift({ shiftId: decodeURIComponent(m[1]), actor: body.actor }));
      }
      if ((m = path.match(/^\/shifts\/(.+)\/capacity$/)) && req.method === "POST") {
        const body = await readJson(req);
        return ok(res, await service.changeCapacity({ shiftId: decodeURIComponent(m[1]), newCapacity: body.newCapacity, reason: body.reason, actor: body.actor }));
      }
      if ((m = path.match(/^\/queues\/(.+)\/reorder$/)) && req.method === "POST") {
        const body = await readJson(req);
        return ok(res, await service.reorderQueue({ shiftId: decodeURIComponent(m[1]), ticketIds: body.ticketIds, reason: body.reason, actor: body.actor }));
      }

      if (path === "/tickets" && req.method === "POST") {
        const body = await readJson(req);
        return ok(res, { ticket: await service.issueTicket({ ...body, idempotencyKey: idemKey || body.idempotencyKey }) });
      }

      if ((m = path.match(/^\/tickets\/([^/]+)\/replay$/)) && req.method === "GET") {
        const report = replayTicket(log.readAll(), m[1]);
        if (!report) throw Object.assign(new Error("号票无任何事件记录"), { code: "TICKET_NOT_FOUND" });
        return ok(res, { replay: report });
      }

      if ((m = path.match(/^\/tickets\/([^/]+)\/cancel$/)) && req.method === "POST") {
        const body = await readJson(req);
        return ok(res, await service.cancelTicket({ ticketId: m[1], reason: body.reason, displacementId: body.displacementId, actor: body.actor, idempotencyKey: idemKey || body.idempotencyKey }));
      }
      if ((m = path.match(/^\/tickets\/([^/]+)\/reschedule$/)) && req.method === "POST") {
        const body = await readJson(req);
        return ok(res, await service.rescheduleTicket({ ticketId: m[1], toShiftId: body.toShiftId, reason: body.reason, displacementId: body.displacementId, actor: body.actor, idempotencyKey: idemKey || body.idempotencyKey }));
      }
      if ((m = path.match(/^\/tickets\/([^/]+)\/serve$/)) && req.method === "POST") {
        const body = await readJson(req);
        return ok(res, await service.markServed({ ticketId: m[1], actor: body.actor }));
      }
      if ((m = path.match(/^\/tickets\/([^/]+)$/)) && req.method === "GET") {
        const t = queries.getTicket(m[1]);
        if (!t) throw Object.assign(new Error("号票不存在"), { code: "TICKET_NOT_FOUND" });
        const shift = catalog.getShift(t.shiftId);
        return ok(res, {
          ticket: {
            ticketId: t.ticketId,
            ticketNo: t.ticketNo,
            shiftId: t.shiftId,
            window: shift?.window,
            date: shift?.date,
            itemCode: t.itemCode,
            status: t.status,
            priorities: t.priorities,
            identity: t.identity,
            history: t.history,
          },
        });
      }

      send(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "无此路由" } });
    } catch (err) {
      fail(res, err);
    }
  });

  return server;
}
