// 入口：
//   node src/index.js server [--port 7070]   启动 HTTP 服务
//   node src/index.js board [date]            查看当天窗口余量
//   node src/index.js replay <ticketId>       重放单笔取号
//   node src/index.js verify                  校验事件日志
//   node src/index.js help
import { resolve } from "node:path";
import { createApp } from "./app.js";
import { createHttpServer } from "./server.js";
import { replayTicket, verifyLog } from "./domain/audit.js";
import { todayCst } from "./util/time.js";

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const app = await createApp({ stateDir: resolve(".state") });
  try {
    switch (command) {
      case "server": {
        const portIdx = rest.indexOf("--port");
        const port = Number(portIdx >= 0 ? rest[portIdx + 1] : process.env.PORT || 7070);
        const server = createHttpServer(app);
        server.listen(port, () => {
          console.log(`政务预约分流服务已启动：http://localhost:${port}（今日 ${todayCst()}，已重放事件 ${app.eventCount} 条）`);
        });
        const shutdown = () => {
          server.close(() => {
            app.close();
            process.exit(0);
          });
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        break;
      }
      case "board": {
        const date = rest[0] || todayCst();
        print({ date, windows: app.queries.dailyBoard(date) });
        break;
      }
      case "replay": {
        if (!rest[0]) throw new Error("用法：replay <ticketId>");
        const report = replayTicket(app.log.readAll(), rest[0]);
        if (!report) throw new Error(`未找到号票 ${rest[0]} 的任何事件`);
        print(report);
        break;
      }
      case "verify":
        print(verifyLog(app.log.filePath));
        break;
      default:
        console.log([
          "政务服务预约分流系统",
          "",
          "用法：",
          "  node src/index.js server [--port 7070]  启动 HTTP 服务",
          "  node src/index.js board [YYYY-MM-DD]     查看窗口实时余量",
          "  node src/index.js replay <ticketId>      重放单笔取号的占用/释放过程",
          "  node src/index.js verify                 校验事件日志哈希链",
        ].join("\n"));
    }
  } finally {
    if (command !== "server") app.close();
  }
}

main().catch((err) => {
  console.error(`启动失败：${err.message}`);
  process.exit(1);
});
