# 政务窗口预约分流服务

面向区政务服务中心的当日预约分流系统：导办员可实时查看每个窗口的真实余量，
把身份证明后的办事人、事项材料和可办理时段放入可调整队列；窗口临时停办或缩容时
自动挤出号源并生成改签/退号处置单；所有变化以追加事件落盘，可重放、可审计、可崩溃恢复。

仅使用 Node.js 内置能力（无第三方依赖），Node ≥ 20。

## 快速开始

```bash
npm start                 # 查看用法（首次运行会在 .state/ 初始化事件日志与 HMAC 密钥）
npm test                  # 运行全部测试（38 个用例）
node src/index.js server --port 7070   # 启动 HTTP 服务
node src/index.js board 2026-09-21     # 命令行查看当天窗口余量
node src/index.js replay T0002         # 重放单笔号的占用/释放轨迹
node src/index.js verify               # 校验事件日志哈希链
```

## 数据文件（脱敏 JSON）

| 文件 | 内容 |
| --- | --- |
| `data/catalog.json` | 事项目录：编码、时长、必备材料、可办窗口类型、可预约天数 |
| `data/shifts.json` | 窗口班次：窗口、日期、起止时刻、可办事项、容量、无障碍标记；跨零点夜班用 `crossMidnight` 标注，号源归入**开始日期** |
| `data/holidays.json` | 有效政策：法定节假日、调休上班日、周末规则 |

开放判定优先级：**调休上班日 > 法定节假日 > 普通周末规则**。
所有日期按北京时间（UTC+8）计算，容器运行时区不影响结果。

## 事件溯源模型

系统不保存可变状态快照，当前全部状态（队列顺序、取消/爽约/办结、容量、停办、
处置单、幂等记录）都由 `.state/events.log`（JSON Lines，逐条 `fsync`）重放得到：

- 每条事件带 `seq`、`prevHash`、`sha256` 哈希链；截断、篡改、乱序在启动校验时直接拒绝启动；
- 事件类型：`TicketIssued / TicketCancelled / TicketRescheduled / TicketDisplaced /
  TicketServed / TicketNoShowMarked / ShiftSuspended / ShiftResumed /
  CapacityChanged / QueueReordered`；
- 进程重启 = 重新装载静态 JSON + 重放事件，排队顺序与剩余容量与中断前一致；
- `GET /tickets/:id/replay` 可重放任意一笔取号，逐步解释它**为何占用或释放号源**
  （取号占用、挤出释放、改签迁移并再占位、退号/办结/爽约释放）。

## 关键业务规则

- **容量真实余量**：余量 = 当前有效容量 − 在队（ISSUED）号数；停办/节假日余量为 0 且不可订。
- **缩容/停办**：容量下调时按队列尾部（优先级最低、取号最晚）挤出超额号，生成 `D0001…`
  处置单；被挤出号改签或退号**必须关联处置单**，形成"原因 → 挤出 → 去向"完整链路。
- **爽约扫描**：`POST /system/sweep-no-shows`（建议傍晚定时调用）把已过结束时刻仍在队的号
  标记爽约并释放号源；跨零点夜班按次日凌晨的真实结束时刻判定。
- **优先队列**：老年（身份证年龄自动判定或申报）、家属代办、无障碍三类标记保留并影响
  入队位置（老年 > 无障碍 > 代办 > 普通，同级按取号先后）；人工调队只能重排在队号的
  排列，夹带增删/重复的请求在事件落盘前被拒绝。
- **重复预约拦截**：同一证件、同一天、同一事项只允许一笔有效预约（退号/办结/爽约后释放）。

## 抵抗重复点击与网络重试

- 请求携带 `Idempotency-Key` 头（或 body 字段）：同键同体重放首次结果，不重复占号/释放；
- 同键不同请求体返回 `IDEMPOTENCY_CONFLICT`；同键并发双击合并为同一个在途请求；
- 服务端所有写命令经进程内串行锁临界区处理，容量边界并发不会超卖；
- 幂等记录本身也写在事件里，重启后继续生效。

## 隐私最小化

- 原始证件号、完整姓名只在取号入口短暂出现，用于身份证 GB 11643 校验码核验与年龄判定；
- 落盘/出参仅有：HMAC-SHA256 假名（重启稳定、可跨事件关联但不可反推）、脱敏称呼
  （"张*"/"欧阳**"）、证件末四位、优先标记；
- HMAC 密钥为 `.state/hmac.key`（0600，首次自动生成），不进入事件日志；
- HTTP 层不记录请求体；事件数据做防御性脱敏后才出审计接口。

## HTTP 接口摘要

| 方法 路径 | 说明 |
| --- | --- |
| `GET /board?date=YYYY-MM-DD` | 当天全部窗口实时余量与队列 |
| `GET /shifts/:shiftId[?explain=1]` | 单窗口视图；`explain=1` 复盘容量变化与号源进出 |
| `POST /shifts/:id/suspend` `/resume` | 临时停办（自动挤出）/恢复 |
| `POST /shifts/:id/capacity` | 缩容/扩容，`{newCapacity, reason}` |
| `POST /queues/:id/reorder` | 导办员人工调队 |
| `POST /tickets` | 取号（建议带 `Idempotency-Key`） |
| `POST /tickets/:id/cancel` `/reschedule` `/serve` | 退号 / 改签 / 办结 |
| `GET /tickets/:id/replay` | 单笔占用/释放轨迹重放 |
| `GET /displacements` | 待处置（挤出未改签/退号）清单 |
| `POST /system/sweep-no-shows` | 爽约扫描释放号源 |
| `GET /audit/verify` | 事件日志哈希链校验 |

班次标识 `:shiftId` 形如 `2026-09-21#综合受理一号窗#MORNING`（URL 中需编码）。

## 目录结构

```
data/                 事项目录、班次、节假日政策（JSON）
src/
  util/time.js        北京时间日期/跨夜时刻计算
  security/privacy.js 身份证核验、HMAC 假名、脱敏
  store/event-log.js  追加事件日志（fsync + 哈希链）
  domain/
    calendar.js       节假日政策判定
    catalog.js        目录/班次装载
    state.js          事件投影（重放恢复）
    booking-service.js 命令服务（校验、幂等、串行化）
    query-service.js  只读看板
    audit.js          单笔重放/容量复盘/日志校验
  app.js server.js index.js
test/                 node:test 测试（38 个）
.state/               运行期产物（events.log、hmac.key），已 gitignore
```

> `fixtures/context.json` 为最初的脱敏交换样例；正式数据入口为 `data/` 目录。
