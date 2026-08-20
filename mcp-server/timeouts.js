// Shared timeout arithmetic for every transport lane.
//
// Two helpers with deliberately opposite jobs:
//
// `resolveBrokerRequestTimeoutMs` decides how long a single command may take.
// It raises a caller's value to the configured floor, adds slack so the
// transport outlives the extension-side deadline it is waiting on, and caps the
// result. It is the right helper when one command owns the whole budget.
//
// `resolveChildCallTimeoutMs` divides an existing budget among the children of
// a batch or composite. It only ever clamps downward, because a child that
// outlives its parent's remaining budget reports its own timeout after the
// parent has already given up, which is how a composite returns `batch_timeout`
// on the step that carries the payload.

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const COMMAND_TIMEOUT_SLACK_MS = 5_000;
export const MAX_COMMAND_TIMEOUT_MS = 185_000;
export const MIN_CHILD_CALL_TIMEOUT_MS = 1_000;

function positiveInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

export function resolveBrokerRequestTimeoutMs(requestTimeoutMs, params = {}) {
  const floor = positiveInt(requestTimeoutMs) ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const toolTimeoutMs = positiveInt(params?.timeoutMs);
  if (toolTimeoutMs === null) {
    return floor;
  }
  return Math.min(Math.max(floor, toolTimeoutMs + COMMAND_TIMEOUT_SLACK_MS), MAX_COMMAND_TIMEOUT_MS);
}

// Returns the smaller of the remaining parent budget and the child's own
// requested timeout, never below MIN_CHILD_CALL_TIMEOUT_MS. Passing a null or
// absent `requestedMs` fills the child's timeout from the remaining budget.
// Returns null only when neither value is usable, which means the caller should
// leave the child's timeout unset and let the lane default apply.
export function resolveChildCallTimeoutMs(remainingMs, requestedMs) {
  const remaining = positiveInt(remainingMs);
  const requested = positiveInt(requestedMs);
  if (remaining === null && requested === null) {
    return null;
  }
  if (remaining === null) {
    return Math.max(MIN_CHILD_CALL_TIMEOUT_MS, requested);
  }
  if (requested === null) {
    return Math.max(MIN_CHILD_CALL_TIMEOUT_MS, remaining);
  }
  return Math.max(MIN_CHILD_CALL_TIMEOUT_MS, Math.min(remaining, requested));
}
