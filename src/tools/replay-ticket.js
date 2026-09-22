#!/usr/bin/env node
/**
 * 票据重放/审计工具：
 *   node src/tools/replay-ticket.js <ticketId>
 *   node src/tools/replay-ticket.js --number W-G1-AM-001 --date 2026-10-08
 * 从事件日志重建全部状态后，打印该票据逐笔事件对号源的占用/释放解释。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../app.js";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const args = process.argv.slice(2);
const stateDir = process.env.STATE_DIR || path.join(root, ".state");

let ticketId = null;
let number = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--number") number = args[++i];
  else if (!args[i].startsWith("--")) ticketId = args[i];
}

const app = await buildApp({ root, stateDir });
try {
  if (!ticketId && number) {
    const found = [...app.service.projection.tickets.values()].find((t) => t.number === number);
    if (!found) fail(`找不到号序为 ${number} 的票据`);
    ticketId = found.ticketId;
  }
  if (!ticketId) fail("用法：node src/tools/replay-ticket.js <ticketId> 或 --number <号序>");

  const { ticket, trace } = app.service.replayTicket(ticketId);
  console.log(`票据 ${ticket.number}（${ticket.serviceName}）`);
  console.log(`窗口：${ticket.windowName} ${ticket.slotLabel} ${ticket.timeRange}　日期：${ticket.date}`);
  console.log(`办事人：${ticket.applicant}　优先：${ticket.priorityLabels.join("、") || "无"}　当前状态：${ticket.status}`);
  console.log("─".repeat(60));
  for (const step of trace) {
    console.log(`#${step.seq} ${step.at} ${step.type}`);
    console.log(`   ${step.explanation}`);
  }
} finally {
  await app.store.close();
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
