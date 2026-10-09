/** Safe, serializable evidence. Unknown means the operation may have reached the service. */
export type AppPlaneFailure = {
  category: 'transport' | 'authentication' | 'payment-action' | 'conflict' | 'incompatible' | 'machine' | 'local';
  code: string;
  retryable: boolean;
  certainty: 'rejected' | 'unknown';
  operationId?: string;
};
export type AppPlaneFreshness = {
  status: 'unknown' | 'refreshing' | 'fresh' | 'stale';
  error: AppPlaneFailure | null;
};
export class AppPlaneError extends Error implements AppPlaneFailure {
  readonly category: AppPlaneFailure['category'];
  readonly code: string;
  readonly retryable: boolean;
  readonly certainty: AppPlaneFailure['certainty'];
  readonly operationId?: string;
  toJSON(): AppPlaneFailure {
    return { category: this.category, code: this.code, retryable: this.retryable, certainty: this.certainty, ...(this.operationId ? { operationId: this.operationId } : {}) };
  }
  constructor(failure: AppPlaneFailure) {
    super(failure.code);
    this.name = 'AppPlaneError';
    this.category = failure.category;
    this.code = failure.code;
    this.retryable = failure.retryable;
    this.certainty = failure.certainty;
    if (failure.operationId) this.operationId = failure.operationId;
  }
}

/** Status/class evidence is supplied by the SDK adapter, never inferred from provider text. */
export function appPlaneFailure(error: unknown): AppPlaneError {
  if (error instanceof AppPlaneError) return error;
  const value = error as { name?: string; code?: string; status?: number; context?: { status?: number } } | null;
  const status = value?.context?.status ?? value?.status;
  if (value?.name === "AuthRetryableFetchError" && value.code === "account_storage_unavailable") return new AppPlaneError({ category: "local", code: "account_storage_unavailable", retryable: true, certainty: "unknown" });
  if (status === 401 || status === 403 || (value?.name === 'AuthApiError' || value?.name === 'AuthSessionMissingError') && status === 400) return new AppPlaneError({ category: 'authentication', code: 'authentication_required', retryable: false, certainty: 'rejected' });
  if (status === 402) return new AppPlaneError({ category: 'payment-action', code: 'payment_action_required', retryable: false, certainty: 'rejected' });
  if (status === 409) return new AppPlaneError({ category: 'conflict', code: 'operation_conflict', retryable: false, certainty: 'rejected' });
  if (status === 426) return new AppPlaneError({ category: 'incompatible', code: 'update_required', retryable: false, certainty: 'rejected' });
  if (value?.name === 'FunctionsFetchError' || value?.name === 'FunctionsRelayError' || value?.name === 'AuthRetryableFetchError' || !status || status >= 500 || status === 408 || status === 429) {
    return new AppPlaneError({ category: 'transport', code: 'service_unavailable', retryable: true, certainty: 'unknown' });
  }
  return new AppPlaneError({ category: 'machine', code: 'request_rejected', retryable: false, certainty: 'rejected' });
}


/** Public recovery codes only. Never infer a code from provider message text. */
export const CLOUD_RECOVERY_CODES = [
  'service_unavailable', 'authentication_required', 'payment_action_required',
  'hosted_not_entitled',
  'operation_conflict', 'update_required', 'request_rejected',
  'account_storage_unavailable', 'machine_snapshot_unavailable',
  'attempt_timeout', 'attempt_canceled', 'provision_timeout', 'attach_timeout',
  'daemon_ping_timeout', 'connection_lost', 'client_update_required',
  'machine_update_required', 'daemon_update_required',
] as const;
export type CloudRecoveryCode = typeof CLOUD_RECOVERY_CODES[number];
const recoveryCodes: ReadonlySet<string> = new Set(CLOUD_RECOVERY_CODES);
export function isCloudRecoveryCode(code: unknown): code is CloudRecoveryCode {
  return typeof code === 'string' && recoveryCodes.has(code);
}
export function cloudRecoveryCode(error: unknown): CloudRecoveryCode {
  const failure = appPlaneFailure(error);
  if (isCloudRecoveryCode(failure.code)) return failure.code;
  switch (failure.category) {
    case 'authentication': return 'authentication_required';
    case 'payment-action': return 'payment_action_required';
    case 'conflict': return 'operation_conflict';
    case 'incompatible': return 'update_required';
    case 'machine': return 'request_rejected';
    default: return 'service_unavailable';
  }
}
