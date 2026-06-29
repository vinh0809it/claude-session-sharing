import { useState, useEffect, useRef } from 'react';
import { openSessionsFolder, listSessionFiles, formatDate, formatSize } from '../lib/sessionFiles';
import { createSignaling } from '../lib/signaling';
import { RTC_CONFIG, sendFiles } from '../lib/transfer';

const LOCAL_API = 'http://localhost:3001';

// Claude encodes project paths as -home-user-projects-foo → ~/projects/foo
function decodeProjectFolder(folder) {
  return folder.replace(/^-/, '~/').replaceAll('-', '/').replace('~/', '~/');
}

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

export default function Sender({ onBack }) {
  const [step, setStep] = useState('loading'); // loading | listing | waiting | transferring | done | error
  const [sessions, setSessions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [code, setCode] = useState('');
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [useLocalAPI, setUseLocalAPI] = useState(true);

  const stepRef = useRef('loading');
  const sigRef = useRef(null);
  const pcRef = useRef(null);

  function updateStep(s) {
    stepRef.current = s;
    setStep(s);
  }

  useEffect(() => {
    // Try to auto-load sessions from local server
    fetchLocalSessions()
      .then((sessions) => {
        setSessions(sessions);
        updateStep(sessions.length ? 'listing' : 'empty');
      })
      .catch(() => {
        // Local server not reachable — fall back to file picker
        setUseLocalAPI(false);
        updateStep('idle');
      });

    return () => {
      sigRef.current?.close();
      pcRef.current?.close();
    };
  }, []);

  async function handleOpenFolder() {
    setError('');
    try {
      const dir = await openSessionsFolder();
      const files = await listSessionFiles(dir);
      if (!files.length) {
        setError('No .jsonl files found. Open a folder inside ~/.claude/projects/');
        return;
      }
      // Normalize to the same shape as local API sessions
      setSessions(files.map((s) => ({
        name: s.name,
        folder: s.folder,
        relativePath: null,
        size: s.size,
        lastModified: s.lastModified,
        getText: () => s.file.text(),
      })));
      updateStep('listing');
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
    }
  }

  function getSelected() {
    if (!selected) return null;
    // Local API sessions need getText wired up here
    if (useLocalAPI && selected.relativePath) {
      return { ...selected, getText: () => fetchSessionContent(selected.relativePath) };
    }
    return selected; // file picker sessions already have getText
  }

  async function handleShare() {
    const session = getSelected();
    if (!session) return;
    setError('');

    let pc = null;

    const sig = createSignaling(async (msg) => {
      if (msg.type === 'created') {
        setCode(msg.code);
        updateStep('waiting');
      }

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

  async function handleRefresh() {
    updateStep('loading');
    setSelected(null);
    try {
      const sessions = await fetchLocalSessions();
      setSessions(sessions);
      updateStep(sessions.length ? 'listing' : 'empty');
    } catch {
      updateStep('listing');
    }
  }

  const progressPct = progress
    ? Math.round((progress.chunk / progress.totalChunks) * 100)
    : 0;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <button onClick={onBack} className="text-gray-500 hover:text-gray-300 text-sm mb-8 flex items-center gap-1 transition-colors">
          ← Back
        </button>

        <h1 className="text-2xl font-bold text-white mb-8">Share a Session</h1>

        {/* LOADING */}
        {step === 'loading' && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
            <div className="text-gray-400 text-sm animate-pulse">Loading sessions…</div>
          </div>
        )}

        {/* IDLE — local server not available */}
        {step === 'idle' && (
          <div className="bg-gray-900 border border-yellow-900/50 rounded-2xl p-8 text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <p className="text-yellow-400 font-medium mb-2 text-sm">Local server not running</p>
            <p className="text-gray-400 text-sm mb-4">
              The local server is required to read your Claude sessions.
            </p>
            <div className="bg-gray-950 border border-gray-800 rounded-xl p-4 text-left mb-6">
              <p className="text-gray-500 text-xs mb-2">Run this on your machine:</p>
              <code className="text-green-400 text-xs block">
                cd server &amp;&amp; node index.js
              </code>
            </div>
            <p className="text-gray-600 text-xs mb-5">
              Or pick the folder manually (no server needed):
            </p>
            <button
              onClick={handleOpenFolder}
              className="bg-gray-700 hover:bg-gray-600 text-white font-medium px-6 py-2.5 rounded-xl transition-colors text-sm"
            >
              Pick Sessions Folder Manually
            </button>
            {error && <p className="text-red-400 text-sm mt-4">{error}</p>}
          </div>
        )}

        {/* EMPTY */}
        {step === 'empty' && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
            <div className="text-4xl mb-4">🈳</div>
            <p className="text-gray-400 text-sm">No sessions found in <code className="bg-gray-800 px-1 rounded">~/.claude/projects/</code></p>
            <button onClick={handleRefresh} className="mt-4 text-gray-500 hover:text-gray-300 text-sm transition-colors">Refresh</button>
          </div>
        )}

        {/* LISTING */}
        {(step === 'listing') && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-gray-400 text-sm">Select a session to share:</p>
              {useLocalAPI && (
                <button onClick={handleRefresh} className="text-gray-600 hover:text-gray-400 text-xs transition-colors">
                  Refresh
                </button>
              )}
            </div>
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {sessions.map((s, i) => (
                <button
                  key={i}
                  onClick={() => setSelected(s)}
                  className={`w-full text-left bg-gray-900 border rounded-xl p-4 transition-colors ${
                    selected === s
                      ? 'border-purple-500 bg-gray-800'
                      : 'border-gray-800 hover:border-gray-700'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-white text-sm font-medium truncate">{s.title || s.name}</p>
                      <p className="text-gray-500 text-xs mt-0.5 truncate">{decodeProjectFolder(s.folder)}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-gray-400 text-xs">{formatSize(s.size)}</p>
                      <p className="text-gray-600 text-xs">{formatDate(s.lastModified)}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <div className="flex gap-3 mt-6 items-center">
              {!useLocalAPI && (
                <button onClick={handleOpenFolder} className="text-gray-500 hover:text-gray-300 text-sm transition-colors">
                  Change folder
                </button>
              )}
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
              <div
                className="bg-purple-500 h-2 rounded-full transition-all duration-200"
                style={{ width: `${progressPct}%` }}
              />
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
            <button onClick={onBack} className="text-gray-500 hover:text-gray-300 text-sm transition-colors">
              Go Home
            </button>
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
