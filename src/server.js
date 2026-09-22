import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { createHttpServer } from "./http/server.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT ?? 8080);
const stateDir = process.env.STATE_DIR || path.join(root, ".state");

const app = await buildApp({ root, stateDir });
const server = createHttpServer(app);

server.listen(port, () => {
  console.log(
    `政务预约分流服务已启动：http://localhost:${port}（重放事件 ${app.replayed} 条，状态目录 ${stateDir}）`
  );
});

const shutdown = async () => {
  server.close();
  await app.store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
