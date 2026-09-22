import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildApp } from "./app.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = await buildApp({ root });
await app.store.close();

if (process.argv.includes("--help")) {
  console.log("政务预约分流服务：npm start 启动 HTTP 服务，npm test 运行测试");
} else {
  const ctx = JSON.parse(await readFile(path.join(root, "fixtures", "context.json"), "utf8"));
  console.log(
    `数据自检通过：事项 ${app.catalog.services.size} 项、窗口 ${app.catalog.windows.size} 个、` +
      `事件日志重放 ${app.replayed} 条；现场样例 ${ctx.records.length} 条（${ctx.domain}）`
  );
}
