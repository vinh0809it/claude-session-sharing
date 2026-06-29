import { useState, useEffect, useRef } from 'react';
import { formatSize } from '../lib/sessionFiles';
import { createSignaling } from '../lib/signaling';
import { RTC_CONFIG, listenForFiles } from '../lib/transfer';
import { dbGet, dbSet } from '../lib/localStore';
import {
  pathToFolder,
  folderToDisplayPath,
  rewriteCwd,
  listProjectsFromHandle,
  saveToHandle,
  inferHome,
} from '../lib/projectUtils';

const LOCAL_API = 'http://localhost:3001';

async function fetchProjects() {
  const res = await fetch(`${LOCAL_API}/projects`);
  if (!res.ok) throw new Error();
  return res.json();
}

async function saveViaServer({ folder, projectPath, name, content }) {
  const res = await fetch(`${LOCAL_API}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, projectPath, name, content }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Save failed');
}

export default function Receiver({ onBack }) {
  const [step, setStep] = useState('idle');
  const [codeInput, setCodeInput] = useState('');
  const [progress, setProgress] = useState(null);
  const [transferDone, setTransferDone] = useState(false);
  const [receivedFiles, setReceivedFiles] = useState([]);
  const [error, setError] = useState('');

  // mode: null (detecting) | 'server' | 'fsa' | 'setup'
  const [mode, setMode] = useState(null);
  const [projects, setProjects] = useState([]);
  const [filterText, setFilterText] = useState('');
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customPath, setCustomPath] = useState('');

  // FSA setup state
  const [fsaHandle, setFsaHandle] = useState(null);
  const [fsaHome, setFsaHome] = useState('');
  const [homeInput, setHomeInput] = useState('');
  const [setupStep, setSetupStep] = useState('pick'); // 'pick' | 'home'

  const stepRef = useRef('idle');
  const sigRef = useRef(null);
  const pcRef = useRef(null);
  const filesBufferRef = useRef([]);

  function updateStep(s) { stepRef.current = s; setStep(s); }

  // Detect mode on mount
  useEffect(() => {
    (async () => {
      try {
        const list = await fetchProjects();
        setProjects(list);
        setMode('server');
      } catch {
        // Try stored FSA handle
        const handle = await dbGet('claudeHandle').catch(() => null);
        const home = await dbGet('home').catch(() => null);
        if (handle && home) {
          const perm = await handle.queryPermission({ mode: 'readwrite' });
          if (perm === 'granted') {
            await loadFsaProjects(handle, home);
            return;
          }
          // perm === 'prompt': store handle for reconnect button
          setFsaHandle(handle);
          setFsaHome(home);
          setMode('reconnect');
          return;
        }
        setMode('setup');
      }
    })();
    return () => { sigRef.current?.close(); pcRef.current?.close(); };
  }, []);

  async function loadFsaProjects(handle, home) {
    setFsaHandle(handle);
    setFsaHome(home);
    setMode('fsa');
    const list = await listProjectsFromHandle(handle, home);
    setProjects(list);
  }

  async function handleReconnect() {
    setError('');
    try {
      const perm = await fsaHandle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        await loadFsaProjects(fsaHandle, fsaHome);
      } else {
        setMode('setup');
      }
    } catch (e) {
      setError(e.message);
    }
  }

  // Setup: pick folder, auto-detect HOME
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
        await dbSet('claudeHandle', handle);
        await dbSet('home', inferred);
        await loadFsaProjects(handle, inferred);
      } else {
        setHomeInput('');
        setFsaHandle(handle);
        setSetupStep('home');
      }
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
    }
  }

  async function handleConfirmHome() {
    const home = homeInput.trim();
    if (!home || !home.startsWith('/')) { setError('Enter an absolute path like /home/username'); return; }
    await dbSet('claudeHandle', fsaHandle);
    await dbSet('home', home);
    await loadFsaProjects(fsaHandle, home);
  }

  async function handleConnect() {
    const code = codeInput.trim().toUpperCase();
    if (code.length !== 6) { setError('Enter a 6-character code'); return; }
    setError('');
    updateStep('connecting');

    let pc = null;
    const sig = createSignaling(async (msg) => {
      if (msg.type === 'joined') {
        pc = new RTCPeerConnection(RTC_CONFIG);
        pcRef.current = pc;
        pc.onicecandidate = (e) => {
          if (e.candidate) sig.send({ type: 'signal', data: { type: 'ice', candidate: e.candidate } });
        };
        pc.ondatachannel = (e) => {
          updateStep('receiving');
          listenForFiles(
            e.channel,
            (file) => { filesBufferRef.current.push(file); setReceivedFiles((p) => [...p, file]); },
            () => setTransferDone(true),
            (p) => setProgress(p)
          );
        };
      }
      if (msg.type === 'signal') {
        const { data } = msg;
        if (data.type === 'offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sig.send({ type: 'signal', data: { type: 'answer', sdp: answer } });
        }
        if (data.type === 'ice') await pc?.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
      if (msg.type === 'error') { setError(msg.message); updateStep('error'); }
      if (msg.type === 'peer-disconnected' && !['saved'].includes(stepRef.current)) {
        if (filesBufferRef.current.length > 0) setTransferDone(true);
        else { setError('Sender disconnected'); updateStep('error'); }
      }
    });

    sigRef.current = sig;
    sig.onOpen(() => sig.send({ type: 'join', code }));
  }

  async function handleSave() {
    const files = filesBufferRef.current;
    if (!files.length) return;
    setError('');
    try {
      if (mode === 'server') {
        if (showCustom) {
          if (!customPath.trim()) { setError('Enter a project path'); return; }
          for (const f of files) await saveViaServer({ projectPath: customPath.trim(), name: f.name, content: f.content });
        } else {
          if (!selectedFolder) { setError('Select a project'); return; }
          for (const f of files) await saveViaServer({ folder: selectedFolder, name: f.name, content: f.content });
        }
      } else if (mode === 'fsa') {
        const destPath = showCustom ? customPath.trim() : folderToDisplayPath(selectedFolder, fsaHome);
        if (!destPath) { setError('Select or enter a destination'); return; }
        let absPath = destPath.startsWith('~') ? fsaHome + destPath.slice(1) : destPath;
        if (!absPath.startsWith('/')) absPath = fsaHome + '/' + absPath;
        const folder = pathToFolder(absPath, fsaHome);
        for (const f of files) {
          const newContent = rewriteCwd(f.content, absPath);
          await saveToHandle(fsaHandle, folder, f.name, newContent);
        }
      }
      updateStep('saved');
    } catch (e) {
      setError(e.message);
    }
  }

  const canSave = showCustom ? customPath.trim().length > 0 : selectedFolder !== null;

  const progressPct = progress ? Math.round((progress.received / progress.total) * 100) : 0;
  const totalSize = receivedFiles.reduce((acc, f) => acc + f.content.length, 0);

  const filteredProjects = projects.filter((p) =>
    p.displayPath !== '~' &&
    p.displayPath.toLowerCase().includes(filterText.toLowerCase())
  );

  function resetState() {
    updateStep('idle');
    setCodeInput(''); setReceivedFiles([]); setProgress(null);
    setTransferDone(false); setSelectedFolder(null);
    setCustomPath(''); setShowCustom(false);
    filesBufferRef.current = [];
  }

  // Inline setup card (shown in the receive idle screen when mode is setup/reconnect)
  const SetupCard = () => (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6">
      {mode === 'reconnect' ? (
        <>
          <p className="text-gray-400 text-sm mb-3">
            Grant permission to <code className="bg-gray-800 px-1 rounded">~/.claude/projects</code> to continue.
          </p>
          <button onClick={handleReconnect} className="w-full bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium py-2 rounded-xl transition-colors">
            Grant Access
          </button>
        </>
      ) : setupStep === 'pick' ? (
        <>
          <p className="text-white font-medium text-sm mb-1">One-time setup</p>
          <p className="text-gray-500 text-xs mb-4">
            Pick your <code className="bg-gray-800 px-1 rounded">~/.claude/projects</code> folder to save received sessions.
            Press <kbd className="bg-gray-800 px-1 rounded">Ctrl+H</kbd> for hidden folders.
          </p>
          <button onClick={handlePickFolder} className="w-full bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium py-2 rounded-xl transition-colors">
            Pick Folder
          </button>
        </>
      ) : (
        <>
          <p className="text-white font-medium text-sm mb-1">Confirm home directory</p>
          <p className="text-gray-500 text-xs mb-3">Used to save sessions to the right path.</p>
          <input
            type="text"
            value={homeInput}
            onChange={(e) => setHomeInput(e.target.value)}
            placeholder="/home/username"
            className="w-full bg-gray-950 border border-gray-700 focus:border-purple-500 rounded-xl px-4 py-2.5 text-sm font-mono text-gray-300 placeholder-gray-600 outline-none mb-3"
          />
          <button onClick={handleConfirmHome} className="w-full bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium py-2 rounded-xl transition-colors">
            Save &amp; Continue
          </button>
        </>
      )}
      {error && <p className="text-red-400 text-xs mt-3">{error}</p>}
    </div>
  );

  const DestinationPicker = () => (
    <div className="border-t border-gray-800 pt-4 mt-2">
      <p className="text-gray-500 text-xs mb-3">Save to Claude project:</p>

      {!showCustom && (
        <>
          {projects.length > 5 && (
            <input
              type="text"
              placeholder="Filter…"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-300 placeholder-gray-600 outline-none mb-2"
            />
          )}
          <div className="max-h-44 overflow-y-auto space-y-1 mb-2">
            {filteredProjects.map((p) => (
              <button
                key={p.folder}
                onClick={() => setSelectedFolder(p.folder)}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors ${
                  selectedFolder === p.folder
                    ? 'bg-blue-900 border border-blue-600 text-white'
                    : 'bg-gray-950 border border-gray-800 text-gray-300 hover:border-gray-600'
                }`}
              >
                <span className="font-mono">{p.displayPath}</span>
                <span className="text-gray-600 ml-2">({p.sessionCount})</span>
              </button>
            ))}
            {filteredProjects.length === 0 && (
              <p className="text-gray-600 text-xs px-2 py-1">No matching projects.</p>
            )}
          </div>
        </>
      )}

      {showCustom && (
        <div className="mb-3">
          <input
            type="text"
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            placeholder={mode === 'fsa' ? '~/projects/my-project' : '~/projects/my-project'}
            className="w-full bg-gray-950 border border-gray-700 focus:border-blue-500 rounded-lg px-3 py-2 text-sm font-mono text-gray-300 placeholder-gray-600 outline-none"
          />
          {customPath && !customPath.startsWith('~') && !customPath.startsWith('/') && (
            <p className="text-yellow-600 text-xs mt-1">Treated as <code className="bg-gray-800 px-1 rounded">~/{customPath}</code></p>
          )}
          <p className="text-gray-600 text-xs mt-1">The project directory will be created automatically.</p>
        </div>
      )}

      <button
        onClick={() => { setShowCustom(!showCustom); setSelectedFolder(null); setCustomPath(''); }}
        className="text-gray-600 hover:text-gray-400 text-xs transition-colors"
      >
        {showCustom ? '← Pick existing project' : '+ New project / custom path'}
      </button>

      {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
    </div>
  );

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <button onClick={onBack} className="text-gray-500 hover:text-gray-300 text-sm mb-8 flex items-center gap-1 transition-colors">
          ← Back
        </button>
        <h1 className="text-2xl font-bold text-white mb-8">Receive a Session</h1>

        {/* Show setup/reconnect card when mode isn't ready yet */}
        {(mode === 'setup' || mode === 'reconnect') && step === 'idle' && <SetupCard />}

        {step === 'idle' && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8">
            <label className="block text-gray-400 text-sm mb-2">Enter the 6-character code from the sender:</label>
            <input
              type="text"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
              onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
              placeholder="ABCDEF"
              className="w-full bg-gray-950 border border-gray-700 focus:border-blue-500 rounded-xl px-4 py-3 text-2xl font-mono tracking-[0.3em] text-white text-center placeholder-gray-700 outline-none transition-colors"
              spellCheck={false}
            />
            {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
            <button
              onClick={handleConnect}
              disabled={codeInput.length !== 6}
              className="mt-4 w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-xl transition-colors"
            >
              Connect
            </button>
          </div>
        )}

        {step === 'connecting' && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
            <div className="text-4xl mb-4 animate-spin inline-block">⟳</div>
            <p className="text-gray-400">Connecting to <span className="font-mono text-white">{codeInput}</span>…</p>
          </div>
        )}

        {step === 'receiving' && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
            <div className="flex items-center gap-2 mb-3">
              {transferDone
                ? <span className="w-2 h-2 rounded-full bg-green-400 inline-block" />
                : <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse inline-block" />}
              <span className="text-gray-400 text-sm">{transferDone ? 'Transfer complete' : 'Receiving…'}</span>
              {totalSize > 0 && <span className="ml-auto text-gray-600 text-xs">{formatSize(totalSize)}</span>}
            </div>

            {progress && !transferDone && (
              <div className="mb-4">
                <p className="text-gray-400 text-xs font-mono truncate mb-1">{progress.name}</p>
                <div className="w-full bg-gray-800 rounded-full h-1.5">
                  <div className="bg-blue-500 h-1.5 rounded-full transition-all duration-200" style={{ width: `${progressPct}%` }} />
                </div>
              </div>
            )}

            {(mode === 'server' || mode === 'fsa') && <DestinationPicker />}

            {transferDone && (
              <>
                {canSave && (
                  <p className="text-xs text-center mt-4 mb-1 font-mono text-green-400 truncate">
                    → {showCustom
                        ? (customPath.startsWith('~') || customPath.startsWith('/') ? customPath : `~/${customPath}`)
                        : (mode === 'fsa'
                            ? folderToDisplayPath(selectedFolder, fsaHome)
                            : projects.find((p) => p.folder === selectedFolder)?.displayPath)}
                  </p>
                )}
                <button
                  onClick={handleSave}
                  disabled={!canSave}
                  className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-xl transition-colors mt-3"
                >
                  {canSave ? 'Save Session' : 'Select a destination above'}
                </button>
              </>
            )}
          </div>
        )}

        {step === 'saved' && (
          <div className="bg-gray-900 border border-green-900 rounded-2xl p-8 text-center">
            <div className="text-4xl mb-4">✅</div>
            <p className="text-white font-semibold text-lg mb-1">Session saved!</p>
            <p className="text-gray-400 text-sm mb-2">{receivedFiles.length} file{receivedFiles.length !== 1 ? 's' : ''} — {formatSize(totalSize)}</p>
            <p className="text-gray-600 text-xs mb-6">Open that project folder in Claude Code to resume the session.</p>
            <button onClick={resetState} className="bg-gray-800 hover:bg-gray-700 text-white text-sm px-5 py-2 rounded-xl transition-colors mr-3">
              Receive Another
            </button>
            <button onClick={onBack} className="text-gray-500 hover:text-gray-300 text-sm transition-colors">Go Home</button>
          </div>
        )}

        {step === 'error' && (
          <div className="bg-gray-900 border border-red-900 rounded-2xl p-8 text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <p className="text-red-400 font-medium mb-4">{error}</p>
            <button onClick={() => { updateStep('idle'); setError(''); }} className="bg-gray-800 hover:bg-gray-700 text-white text-sm px-5 py-2 rounded-xl transition-colors">
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
