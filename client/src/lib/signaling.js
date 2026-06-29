function getSignalingUrl() {
  if (import.meta.env.VITE_SIGNALING_URL) return import.meta.env.VITE_SIGNALING_URL;
  // Auto-detect: use same host as the page, just switch protocol
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}`;
}

export function createSignaling(onMessage, onClose) {
  const ws = new WebSocket(getSignalingUrl());
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
      if (ws.readyState === WebSocket.OPEN) cb();
    },
  };
}
