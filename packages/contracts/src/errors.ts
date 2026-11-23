// Standard error codes and envelope (TS §9.1).
export const ERROR_STATUS = {
  VALIDATION_FAILED: 400, UNAUTHENTICATED: 401, MFA_REQUIRED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  VERSION_CONFLICT: 409, IDEMPOTENCY_KEY_REUSED: 409, INVALID_STATE_TRANSITION: 409, OVERLAP_CONFLICT: 409,
  OUTSIDE_DUTY_WINDOW: 409, GEOFENCE_REQUIRED: 409, TRACKING_NOT_AUTHORIZED: 409, CONFLICT: 409,
  NOTICE_NOT_ACKNOWLEDGED: 403, DEVICE_REVOKED: 403, DEVICE_NOT_APPROVED: 403, PLAN_LIMIT_REACHED: 403,
  TENANT_NOT_ACTIVE: 403, LEGAL_HOLD: 409,
  PAYLOAD_TOO_LARGE: 413, ACCOUNT_LOCKED: 423, UPGRADE_REQUIRED: 426, RATE_LIMITED: 429,
  INTERNAL: 500, DEPENDENCY_UNAVAILABLE: 503,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;

export interface FieldError { path: string; code: string; message: string }

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly extra: { fieldErrors?: FieldError[]; details?: Record<string, unknown>; retryAfterSec?: number } = {},
  ) {
    super(message ?? code);
    this.status = ERROR_STATUS[code];
  }
}
export const fail = (code: ErrorCode, message?: string, extra?: AppError['extra']): never => {
  throw new AppError(code, message, extra);
};
export const notFound = (what = 'Resource'): never => fail('NOT_FOUND', `${what} not found`);
