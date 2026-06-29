const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || 'ws://localhost:3001';

export function createSignaling(onMessage, onClose) {
  const ws = new WebSocket(SIGNALING_URL);
  let openCallback = null;

  ws.onopen = () => openCallback?.();
  ws.onmessage = (e) => {
    try { onMessage(JSON.parse(e.data)); } catch {}
  };
  ws.onclose = () => onClose?.();
  ws.onerror = (e) => console.error('Signaling WS error:', e);

  return {
    send(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() { ws.close(); },
    onOpen(cb) {
      openCallback = cb;
      // Handle race: WebSocket may already be open
      if (ws.readyState === WebSocket.OPEN) cb();
    },
  };
}
