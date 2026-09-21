// 身份证明与最小化处理：
// - 仅在取号入口短暂接触原始证件信息，用于合法性校验；
// - 落盘与对外输出的只有 HMAC 假名、脱敏称呼、末四位和优先标记；
// - 原始证件号、完整姓名不进事件日志、不进内存日志、不进任何响应。
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ID_CARD_RE = /^\d{17}[\dXx]$/;

/** 加载（首次自动生成并持久化）HMAC 密钥，保证重启后假名稳定。 */
export function loadOrCreateHmacKey(keyPath) {
  if (existsSync(keyPath)) return readFileSync(keyPath);
  mkdirSync(dirname(keyPath), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyPath, key, { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* 某些文件系统不支持 chmod，写入权限已由 mode 控制 */
  }
  return key;
}

/** 18 位居民身份证校验（GB 11643 校验码）。 */
export function isValidIdCardNumber(num) {
  if (!ID_CARD_RE.test(num)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkCodes = "10X98765432";
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(num[i]) * weights[i];
  const expected = checkCodes[sum % 11];
  return expected === num[17].toUpperCase();
}

/** 从身份证号解析出生日期（仅用于自动判定老年优先，不落盘出生信息）。 */
export function birthFromIdCard(num) {
  return `${num.slice(6, 10)}-${num.slice(10, 12)}-${num.slice(12, 14)}`;
}

/** 计算周岁（以北京时间当前日期为准）。 */
export function ageOn(dateStr, birthDateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [by, bm, bd] = birthDateStr.split("-").map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}

/** HMAC-SHA256 假名：同一证件恒定、不同证件不可反推、不可枚举碰撞。 */
export function pseudonymize(idType, idNumber, key) {
  return createHmac("sha256", key)
    .update(`v1|${idType}|${String(idNumber).toUpperCase()}`)
    .digest("hex");
}

/** 姓名脱敏：保留姓氏（复姓取前两字），其余以 * 代替。 */
export function maskName(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  const compound = ["欧阳", "太史", "端木", "上官", "司马", "东方", "独孤", "南宫", "万俟", "闻人", "夏侯", "诸葛", "尉迟", "公羊", "赫连", "澹台", "皇甫", "宗政", "濮阳", "公冶", "太叔", "申屠", "公孙", "慕容", "仲孙", "钟离", "长孙", "宇文", "司徒", "鲜于", "司空", "闾丘", "子车", "亓官", "司寇", "巫马", "公西", "颛孙", "壤驷", "公良", "漆雕", "乐正", "宰父", "谷梁", "拓跋", "夹谷", "轩辕", "令狐", "段干", "百里", "呼延", "东郭", "南门", "羊舌", "微生", "公户", "公玉", "公仪", "梁丘", "公仲", "公上", "公门", "公山", "公坚", "左丘", "公伯", "西门", "公祖"];
  const surnameLen = n.length >= 3 && compound.includes(n.slice(0, 2)) ? 2 : 1;
  return n.slice(0, surnameLen) + "*".repeat(Math.max(1, n.length - surnameLen));
}

/** 证件号脱敏：仅保留末四位。 */
export function maskIdNumber(idNumber) {
  const tail = String(idNumber).slice(-4);
  return `****${tail}`;
}

/** 常量时间比较，防止假名/令牌比对被时序探测。 */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 处理入口的身份证明：校验合法性，产出可安全落盘的身份视图。
 * 输入 identity: { name, idType, idNumber }
 * 输入 flags:    { proxy, needAccessibility, declaredElderly }
 * 返回 { identity: {pseudonym, maskedName, idTail, idType}, priorities, rawAge }
 * 调用方拿到返回值后应丢弃原始输入引用。
 */
export function attestIdentity(identity, flags, key, todayDateStr) {
  const idType = identity.idType || "ID_CARD";
  const raw = String(identity.idNumber || "").trim();
  if (!raw) throw Object.assign(new Error("缺少证件号码"), { code: "IDENTITY_REQUIRED" });

  let isElderly = false;
  if (idType === "ID_CARD") {
    if (!isValidIdCardNumber(raw)) {
      throw Object.assign(new Error("居民身份证号校验未通过"), { code: "IDENTITY_INVALID" });
    }
    isElderly = ageOn(todayDateStr, birthFromIdCard(raw)) >= 60;
  }

  const priorities = {
    elderly: Boolean(flags.declaredElderly || isElderly),
    proxy: Boolean(flags.proxy), // 老年人/家属代办
    accessibility: Boolean(flags.needAccessibility), // 无障碍服务
  };

  return {
    identity: {
      pseudonym: pseudonymize(idType, raw, key),
      maskedName: maskName(identity.name),
      idTail: String(raw).slice(-4),
      idType,
    },
    priorities,
  };
}
