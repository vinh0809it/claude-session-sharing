const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const HOME = os.homedir();

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

// -home-user-projects-my-app  →  ~/projects/my-app
// Disambiguates dashes vs slashes by checking the filesystem.
function folderToDisplayPath(folder) {
  const parts = folder.replace(/^-/, '').split('-');

  // DFS: at each token, choose slash (new path component) or dash (extend current component).
  // Prefer slash first; prune branches where the intermediate directory doesn't exist.
  function decode(path, component, idx) {
    if (idx === parts.length) {
      const full = path + '/' + component;
      return fs.existsSync(full) ? full : null;
    }
    const withSlash = path + '/' + component;
    if (fs.existsSync(withSlash)) {
      const r = decode(withSlash, parts[idx], idx + 1);
      if (r) return r;
    }
    return decode(path, component + '-' + parts[idx], idx + 1);
  }

  const result = decode('', parts[0], 1);
  if (result) return result.replace(HOME, '~');
  // Fallback: naive replace (display only, save still uses the raw folder name)
  return folder.replace(/^-/, '/').replace(/-/g, '/').replace(HOME, '~');
}

// ~/projects/myapp or /home/user/projects/myapp  →  -home-user-projects-myapp
// Bare relative paths like "projects/foo" are treated as ~/projects/foo
function pathToFolder(inputPath) {
  let p = inputPath.trim();
  if (!p.startsWith('/') && !p.startsWith('~')) p = '~/' + p;
  const abs = p.startsWith('~') ? HOME + p.slice(1) : p;
  return abs.replace(/\//g, '-');
}

function readSessionTitle(filePath) {
  const fileSize = fs.statSync(filePath).size;

  function readChunk(offset, size) {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(size);
    const bytesRead = fs.readSync(fd, buf, 0, size, offset);
    fs.closeSync(fd);
    return buf.subarray(0, bytesRead).toString('utf8');
  }

  // Read the tail first — /rename appends a new custom-title at the end
  const tailChunk = readChunk(Math.max(0, fileSize - 2048), Math.min(2048, fileSize));
  for (const line of tailChunk.split('\n').reverse()) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'custom-title' && obj.customTitle) return obj.customTitle;
    } catch { continue; }
  }

  // Fall back to head of file for summary or first user message
  const headChunk = readChunk(0, Math.min(2048, fileSize));
  let title = null;
  let firstUserText = null;
  for (const line of headChunk.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'custom-title' && obj.customTitle && !title) title = obj.customTitle;
      else if (obj.type === 'summary' && obj.summary && !title) title = obj.summary.slice(0, 80);
      else if (obj.type === 'user' && !firstUserText) {
        const content = obj.message?.content;
        if (typeof content === 'string') firstUserText = content.slice(0, 80);
        else if (Array.isArray(content)) {
          const t = content.find((c) => c?.type === 'text');
          if (t) firstUserText = t.text.slice(0, 80);
        }
      }
    } catch { continue; }
    if (title) break;
  }
  return title || firstUserText || null;
}

