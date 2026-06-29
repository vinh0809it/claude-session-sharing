import { useState, useEffect, useRef } from 'react';
import { formatDate, formatSize } from '../lib/sessionFiles';
import { createSignaling } from '../lib/signaling';
import { RTC_CONFIG, sendFiles } from '../lib/transfer';
import { dbGet, dbSet } from '../lib/localStore';
import {
  listSessionsFromHandle,
  inferHome,
} from '../lib/projectUtils';

const LOCAL_API = 'http://localhost:3001';

async function fetchLocalSessions() {
  const res = await fetch(`${LOCAL_API}/sessions`);
  if (!res.ok) throw new Error('API error');
  return res.json();
}

async function fetchSessionContent(relativePath) {
  const res = await fetch(`${LOCAL_API}/sessions/file?p=${encodeURIComponent(relativePath)}`);
  if (!res.ok) throw new Error('Failed to read session file');
  return res.text();
}

// step: init | setup-pick | setup-home | loading | listing | empty | waiting | transferring | done | error
export default function Sender({ onBack }) {
  const [step, setStep] = useState('init');
  const [sessions, setSessions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [code, setCode] = useState('');
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');

  // mode: 'server' | 'fsa'
  const [mode, setMode] = useState(null);
  const [fsaHandle, setFsaHandle] = useState(null);
  const [homeInput, setHomeInput] = useState('');

  const stepRef = useRef('init');
  const sigRef = useRef(null);
  const pcRef = useRef(null);

  function updateStep(s) { stepRef.current = s; setStep(s); }

  // On mount: try local server, else try stored FSA handle
  useEffect(() => {
    (async () => {
      try {
        const sessions = await fetchLocalSessions();
        setMode('server');
        setSessions(sessions);
        updateStep(sessions.length ? 'listing' : 'empty');
      } catch {
        const handle = await dbGet('claudeHandle').catch(() => null);
        if (handle) {
          const perm = await handle.queryPermission({ mode: 'readwrite' });
          if (perm === 'granted') {
            await loadFsaSessions(handle);
            return;
          }
          // Permission needs re-requesting (requires user gesture)
          setFsaHandle(handle);
          updateStep('reconnect');
          return;
        }
        updateStep('setup-pick');
      }
    })();
    return () => { sigRef.current?.close(); pcRef.current?.close(); };
  }, []);

  async function loadFsaSessions(handle) {
    setMode('fsa');
    setFsaHandle(handle);
    updateStep('loading');
    try {
      const sessions = await listSessionsFromHandle(handle);
      setSessions(sessions);
      updateStep(sessions.length ? 'listing' : 'empty');
    } catch (e) {
      setError(e.message);
      updateStep('error');
    }
  }

  // Setup: pick the ~/.claude/projects folder, auto-detect HOME
  async function handlePickFolder() {
    setError('');
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      const folderNames = [];
      for await (const h of handle.values()) {
        if (h.kind === 'directory') folderNames.push(h.name);
      }
      const inferred = inferHome(folderNames);
      if (inferred) {
        // HOME detected — save and go straight to listing
        await dbSet('claudeHandle', handle);
        await dbSet('home', inferred);
        await loadFsaSessions(handle);
      } else {
        // No existing projects to infer from — ask once
        setHomeInput('');
        setFsaHandle(handle);
        updateStep('setup-home');
      }
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
    }
  }

  async function handleConfirmHome() {
    const home = homeInput.trim();
    if (!home || !home.startsWith('/')) {
      setError('Enter an absolute path like /home/username');
      return;
    }
    await dbSet('claudeHandle', fsaHandle);
    await dbSet('home', home);
    await loadFsaSessions(fsaHandle);
  }

  // Re-request permission for stored handle (after page reload)
  async function handleReconnect() {
    setError('');
    try {
      const handle = await dbGet('claudeHandle');
      if (!handle) { updateStep('setup-pick'); return; }
      const perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        await loadFsaSessions(handle);
      } else {
        updateStep('setup-pick');
      }
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleRefresh() {
    setSelected(null);
    if (mode === 'server') {
      updateStep('loading');
      try {
        const sessions = await fetchLocalSessions();
        setSessions(sessions);
        updateStep(sessions.length ? 'listing' : 'empty');
      } catch { updateStep('listing'); }
    } else if (fsaHandle) {
      await loadFsaSessions(fsaHandle);
    }
  }

  function getSelected() {
    if (!selected) return null;
    if (mode === 'server' && selected.relativePath) {
      return { ...selected, getText: () => fetchSessionContent(selected.relativePath) };
    }
    if (mode === 'fsa' && selected.fileHandle) {
      return { ...selected, getText: () => selected.fileHandle.getFile().then((f) => f.text()) };
    }
    return selected;
  }

  async function handleShare() {
    const session = getSelected();
    if (!session) return;
    setError('');
    let pc = null;

    const sig = createSignaling(async (msg) => {
      if (msg.type === 'created') { setCode(msg.code); updateStep('waiting'); }

      if (msg.type === 'receiver-joined') {
        pc = new RTCPeerConnection(RTC_CONFIG);
        pcRef.current = pc;
        const dc = pc.createDataChannel('session', { ordered: true });

        pc.onicecandidate = (e) => {
          if (e.candidate) sig.send({ type: 'signal', data: { type: 'ice', candidate: e.candidate } });
        };

        dc.onopen = async () => {
          updateStep('transferring');
          try {
            await sendFiles(dc, [session], (p) => setProgress(p));
            updateStep('done');
          } catch (err) {
            setError(err.message);
            updateStep('error');
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sig.send({ type: 'signal', data: { type: 'offer', sdp: offer } });
      }

      if (msg.type === 'signal') {
        const { data } = msg;
        if (data.type === 'answer') await pc?.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.type === 'ice') await pc?.addIceCandidate(new RTCIceCandidate(data.candidate));
      }

      if (msg.type === 'error') { setError(msg.message); updateStep('error'); }
      if (msg.type === 'peer-disconnected' && stepRef.current !== 'done') {
        setError('Receiver disconnected before transfer finished');
        updateStep('error');
      }
    });

    sigRef.current = sig;
    sig.onOpen(() => sig.send({ type: 'create' }));
  }

  const progressPct = progress ? Math.round((progress.chunk / progress.totalChunks) * 100) : 0;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <button onClick={onBack} className="text-gray-500 hover:text-gray-300 text-sm mb-8 flex items-center gap-1 transition-colors">
          ← Back
        </button>
        <h1 className="text-2xl font-bold text-white mb-8">Share a Session</h1>

        {/* INIT */}
        {step === 'init' && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
            <div className="text-gray-400 text-sm animate-pulse">Loading…</div>
          </div>
        )}

        {/* RECONNECT — stored handle needs permission re-grant */}
        {step === 'reconnect' && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
            <div className="text-4xl mb-4">🔓</div>
            <p className="text-white font-medium mb-2">Grant folder access</p>
            <p className="text-gray-500 text-sm mb-6">
              Permission to read <code className="bg-gray-800 px-1 rounded">~/.claude/projects</code> needs to be re-granted.
            </p>
            <button onClick={handleReconnect} className="bg-purple-600 hover:bg-purple-500 text-white font-medium px-6 py-2.5 rounded-xl transition-colors">
              Grant Access
            </button>
            {error && <p className="text-red-400 text-sm mt-4">{error}</p>}
          </div>
        )}

        {/* SETUP — pick folder (one-time) */}
        {step === 'setup-pick' && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
            <div className="text-4xl mb-4">📂</div>
            <p className="text-white font-medium mb-2">One-time setup</p>
            <p className="text-gray-500 text-sm mb-2">
              The browser can't access your files automatically — you need to pick the folder once.
              After that, the app remembers it forever.
            </p>
            <p className="text-gray-600 text-xs mb-6">
              Navigate to <code className="bg-gray-800 px-1 rounded">~/.claude/projects</code> and click Select.
              Press <kbd className="bg-gray-800 px-1 rounded">Ctrl+H</kbd> to show hidden folders.
            </p>
            <button
              onClick={handlePickFolder}
              className="bg-purple-600 hover:bg-purple-500 text-white font-medium px-6 py-2.5 rounded-xl transition-colors"
            >
              Pick ~/.claude/projects
            </button>
            {error && <p className="text-red-400 text-sm mt-4">{error}</p>}
          </div>
        )}

        {/* SETUP STEP 2 — confirm home dir */}
        {step === 'setup-home' && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8">
            <p className="text-white font-medium mb-1">Confirm your home directory</p>
            <p className="text-gray-500 text-sm mb-4">Used to decode session paths (e.g. /home/username).</p>
            <input
              type="text"
              value={homeInput}
              onChange={(e) => setHomeInput(e.target.value)}
              placeholder="/home/username"
              className="w-full bg-gray-950 border border-gray-700 focus:border-purple-500 rounded-xl px-4 py-3 text-sm font-mono text-gray-300 placeholder-gray-600 outline-none transition-colors mb-4"
            />
            {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
            <button
              onClick={handleConfirmHome}
              className="w-full bg-purple-600 hover:bg-purple-500 text-white font-medium py-2.5 rounded-xl transition-colors"
            >
              Continue
            </button>
          </div>
        )}

        {/* LOADING */}
        {step === 'loading' && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
            <div className="text-gray-400 text-sm animate-pulse">Loading sessions…</div>
          </div>
        )}

        {/* EMPTY */}
        {step === 'empty' && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
            <p className="text-gray-400 text-sm">No sessions found.</p>
            <button onClick={handleRefresh} className="mt-4 text-gray-500 hover:text-gray-300 text-sm transition-colors">Refresh</button>
          </div>
        )}

        {/* LISTING */}
        {step === 'listing' && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-gray-400 text-sm">Select a session to share:</p>
              <button onClick={handleRefresh} className="text-gray-600 hover:text-gray-400 text-xs transition-colors">Refresh</button>
            </div>
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {sessions.map((s, i) => (
                <button
                  key={i}
                  onClick={() => setSelected(s)}
                  className={`w-full text-left bg-gray-900 border rounded-xl p-4 transition-colors ${
                    selected === s ? 'border-purple-500 bg-gray-800' : 'border-gray-800 hover:border-gray-700'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-white text-sm font-medium truncate">{s.title || s.name}</p>
                      <p className="text-gray-500 text-xs mt-0.5 truncate font-mono">{s.folder}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-gray-400 text-xs">{formatSize(s.size)}</p>
                      <p className="text-gray-600 text-xs">{formatDate(s.lastModified)}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={handleShare}
                disabled={!selected}
                className="ml-auto bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium px-6 py-2.5 rounded-xl transition-colors"
              >
                Share Selected
              </button>
            </div>
          </div>
        )}

        {/* WAITING */}
        {step === 'waiting' && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
            <p className="text-gray-400 text-sm mb-2">Share this code with the receiver:</p>
            <div className="bg-gray-950 border border-gray-700 rounded-xl py-6 px-8 my-6 inline-block w-full">
              <p className="text-5xl font-bold tracking-[0.3em] text-white font-mono">{code}</p>
            </div>
            <div className="flex items-center justify-center gap-2 text-gray-500 text-sm">
              <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
              Waiting for receiver to connect…
            </div>
            <p className="text-gray-600 text-xs mt-3">{selected?.title || selected?.name}</p>
          </div>
        )}

        {/* TRANSFERRING */}
        {step === 'transferring' && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
            <div className="text-4xl mb-4">📡</div>
            <p className="text-white font-medium mb-1">Sending…</p>
            <p className="text-gray-500 text-xs mb-6">{progress?.name}</p>
            <div className="w-full bg-gray-800 rounded-full h-2">
              <div className="bg-purple-500 h-2 rounded-full transition-all duration-200" style={{ width: `${progressPct}%` }} />
            </div>
            <p className="text-gray-500 text-xs mt-3">{progressPct}%</p>
          </div>
        )}

        {/* DONE */}
        {step === 'done' && (
          <div className="bg-gray-900 border border-green-900 rounded-2xl p-8 text-center">
            <div className="text-4xl mb-4">✅</div>
            <p className="text-white font-semibold text-lg mb-1">Session sent!</p>
            <p className="text-gray-400 text-sm mb-6">{selected?.title || selected?.name} transferred successfully.</p>
            <button
              onClick={() => { updateStep('listing'); setSelected(null); setProgress(null); }}
              className="bg-gray-800 hover:bg-gray-700 text-white text-sm px-5 py-2 rounded-xl transition-colors mr-3"
            >
              Share Another
            </button>
            <button onClick={onBack} className="text-gray-500 hover:text-gray-300 text-sm transition-colors">Go Home</button>
          </div>
        )}

        {/* ERROR */}
        {step === 'error' && (
          <div className="bg-gray-900 border border-red-900 rounded-2xl p-8 text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <p className="text-red-400 font-medium mb-4">{error}</p>
            <button
              onClick={() => { updateStep('listing'); setError(''); }}
              className="bg-gray-800 hover:bg-gray-700 text-white text-sm px-5 py-2 rounded-xl transition-colors"
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
