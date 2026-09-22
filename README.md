# 政务窗口预约分流服务

面向区政务服务中心当天场景的 Node.js 预约分流服务：导办员可实时查看每个窗口时段的真实余量，
把身份核验后的办事人、事项材料和可办理时段放进一条可调整队列；窗口缩容/临时停办时留下改签、
退号的完整来龙去脉；任意一笔取号都可以逐事件重放核对。

## 设计要点

- **事件溯源（event sourcing）**：取号、改签、退号、办结、爽约、容量调整都是 `.state/events.log`
  里不可变的 JSONL 事件，批量写入后 `fsync`。没有第二份易失数据库，进程重启靠整卷重放恢复
  排队顺序、取消状态和剩余容量；日志末尾写坏时自动截断到最后一个完整事件并另存 `.corrupt`。
- **有效政策日历**（`data/holidays.json`）：法定节假日整日不开放，调休上班的周末照常开放；
  以正式发布的国务院办公厅放假安排为准，数据文件可逐年替换。
- **跨日窗口**：如 21:00–次日 01:30 的夜间窗，号源归属**开班当日**，结束判断按次日凌晨计算。
- **抗重复点击/网络重试**：
  - 写接口支持 `Idempotency-Key`（请求头或请求体 `idempotencyKey`），同键并发重试只落一笔；
  - 同一办事人（`applicantRef`）同一事项同一日期只允许一个有效预约，重复提交返回 409 并附原票号；
  - 单进程命令串行锁保证"校验→落盘→投影"原子。
- **缩容/停办处置**：容量调到 `to`（0 即停办），超出容量的队列**从队尾挤压**；
  老年人代办、无障碍服务的优先号受保护（先挤普通号队尾，不够才动优先号）。
  被挤出的票变为 `displaced`，必须改签或退号；容量恢复不自动回队，由导办员逐笔处置，全程可查。
- **隐私最小化**：服务只收身份核验网关签发的一次性不透明令牌 `applicantRef`，
  显式拒绝身份证号、姓名、手机号等字段（含字符串内嵌的 18 位证件号），对外只显示 `ref_` 短指纹；
  优先标记只保留 `elderlyProxy` / `accessibility` 两个布尔位，不携带身份细节。
- **爽约收号**：`/api/admin/sweep-no-show` 把已结束时段仍在排队的票批量记为爽约并释放号源，
  历史爽约率见 `/api/history/stats`。

## 数据文件

| 文件 | 内容 |
| --- | --- |
| `data/services.json` | 事项目录（编码、受理时长、必备材料） |
| `data/windows.json` | 窗口班次（时段、容量、跨日标记、可办事项） |
| `data/holidays.json` | 节假日区间与调休上班日 |
| `data/history.json` | 脱敏历史取号记录（仅用于峰谷/爽约统计） |

运行态事件日志写入 `.state/`（已 gitignore）。

## 运行

```bash
npm start          # 启动 HTTP 服务，默认 8080（PORT 可改）
npm test           # 27 项测试
npm run check      # 数据自检
```

写操作可设置 `STAFF_TOKEN` 环境变量启用 `Authorization: Bearer` 校验。

## HTTP 接口

| 方法 路径 | 说明 |
| --- | --- |
| `GET /api/overview?date=YYYY-MM-DD` | 当天各窗口时段真实余量、政策、停办/结束标记 |
| `GET /api/daily?date=...` | 当日汇总（总容量/余量/挤出/爽约） |
| `GET /api/catalog` | 事项目录与窗口班次 |
| `GET /api/calendar?date=...` | 某日开放/关闭及政策原因 |
| `GET /api/history/stats` | 历史峰谷、爽约率 |
| `GET /api/queues/:date/:windowId/:slotId` | 在排队列（含顺序）与待处置的挤出票 |
| `GET /api/tickets/:id` | 票据详情（材料缺口、优先标记） |
| `GET /api/tickets/:id/replay` | **逐笔重放**：每个事件为何占用/释放号源 |
| `POST /api/tickets` | 取号（可只给事项+日期，自动分流到余量最多的时段） |
| `POST /api/tickets/:id/reschedule` | 改签（displaced 票也走这里） |
| `POST /api/tickets/:id/cancel` | 退号 |
| `POST /api/tickets/:id/serve` | 窗口叫号办结 |
| `POST /api/admin/shrink` | 缩容/临时停办，自动队尾挤压 |
| `POST /api/admin/restore` | 容量恢复（不自动回队） |
| `POST /api/admin/sweep-no-show` | 傍晚爽约批量收号 |
| `GET /api/admin/events?sinceSeq=0` | 事件流审计 |

取号请求示例：

```json
{
  "applicantRef": "身份核验网关签发的不透明令牌",
  "serviceCode": "JZZ-QZ-02",
  "date": "2026-10-08",
  "priority": { "elderlyProxy": true },
  "materials": ["身份证", "居住证", "住所证明"]
}
```

命令行重放：

```bash
node src/tools/replay-ticket.js TK_xxxxxxxxxxxx
node src/tools/replay-ticket.js --number W-G1-AM-001
```

## 票据状态

`queued`（在排队列）→ `served`（办结）／`no-show`（爽约）；
缩容挤出进入 `displaced`（待改签或退号）；改签回到目标时段队尾；退号为 `cancelled`。
所有转换及原因都保存在票据事件链上。
