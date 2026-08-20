import net from 'node:net';

const socketPath = process.env.UMBRA_BROKER_SOCKET || '/tmp/umbra-rust-broker.sock';
const timeoutMs = Number(process.env.UMBRA_BROKER_CHECK_TIMEOUT_MS || 1000);

const socket = net.createConnection(socketPath);
let buffer = '';
let settled = false;

const finish = (code) => {
  if (settled) {
    return;
  }
  settled = true;
  socket.destroy();
  process.exit(code);
};

const timer = setTimeout(() => finish(1), timeoutMs);
timer.unref?.();

socket.setEncoding('utf8');
socket.once('connect', () => {
  socket.write(`${JSON.stringify({ type: 'health', id: 'health_check' })}\n`);
});
socket.on('data', (chunk) => {
  buffer += chunk;
  const newlineIndex = buffer.indexOf('\n');
  if (newlineIndex < 0) {
    return;
  }
  const line = buffer.slice(0, newlineIndex);
  try {
    const message = JSON.parse(line);
    clearTimeout(timer);
    finish(message?.ok === true ? 0 : 1);
  } catch {
    finish(1);
  }
});
socket.once('error', () => finish(1));
socket.once('close', () => finish(1));

