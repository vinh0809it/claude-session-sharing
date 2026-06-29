export const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const CHUNK_SIZE = 16_384; // 16 KB per message

export async function sendFiles(dc, files, onProgress) {
  dc.send(JSON.stringify({ type: 'transfer-start', totalFiles: files.length }));

  for (let i = 0; i < files.length; i++) {
    const { name, getText } = files[i];
    const text = await getText();
    const totalChunks = Math.ceil(text.length / CHUNK_SIZE) || 1;

    dc.send(JSON.stringify({ type: 'file-start', name, totalChunks }));

    for (let j = 0; j < totalChunks; j++) {
      dc.send(JSON.stringify({
        type: 'chunk',
        data: text.slice(j * CHUNK_SIZE, (j + 1) * CHUNK_SIZE),
      }));

      // Backpressure: drain if buffer exceeds 512 KB
      while (dc.bufferedAmount > 512 * 1024) {
        await new Promise((r) => setTimeout(r, 20));
      }

      onProgress?.({ fileIndex: i, totalFiles: files.length, chunk: j + 1, totalChunks, name });
    }

    dc.send(JSON.stringify({ type: 'file-end', name }));
  }

  dc.send(JSON.stringify({ type: 'transfer-end' }));
}

export function listenForFiles(dc, onFile, onDone, onProgress) {
  let current = null;
  let chunks = [];

  dc.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'file-start') {
      current = { name: msg.name, totalChunks: msg.totalChunks };
      chunks = [];
    } else if (msg.type === 'chunk') {
      chunks.push(msg.data);
      if (current) onProgress?.({ name: current.name, received: chunks.length, total: current.totalChunks });
    } else if (msg.type === 'file-end') {
      if (current) {
        onFile({ name: current.name, content: chunks.join('') });
        current = null;
        chunks = [];
      }
    } else if (msg.type === 'transfer-end') {
      onDone?.();
    }
  };
}
