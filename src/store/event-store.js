import { mkdir, open, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * 仅追加事件日志（JSON Lines）。
 * - 每行一个不可变事件：{id, seq, type, at, payload}
 * - append 经 O_APPEND 写入并 fsync，进程崩溃/断电后已确认的取号不会丢
 * - 重启时整卷重放重建状态，不依赖任何易失缓存
 */
export class EventStore {
  #fh = null;
  #seq = 0;
  #chain = Promise.resolve();

  constructor({ dir }) {
    this.dir = dir;
    this.file = path.join(dir, "events.log");
  }

  async start() {
    await mkdir(this.dir, { recursive: true });
    this.#fh = await open(this.file, "a");
    const lines = await this.#readLines();
    for (const line of lines) this.#seq = Math.max(this.#seq, line.seq ?? 0);
    return lines;
  }

  async #readLines() {
    if (!existsSync(this.file)) return [];
    const raw = await readFile(this.file, "utf8");
    const out = [];
    const parts = raw.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i].trim();
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        // 末尾半行（断电瞬间写坏）：截断到最后一个完整事件，坏行另存为 .corrupt 供排查
        const good = parts.slice(0, i).join("\n");
        await rename(this.file, `${this.file}.corrupt`);
        const fh = await open(this.file, "w");
        if (good) await fh.writeFile(good + "\n");
        await fh.sync();
        await fh.close();
        this.#fh = await open(this.file, "a");
        return out;
      }
      out.push(ev);
    }
    return out;
  }

  /** 串行化所有写操作：校验与落盘之间不会插入另一笔命令（抗并发重复点击的最后一道闸） */
  commit(type, payload, meta = {}) {
    return this.commitBatch([{ type, payload, at: meta.at }]);
  }

  /** 一批事件一次 write + fsync，保证缩容这类多事件命令的原子性 */
  commitBatch(items) {
    const run = async () => {
      const at = new Date().toISOString();
      const events = items.map((it) => ({
        id: `ev_${randomBytes(9).toString("hex")}`,
        seq: ++this.#seq,
        type: it.type,
        at: it.at ?? at,
        payload: it.payload,
      }));
      const line = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await this.#fh.appendFile(line);
      await this.#fh.sync();
      return events;
    };
    const result = this.#chain.then(
      () => run(),
      () => run()
    );
    this.#chain = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  /** 管理端整卷读取（重放/审计） */
  async readAll() {
    return this.#readLines();
  }

  async close() {
    await this.#chain;
    await this.#fh?.close();
    this.#fh = null;
  }
}
