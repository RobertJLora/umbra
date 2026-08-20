// Loopback Host-header allowlist for the local /healthz and /bridge listeners.
// DNS-rebinding keeps the original Host (attacker.com) after the name is
// pointed at 127.0.0.1; refusing anything other than a loopback name keeps
// that response unreadable to the page. doctor dials 127.0.0.1, which stays
// accepted.

const LOOPBACK_EXACT = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHostHeader(host) {
  const raw = String(host || '').trim().toLowerCase();
  if (!raw) {
    return false;
  }
  if (LOOPBACK_EXACT.has(raw)) {
    return true;
  }

  const withPort = raw.match(/^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/);
  return Boolean(withPort);
}
