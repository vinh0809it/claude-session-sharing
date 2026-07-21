// ~/projects/myapp or /home/user/projects/myapp → -home-user-projects-myapp
export function pathToFolder(inputPath, home) {
  let p = inputPath.trim();
  if (p.startsWith('~')) p = home + p.slice(1);
  else if (!p.startsWith('/')) p = home + '/' + p;
  return p.replace(/\/+$/, '').replace(/\//g, '-');
}

// -home-user-projects-myapp → ~/projects/myapp  (naive — good enough for display)
export function folderToDisplayPath(folder, home) {
  const abs = '/' + folder.replace(/^-/, '').replace(/-/g, '/');
  return home ? abs.replace(home, '~') : abs;
}

// Rewrite every cwd field in a JSONL string
export function rewriteCwd(content, newCwd) {
  return content.split('\n').map((line) => {
    if (!line.trim()) return line;
    try {
      const obj = JSON.parse(line);
      if ('cwd' in obj) { obj.cwd = newCwd; return JSON.stringify(obj); }
    } catch {}
    return line;
  }).join('\n');
}

// Read session title from a File object (tail-first so /rename works correctly)
export async function readTitleFromFile(file) {
  const CHUNK = 2048;
  const size = file.size;

  const tailText = await file.slice(Math.max(0, size - CHUNK), size).text();
  for (const line of tailText.split('\n').reverse()) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'custom-title' && obj.customTitle) return obj.customTitle;
    } catch {}
  }

  const headText = await file.slice(0, Math.min(CHUNK, size)).text();
  for (const line of headText.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'custom-title' && obj.customTitle) return obj.customTitle;
      if (obj.type === 'summary' && obj.summary) return obj.summary.slice(0, 80);
      if (obj.type === 'user') {
        const c = obj.message?.content;
        if (typeof c === 'string') return c.slice(0, 80);
        if (Array.isArray(c)) {
          const t = c.find((x) => x?.type === 'text');
          if (t) return t.text.slice(0, 80);
        }
      }
    } catch {}
  }
  return null;
}

// List all sessions under a ~/.claude/projects/ directory handle
export async function listSessionsFromHandle(dirHandle) {
  const sessions = [];
  for await (const projHandle of dirHandle.values()) {
    if (projHandle.kind !== 'directory') continue;
    for await (const fileHandle of projHandle.values()) {
      if (fileHandle.kind !== 'file' || !fileHandle.name.endsWith('.jsonl')) continue;
      const file = await fileHandle.getFile();
      const title = await readTitleFromFile(file);
      sessions.push({
        name: fileHandle.name,
        folder: projHandle.name,
        size: file.size,
        lastModified: file.lastModified,
        title,
        fileHandle,
      });
    }
  }
  return sessions.sort((a, b) => b.lastModified - a.lastModified);
}

// List all projects under a ~/.claude/projects/ directory handle
export async function listProjectsFromHandle(dirHandle, home) {
  const projects = [];
  for await (const projHandle of dirHandle.values()) {
    if (projHandle.kind !== 'directory') continue;
    const folder = projHandle.name;
    const displayPath = folderToDisplayPath(folder, home);
    if (displayPath === '~') continue;
    let sessionCount = 0;
    for await (const fh of projHandle.values()) {
      if (fh.kind === 'file' && fh.name.endsWith('.jsonl')) sessionCount++;
    }
    projects.push({ folder, displayPath, sessionCount, handle: projHandle });
  }
  return projects.sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}

// Derive HOME from a home directory handle + platform
// handle.name = username, platform = Linux → /home/username, Mac → /Users/username
export function homeFromHandle(handle) {
  const name = handle.name;
  const isMac = navigator.userAgent.includes('Mac');
  return (isMac ? '/Users/' : '/home/') + name;
}

// Get the ~/.claude/projects handle from a home directory handle
export async function getProjectsHandle(homeHandle) {
  const claudeHandle = await homeHandle.getDirectoryHandle('.claude');
  return claudeHandle.getDirectoryHandle('projects', { create: false });
}

// Infer HOME from existing project folder names (fallback if home dir not picked)
export function inferHome(folderNames) {
  const counts = new Map();
  for (const name of folderNames) {
    const m = name.match(/^(-(?:home|Users)-[^-]+)/);
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  if (!counts.size) return '';
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return '/' + best.replace(/^-/, '').replace(/-/g, '/');
}

// Read the real cwd from the first existing JSONL in a project folder handle.
// This avoids the naive decode ambiguity (dashes vs slashes in project names).
export async function getCwdFromProjectHandle(projHandle) {
  for await (const fh of projHandle.values()) {
    if (fh.kind !== 'file' || !fh.name.endsWith('.jsonl')) continue;
    const file = await fh.getFile();
    const text = await file.slice(0, 4096).text();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj.cwd === 'string' && obj.cwd.startsWith('/')) return obj.cwd;
      } catch {}
    }
  }
  return null;
}

// Save a session file into a ~/.claude/projects/ directory handle
export async function saveToHandle(dirHandle, folder, fileName, content) {
  const projHandle = await dirHandle.getDirectoryHandle(folder, { create: true });
  const fileHandle = await projHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}
