import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBindMessage,
  buildHelloMessage,
  buildRegisterMessage,
  createBindProof,
  createMac,
  createRegisterProof,
  safeEqual,
  validateBindProof,
  validateHelloQuery,
} from '../../mcp-server/auth.js';

test('safeEqual rejects unequal values', () => {
  assert.equal(safeEqual('a', 'a'), true);
  assert.equal(safeEqual('a', 'b'), false);
  assert.equal(safeEqual('short', 'longer'), false);
});

test('validateHelloQuery accepts a valid HMAC query', () => {
  const sharedKey = 'test-shared-key';
  const port = 47821;
  const timestamp = Date.now();
  const nonce = 'abc123';
  const mac = createMac(sharedKey, buildHelloMessage(port, timestamp, nonce));
  const searchParams = new URLSearchParams({
    ts: String(timestamp),
    nonce,
    mac,
  });

  const result = validateHelloQuery({ port, searchParams, sharedKey, now: timestamp });
  assert.equal(result.nonce, nonce);
  assert.equal(result.timestamp, timestamp);
});

test('validateHelloQuery rejects a forged HMAC query', () => {
  const sharedKey = 'test-shared-key';
  const searchParams = new URLSearchParams({
    ts: String(Date.now()),
    nonce: 'abc123',
    mac: 'forged',
  });

  assert.throws(
    () => validateHelloQuery({ port: 47821, searchParams, sharedKey, now: Date.now() }),
    /Invalid handshake MAC/,
  );
});

test('validateBindProof accepts matching proof', () => {
  const sharedKey = 'test-shared-key';
  const sessionId = 'sess_123';
  const clientNonce = 'client';
  const serverNonce = 'server';
  const proof = createBindProof(sharedKey, sessionId, clientNonce, serverNonce);

  assert.equal(
    validateBindProof({
      sharedKey,
      sessionId,
      clientNonce,
      serverNonce,
      receivedProof: proof,
    }),
    true,
  );
  assert.equal(
    proof,
    createMac(sharedKey, buildBindMessage(sessionId, clientNonce, serverNonce)),
  );
});

test('validateBindProof rejects mismatched proof', () => {
  assert.equal(
    validateBindProof({
      sharedKey: 'test-shared-key',
      sessionId: 'sess_123',
      clientNonce: 'client',
      serverNonce: 'server',
      receivedProof: 'wrong',
    }),
    false,
  );
});

test('createRegisterProof is an HMAC over the session id', () => {
  const sharedKey = 'test-shared-key';
  const sessionId = 'sess_shared';
  const proof = createRegisterProof(sharedKey, sessionId);
  assert.equal(proof, createMac(sharedKey, buildRegisterMessage(sessionId)));
  assert.notEqual(createRegisterProof(sharedKey, 'sess_other'), proof);
});
