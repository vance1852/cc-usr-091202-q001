import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";

/**
 * 隐私最小化：
 * - 系统只持有办事人在身份核验环节后拿到的一次性不透明令牌 applicantRef
 *   （由身份核验网关签发，本服务无法据其还原身份证号/姓名）。
 * - API 显式拒绝身份证号、姓名、手机号等直接身份字段，防止身份信息扩散进事件日志。
 * - 优先标记只保留服务所需的最小集合（elderlyProxy 老年人代办 / accessibility 无障碍），
 *   不附带诊断、证件类型等细节。
 */

const REF_RE = /^[A-Za-z0-9_-]{8,64}$/;

const FORBIDDEN_FIELDS = [
  "idCard",
  "idNumber",
  "idCardNo",
  "identityNumber",
  "realName",
  "fullName",
  "name",
  "phone",
  "mobile",
  "tel",
];

export function assertNoIdentityLeak(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return;
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_FIELDS.includes(key)) {
      throw new DomainError(
        "IDENTITY_FIELD_REJECTED",
        `字段 ${key} 属于直接身份信息，本服务只接收身份核验后的 applicantRef 令牌`,
        { status: 422 }
      );
    }
    const v = body[key];
    if (typeof v === "string" && /(^|\D)\d{17}[\dXx](\D|$)/.test(v)) {
      throw new DomainError(
        "IDENTITY_VALUE_REJECTED",
        `字段 ${key} 的内容疑似身份证号，已拒绝写入`,
        { status: 422 }
      );
    }
    if (v && typeof v === "object") assertNoIdentityLeak(v);
  }
}

export function parseApplicantRef(value) {
  if (typeof value !== "string" || !REF_RE.test(value)) {
    throw new DomainError(
      "INVALID_APPLICANT_REF",
      "applicantRef 应为身份核验网关签发的不透明令牌（8-64 位字母数字 _-）"
    );
  }
  return value;
}

export const PRIORITY_FLAGS = Object.freeze({
  elderlyProxy: "老年人代办",
  accessibility: "无障碍服务",
});

export function sanitizePriority(input = {}) {
  const out = {};
  for (const key of Object.keys(PRIORITY_FLAGS)) {
    if (input[key] === true) out[key] = true;
  }
  return out;
}

export function hasPriority(flags = {}) {
  return Boolean(flags.elderlyProxy || flags.accessibility);
}

/** 对外展示的掩码：不泄露完整令牌，只保留可核对的短指纹 */
export function maskRef(ref) {
  const h = createHash("sha256").update(ref).digest("hex").slice(0, 10);
  return `ref_${h}`;
}
