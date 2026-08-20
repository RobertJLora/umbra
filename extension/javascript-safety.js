export const JAVASCRIPT_RESULT_MAX_CHARS = 200_000;

function asResultText(value) {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function decodeQueryValue(raw) {
  try {
    return decodeURIComponent(String(raw || '').replace(/\+/g, ' '));
  } catch {
    return String(raw || '');
  }
}

function queryValueLooksLikeSecret(text) {
  const matches = String(text || '').matchAll(/[?&][^=\s"'<>]+=([^&\s"'<>]{24,})/g);
  for (const match of matches) {
    const value = decodeQueryValue(match[1]);
    if (value.includes('||')) {
      continue;
    }
    if (/^[A-Za-z0-9_-]{24,}$/.test(value)) {
      return true;
    }
  }
  return false;
}

// The cookie jar as `document.cookie` actually returns it: two or more
// `name=value` pairs joined by "; ". The word-based tests below match the header
// name and the source text, neither of which appears in the return value, so
// reading document.cookie used to hand the whole jar straight back.
function looksLikeCookieJar(text) {
  const pairs = String(text || '')
    .split(/;\s*/)
    .filter((pair) => /^[A-Za-z0-9_.-]{1,64}=[^;]{4,}$/.test(pair.trim()));
  return pairs.length >= 2;
}

// Opaque bearer tokens. A JWT has its own structural test below; these are the
// issued-secret shapes that carry a recognisable prefix instead.
const TOKEN_PREFIX_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
];

export function looksLikeSensitiveResult(value) {
  const text = asResultText(value);
  if (!text) {
    return false;
  }
  if (/\bset-cookie\b/i.test(text)) {
    return true;
  }
  if (/\bcookies?\b\s*[:=]/i.test(text)) {
    return true;
  }
  if (/\bdocument\.cookie\b/i.test(text)) {
    return true;
  }
  if (looksLikeCookieJar(text)) {
    return true;
  }
  if (TOKEN_PREFIX_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  if (queryValueLooksLikeSecret(text)) {
    return true;
  }
  if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text)) {
    return true;
  }
  return false;
}

export function blockedSensitiveResult(value) {
  if (!looksLikeSensitiveResult(value)) {
    return null;
  }
  return {
    blocked: true,
    code: 'javascript_result_blocked',
    message: 'JavaScript result was blocked because it looks like a credential or query-string secret.',
  };
}

export function serializeJavascriptResult(value, maxChars = JAVASCRIPT_RESULT_MAX_CHARS) {
  const serialized = value === undefined ? 'null' : (asResultText(value) ?? 'null');
  const originalLength = serialized.length;
  const truncated = originalLength > maxChars;
  const text = truncated ? serialized.slice(0, maxChars) : serialized;
  const blocked = blockedSensitiveResult(truncated ? text : value) || blockedSensitiveResult(serialized);
  if (blocked) {
    const error = new Error(blocked.message);
    error.code = blocked.code;
    throw error;
  }
  if (truncated) {
    return {
      result: text,
      truncated: true,
      originalLength,
    };
  }
  return {
    result: value === undefined ? null : value,
    truncated: false,
    originalLength,
  };
}
