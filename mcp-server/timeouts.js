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
// The largest deadline a browser_batch may declare.
//
// The old ceiling multiplied the configured request timeout by the 25-call
// maximum whatever the batch actually held, so a single-call batch could
// legitimately hold an MCP client for 25 minutes. Bounding it by the per-command
// cap times the real call count keeps the worst case proportional to the work.
export function maxBatchTimeoutMs(requestTimeoutMs, callCount, maxCalls = 25) {
  const floor = positiveInt(requestTimeoutMs) ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const calls = Math.max(1, positiveInt(callCount) ?? 1);
  return Math.min(floor * maxCalls, MAX_COMMAND_TIMEOUT_MS * calls);
}

// How long the transport waits for one child of a batch or composite.
//
// The slack exists so the transport outlives the extension-side deadline it is
// waiting on. Adding a flat five seconds to a one-second budget made the
// smallest enforceable batch deadline six seconds, so a batch declaring 1,000 ms
// blocked its caller for 6,001 ms. The slack now scales with the budget and only
// reaches its full value once the budget is large enough to justify it.
export function resolveTransportTimeoutMs(budgetMs, ceilingMs) {
  const budget = positiveInt(budgetMs);
  const ceiling = positiveInt(ceilingMs) ?? MAX_COMMAND_TIMEOUT_MS;
  if (budget === null) {
    return ceiling;
  }
  const slack = Math.min(COMMAND_TIMEOUT_SLACK_MS, Math.max(250, Math.round(budget / 4)));
  return Math.max(1, Math.min(ceiling, budget + slack));
}

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
