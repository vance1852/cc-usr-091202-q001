import { createServer } from "node:http";
import { DomainError } from "../domain/errors.js";
import { historyStats, dailyAggregate } from "../domain/stats.js";
import { localDateOf } from "../util/time.js";

const MAX_BODY = 64 * 1024;

/**
 * 纯 Node http 路由。
 * 若设置了 STAFF_TOKEN 环境变量，所有写操作要求 Authorization: Bearer <token>。
 * 网络重试请带 Idempotency-Key 头（也可放在请求体 idempotencyKey 字段）。
 */
export function createHttpServer(app) {
  const { service, catalog, calendar, history } = app;

  const routes = [
    { method: "GET", pattern: "/api/catalog", readonly: true, handler: () => catalog.listCatalog() },
    { method: "GET", pattern: "/api/calendar", readonly: true, handler: (c) => ({ date: c.query.get("date"), ...calendar.inspect(c.query.get("date") ?? localDateOf()) }) },
    {
      method: "GET",
      pattern: "/api/overview",
      readonly: true,
      handler: (c) => service.overview(c.query.get("date") ?? localDateOf()),
    },
    {
      method: "GET",
      pattern: "/api/daily",
      readonly: true,
      handler: (c) => dailyAggregate(service, c.query.get("date") ?? localDateOf()),
    },
    {
      method: "GET",
      pattern: "/api/history/stats",
      readonly: true,
      handler: () => historyStats(history),
    },
    {
      method: "GET",
      pattern: "/api/queues/:date/:windowId/:slotId",
      readonly: true,
      handler: (c) => service.queue(c.params.date, c.params.windowId, c.params.slotId),
    },
    { method: "POST", pattern: "/api/tickets", handler: (c) => service.book(c.body) },
    { method: "POST", pattern: "/api/tickets/:id/reschedule", handler: (c) => service.reschedule({ ...c.body, ticketId: c.params.id }) },
    { method: "POST", pattern: "/api/tickets/:id/cancel", handler: (c) => service.cancel({ ...c.body, ticketId: c.params.id }) },
    { method: "POST", pattern: "/api/tickets/:id/serve", handler: (c) => service.markServed({ ...c.body, ticketId: c.params.id }) },
    { method: "GET", pattern: "/api/tickets/:id/replay", readonly: true, handler: (c) => service.replayTicket(c.params.id) },
    { method: "GET", pattern: "/api/tickets/:id", readonly: true, handler: (c) => service.ticket(c.params.id) },
    { method: "POST", pattern: "/api/admin/shrink", handler: (c) => service.shrinkCapacity(c.body) },
    { method: "POST", pattern: "/api/admin/restore", handler: (c) => service.restoreCapacity(c.body) },
    { method: "POST", pattern: "/api/admin/sweep-no-show", handler: (c) => service.sweepNoShow(c.body) },
    {
      method: "GET",
      pattern: "/api/admin/events",
      readonly: true,
      handler: async (c) => ({ events: await service.eventStream({ sinceSeq: Number(c.query.get("sinceSeq") ?? 0) }) }),
    },
  ].map((r) => ({ ...r, re: compile(r.pattern) }));

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!route) return send(res, 404, { error: { code: "NOT_FOUND", message: "接口不存在" } });

      if (!route.readonly && process.env.STAFF_TOKEN && req.headers.authorization !== `Bearer ${process.env.STAFF_TOKEN}`) {
        return send(res, 401, { error: { code: "UNAUTHORIZED", message: "写操作需要工作人员令牌" } });
      }

      let body = {};
      if (req.method === "POST") {
        body = await readJsonBody(req);
        const idem = req.headers["idempotency-key"];
        if (idem && !body.idempotencyKey) body.idempotencyKey = String(idem);
      }
      const match = url.pathname.match(route.re);
      const result = await route.handler({ query: url.searchParams, body, params: match?.groups ?? {} });
      send(res, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof DomainError) {
        return send(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
      }
      if (err instanceof SyntaxError) {
        return send(res, 400, { error: { code: "BAD_JSON", message: "请求体不是合法 JSON 对象" } });
      }
      console.error("unhandled", err);
      send(res, 500, { error: { code: "INTERNAL", message: "服务内部错误" } });
    }
  });
}

function compile(pattern) {
  const source =
    "^" +
    pattern
      .split("/")
      .map((seg) => (seg.startsWith(":") ? `(?<${seg.slice(1)}>[^/]+)` : seg))
      .join("/") +
    "$";
  return new RegExp(source);
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new DomainError("BODY_TOO_LARGE", "请求体超过 64KB", { status: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new SyntaxError("body must be object");
  return json;
}

function send(res, status, payload) {
  const buf = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": buf.length });
  res.end(buf);
}
