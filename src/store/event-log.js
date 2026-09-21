// 追加写事件日志（JSON Lines）：
// - 每条事件 fsync 落盘，进程崩溃也不丢已确认的取号/退号；
// - 哈希链（prevHash/sha256）保证重放时能发现截断、篡改、乱序；
// - 只追加、永不原地修改；所有状态由重放事件得到。
import { createHash } from "node:crypto";
import {
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  mkdirSync,
  readFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";

const GENESIS = "0".repeat(64);

function eventHash(e) {
  // 不含 hash 字段本身的规范序列化
  const canon = JSON.stringify({
    seq: e.seq,
    ts: e.ts,
    type: e.type,
    data: e.data,
    meta: e.meta ?? {},
    prevHash: e.prevHash,
  });
  return createHash("sha256").update(canon).digest("hex");
}

export class EventLog {
  constructor(filePath, { now = () => new Date().toISOString() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.fd = null;
    this.seq = 0;
    this.tailHash = GENESIS;
  }

  open() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    if (existsSync(this.filePath)) {
      const events = this.readAll();
      if (events.length > 0) {
        this.seq = events[events.length - 1].seq;
        this.tailHash = events[events.length - 1].hash;
      }
    }
    this.fd = openSync(this.filePath, "a");
    return this;
  }

  close() {
    if (this.fd !== null) {
      fsyncSync(this.fd);
      closeSync(this.fd);
      this.fd = null;
    }
  }

  /** 追加一条事件并 fsync；返回带序号与哈希的完整事件。 */
  append(type, data = {}, meta = {}) {
    if (this.fd === null) throw new Error("事件日志未打开");
    const event = {
      seq: this.seq + 1,
      ts: this.now(),
      type,
      data,
      meta,
      prevHash: this.tailHash,
    };
    event.hash = eventHash(event);
    const line = JSON.stringify(event) + "\n";
    // 单次 write 对常规管道（O_APPEND 常规文件）具备原子性，再 fsync 保证持久性
    writeSync(this.fd, line);
    fsyncSync(this.fd);
    this.seq += 1;
    this.tailHash = event.hash;
    return event;
  }

  /** 读取并校验全部事件（哈希链 + 序号连续性）。 */
  readAll() {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, "utf8");
    if (!raw) return [];
    const lines = raw.split("\n");
    const events = [];
    let prev = GENESIS;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch (err) {
        throw new Error(`事件日志第 ${i + 1} 行不是合法 JSON（可能截断损坏）: ${err.message}`);
      }
      if (e.seq !== events.length + 1) {
        throw new Error(`事件日志序号断裂：第 ${i + 1} 行 seq=${e.seq}，期望 ${events.length + 1}`);
      }
      if (e.prevHash !== prev) {
        throw new Error(`事件日志哈希链断裂：seq=${e.seq} 的 prevHash 不匹配`);
      }
      const expected = eventHash(e);
      if (e.hash !== expected) {
        throw new Error(`事件日志内容校验失败：seq=${e.seq} 哈希不一致（疑似被篡改或损坏）`);
      }
      prev = e.hash;
      events.push(e);
    }
    return events;
  }

  /**
   * 压缩（仅运维场景）：重写为新文件并原子改名。
   * 本系统默认不压缩，保留完整来龙去脉；保留方法以便归档。
   */
  rewrite(events) {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    let fd = openSync(tmp, "w");
    try {
      for (const e of events) {
        writeSync(fd, JSON.stringify(e) + "\n");
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.filePath);
  }
}
