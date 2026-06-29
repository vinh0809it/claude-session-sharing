const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'client', 'dist');
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const reqExt = path.extname(url.pathname);
  let filePath = path.join(DIST, url.pathname === '/' ? 'index.html' : url.pathname);

  if (!fs.existsSync(filePath)) {
    if (reqExt) { res.writeHead(404); res.end('Not found'); return; }
    filePath = path.join(DIST, 'index.html'); // SPA fallback
  }

  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }
  if (fs.existsSync(DIST)) {
    serveStatic(req, res);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Claude Session Sharing — Signaling Server');
  }
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

wss.on('connection', (ws) => {
  let roomCode = null;
  let role = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create': {
        let code;
        do { code = generateCode(); } while (rooms.has(code));
        rooms.set(code, { sender: ws, receiver: null, createdAt: Date.now() });
        roomCode = code;
        role = 'sender';
        ws.send(JSON.stringify({ type: 'created', code }));
        console.log(`[${code}] Room created`);
        break;
      }
      case 'join': {
        const code = msg.code?.toUpperCase();
        const room = rooms.get(code);
        if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Code not found' })); return; }
        if (room.receiver) { ws.send(JSON.stringify({ type: 'error', message: 'Room is full' })); return; }
        room.receiver = ws;
        roomCode = code;
        role = 'receiver';
        ws.send(JSON.stringify({ type: 'joined', code }));
        room.sender.send(JSON.stringify({ type: 'receiver-joined' }));
        console.log(`[${code}] Receiver joined`);
        break;
      }
      case 'signal': {
        const room = rooms.get(roomCode);
        if (!room) return;
        const target = role === 'sender' ? room.receiver : room.sender;
        if (target?.readyState === 1) target.send(JSON.stringify({ type: 'signal', data: msg.data }));
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    const other = role === 'sender' ? room.receiver : room.sender;
    if (other?.readyState === 1) other.send(JSON.stringify({ type: 'peer-disconnected' }));
    rooms.delete(roomCode);
    console.log(`[${roomCode}] Room closed`);
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
});

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.createdAt < cutoff) { rooms.delete(code); console.log(`[${code}] Room expired`); }
  }
}, 60_000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Signaling server on :${PORT}`));
