// Test fixture: HTTP server + minimal WebSocket echo, listens on $PORT.
// Appends a line to $STARTS_FILE on every start; allocates $ALLOC_MB to inflate RSS.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const port = Number(process.env.PORT);
if (process.env.STARTS_FILE) fs.appendFileSync(process.env.STARTS_FILE, `${process.pid}\n`);
const ballast = process.env.ALLOC_MB ? Buffer.alloc(Number(process.env.ALLOC_MB) * 1024 * 1024, 1) : null;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`ok ${req.url} pid=${process.pid}${ballast ? '' : ''}`);
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('data', (buf) => {
    // decode one masked client text frame (<126 bytes) and echo unmasked
    const len = buf[1] & 0x7f;
    const mask = buf.subarray(2, 6);
    const payload = Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4]));
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  });
  socket.on('error', () => {});
});

setTimeout(() => server.listen(port, '127.0.0.1'), Number(process.env.BOOT_DELAY_MS || 0));
process.on('SIGTERM', () => process.exit(0));
