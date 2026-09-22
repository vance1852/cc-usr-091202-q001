export class DomainError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export const notFound = (what) =>
  new DomainError("NOT_FOUND", `${what}不存在`, { status: 404 });

export const conflict = (code, message, details) =>
  new DomainError(code, message, { status: 409, details });
