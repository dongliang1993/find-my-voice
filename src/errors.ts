export class DomainError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400, public details?: Record<string, unknown>) {
    super(message);
  }
}

export function errorPayload(error: unknown) {
  if (error instanceof DomainError) return { code: error.code, message: error.message, ...error.details };
  // Do not expose upstream request objects, credentials or raw validation inputs.
  return { code: 'INTERNAL_ERROR', message: '服务内部错误，请根据请求 ID 检查本地日志。' };
}
