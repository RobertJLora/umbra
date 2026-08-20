import crypto from 'node:crypto';

const DEFAULT_SKEW_MS = 30_000;

function toBuffer(value) {
  return Buffer.from(String(value), 'utf8');
}

export function createSessionId() {
  return `sess_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function createNonce(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function createMac(sharedKey, message) {
  return crypto.createHmac('sha256', sharedKey).update(message).digest('hex');
}

export function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }

  const leftBuffer = toBuffer(left);
  const rightBuffer = toBuffer(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function validateTimestamp(rawTimestamp, now = Date.now(), maxSkewMs = DEFAULT_SKEW_MS) {
  const timestamp = Number(rawTimestamp);
  if (!Number.isFinite(timestamp)) {
    throw new Error('Missing or invalid timestamp.');
  }

  if (Math.abs(now - timestamp) > maxSkewMs) {
    throw new Error('Handshake timestamp is outside the allowed window.');
  }

  return timestamp;
}

export function buildHelloMessage(port, timestamp, nonce) {
  return `hello:${port}:${timestamp}:${nonce}`;
}

export function buildBindMessage(sessionId, clientNonce, serverNonce) {
  return `bind:${sessionId}:${clientNonce}:${serverNonce}`;
}

export function buildRegisterMessage(sessionId) {
  return `register:${sessionId}`;
}

export function validateHelloQuery({ port, searchParams, sharedKey, now = Date.now() }) {
  const timestamp = validateTimestamp(searchParams.get('ts'), now);
  const nonce = searchParams.get('nonce');
  const mac = searchParams.get('mac');

  if (!nonce || !mac) {
    throw new Error('Missing nonce or MAC in handshake query.');
  }

  const expected = createMac(sharedKey, buildHelloMessage(port, timestamp, nonce));
  if (!safeEqual(expected, mac)) {
    throw new Error('Invalid handshake MAC.');
  }

  return { timestamp, nonce };
}

export function createBindProof(sharedKey, sessionId, clientNonce, serverNonce) {
  return createMac(sharedKey, buildBindMessage(sessionId, clientNonce, serverNonce));
}

export function createRegisterProof(sharedKey, sessionId) {
  return createMac(sharedKey, buildRegisterMessage(sessionId));
}

export function validateBindProof({ sharedKey, sessionId, clientNonce, serverNonce, receivedProof }) {
  const expected = createBindProof(sharedKey, sessionId, clientNonce, serverNonce);
  return safeEqual(expected, receivedProof);
}
