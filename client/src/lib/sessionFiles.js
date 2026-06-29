export async function openSessionsFolder() {
  return window.showDirectoryPicker({ id: 'claude-sessions', mode: 'read' });
}

export async function chooseSaveFolder() {
  return window.showDirectoryPicker({ id: 'claude-sessions-save', mode: 'readwrite' });
}

export async function listSessionFiles(dirHandle) {
  const sessions = [];

  async function scan(handle, prefix) {
    for await (const [name, entry] of handle.entries()) {
      if (entry.kind === 'file' && name.endsWith('.jsonl')) {
        const file = await entry.getFile();
        sessions.push({
          name,
          folder: prefix || dirHandle.name,
          file,
          lastModified: file.lastModified,
          size: file.size,
        });
      } else if (entry.kind === 'directory' && prefix === '') {
        await scan(entry, name);
      }
    }
  }

  await scan(dirHandle, '');
  return sessions.sort((a, b) => b.lastModified - a.lastModified);
}

export async function saveSessionFile(dirHandle, fileName, content) {
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

export function formatDate(ts) {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