async function handleHTTP(req, res) {
  setCORS(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');

  // List sessions for sender
  if (url.pathname === '/sessions' && req.method === 'GET') {
    const sessions = [];
    try {
      if (fs.existsSync(CLAUDE_DIR)) {
        for (const proj of fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })) {
          if (!proj.isDirectory()) continue;

          // Only include sessions whose project directory actually exists on disk
          // (same filter ccs applies — skips orphaned/test/deleted projects)
          const displayPath = folderToDisplayPath(proj.name);
          const absPath = displayPath.startsWith('~') ? HOME + displayPath.slice(1) : displayPath;
          if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) continue;

          const projDir = path.join(CLAUDE_DIR, proj.name);
          for (const f of fs.readdirSync(projDir, { withFileTypes: true })) {
            if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
            const filePath = path.join(projDir, f.name);
            const stat = fs.statSync(filePath);
            sessions.push({
              name: f.name,
              title: readSessionTitle(filePath),
              folder: proj.name,
              relativePath: `${proj.name}/${f.name}`,
              size: stat.size,
              lastModified: stat.mtimeMs,
            });
          }
        }
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
    sessions.sort((a, b) => b.lastModified - a.lastModified);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions));
    return;
  }

  // Read a single session file for sender transfer
  if (url.pathname === '/sessions/file' && req.method === 'GET') {
    const relPath = url.searchParams.get('p');
    if (!relPath) { res.writeHead(400); res.end('Missing ?p='); return; }
    const absPath = path.resolve(CLAUDE_DIR, relPath);
    if (!absPath.startsWith(CLAUDE_DIR + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    try {
      const content = fs.readFileSync(absPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // Resolve the full path of a folder by finding a sentinel file the browser wrote into it
  if (url.pathname === '/resolve-tmp' && req.method === 'GET') {
    const name = url.searchParams.get('name');
    if (!name || !/^\.claude-share-\d+$/.test(name)) {
      res.writeHead(400); res.end('Invalid sentinel name'); return;
    }
    try {
      // Skip heavy dirs to keep find fast
      const result = execFileSync('find', [
        HOME, '-maxdepth', '8',
        '(', '-name', 'node_modules', '-o', '-name', '.git', '-o', '-name', '.npm', '-o', '-name', '.cache', ')',
        '-prune', '-o', '-name', name, '-print',
      ], { timeout: 10000 }).toString().trim();
      // Take only the first match — sentinel name is timestamp-unique so duplicates shouldn't occur
      const firstMatch = result.split('\n').filter(Boolean)[0];
      const dir = firstMatch ? path.dirname(firstMatch).replace(HOME, '~') : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ dir }));
    } catch (e) {
      console.error('resolve-tmp error:', e.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ dir: null, error: e.message }));
    }
    return;
  }

  // Browse filesystem directories (for the receiver's project picker)
  if (url.pathname === '/fs' && req.method === 'GET') {
    const rawPath = url.searchParams.get('path') || '~';
    const absPath = rawPath.startsWith('~') ? HOME + rawPath.slice(1) : rawPath;
    try {
      const entries = fs.readdirSync(absPath, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: rawPath.replace(/\/$/, '') + '/' + e.name }))
        .sort((a, b) => {
          // hidden dirs last
          const aHidden = a.name.startsWith('.');
          const bHidden = b.name.startsWith('.');
          if (aHidden !== bHidden) return aHidden ? 1 : -1;
          return a.name.localeCompare(b.name);
        });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: rawPath, entries }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: rawPath, entries: [], error: e.message }));
    }
    return;
  }

  // List Claude projects for receiver to pick destination
  if (url.pathname === '/projects' && req.method === 'GET') {
    const projects = [];
    try {
      if (fs.existsSync(CLAUDE_DIR)) {
        for (const proj of fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })) {
          if (!proj.isDirectory()) continue;
          const displayPath = folderToDisplayPath(proj.name);
          const absPath = displayPath.startsWith('~') ? HOME + displayPath.slice(1) : displayPath;
          if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) continue;
          const projDir = path.join(CLAUDE_DIR, proj.name);
          const sessionCount = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl')).length;
          projects.push({
            folder: proj.name,
            displayPath,
            sessionCount,
          });
        }
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
    projects.sort((a, b) => a.displayPath.localeCompare(b.displayPath));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(projects));
    return;
  }

  // Save a received session into ~/.claude/projects/<folder>/
  if (url.pathname === '/save' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch {
      res.writeHead(400); res.end('Invalid body'); return;
    }

    const { name, content, folder, projectPath } = body;
    if (!name || !content) { res.writeHead(400); res.end('Missing name or content'); return; }

    const targetFolder = folder || pathToFolder(projectPath || '');
    if (!targetFolder) { res.writeHead(400); res.end('Missing folder or projectPath'); return; }

    // Guard against path traversal
    const targetDir = path.resolve(CLAUDE_DIR, targetFolder);
    if (!targetDir.startsWith(CLAUDE_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

    try {
      fs.mkdirSync(targetDir, { recursive: true });

      // Determine the actual project directory path for cwd rewriting
      let actualDir = null;
      if (projectPath) {
        let p = projectPath.trim();
        if (!p.startsWith('/') && !p.startsWith('~')) p = '~/' + p;
        actualDir = p.startsWith('~') ? HOME + p.slice(1) : p;
      } else {
        // Decode folder back to a filesystem path for cwd
        const decoded = folderToDisplayPath(targetFolder);
        if (decoded && decoded !== targetFolder) {
          actualDir = decoded.replace(/^~/, HOME);
        }
      }

      // Rewrite cwd in every JSONL line so ccs shows the correct project path
      let finalContent = content;
      if (actualDir) {
        finalContent = content.split('\n').map((line) => {
          if (!line.trim()) return line;
          try {
            const obj = JSON.parse(line);
            if ('cwd' in obj) { obj.cwd = actualDir; return JSON.stringify(obj); }
          } catch { /* not valid JSON, leave as-is */ }
          return line;
        }).join('\n');
        fs.mkdirSync(actualDir, { recursive: true });
      }

      fs.writeFileSync(path.join(targetDir, name), finalContent, 'utf8');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, savedTo: targetDir }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Serve built React client
  const DIST = path.join(__dirname, '..', 'client', 'dist');
  if (fs.existsSync(DIST)) {
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
                   '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
    const reqExt = path.extname(url.pathname);
    let filePath = path.join(DIST, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!fs.existsSync(filePath)) {
      // SPA fallback only for navigation requests (no extension = React route like /sender)
      if (reqExt) { res.writeHead(404); res.end('Not found'); return; }
      filePath = path.join(DIST, 'index.html');
    }
    try {
      const data = fs.readFileSync(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Claude Session Sharing — Signaling Server');
}

const server = http.createServer((req, res) => {
  handleHTTP(req, res).catch((err) => {
    console.error('HTTP handler error:', err);
    res.writeHead(500); res.end('Internal error');
  });
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
