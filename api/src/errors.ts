export interface ErrorField {
  field: string;
  message: string;
}

/** 可安全返回给客户端的业务错误。 */
export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly fields?: ErrorField[];

  public constructor(statusCode: number, code: string, message: string, fields?: ErrorField[]) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.fields = fields;
  }
}

/** 创建字段校验错误。 */
export function validationError(field: string, message: string): ApiError {
  return new ApiError(400, "validation_error", message, [{ field, message }]);
}

/** 限制持久化和接口返回的错误文本长度，同时保留错误开头和最终数据库原因。 */
export function toSafeErrorMessage(error: unknown, fallback = "操作失败"): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  // 关键变量：超长 SQL 通常把真实数据库原因放在末尾，因此头尾都要保留。
  const maximumLength = 2_000;
  if (message.length <= maximumLength) return message;
  const retainedLength = 900;
  return `${message.slice(0, retainedLength)}\n……错误详情过长，已截断……\n${message.slice(-retainedLength)}`;
}
