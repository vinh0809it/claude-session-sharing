import { useState, useEffect, useRef } from 'react';
import { saveSessionFile, formatSize } from '../lib/sessionFiles';
import { createSignaling } from '../lib/signaling';
import { RTC_CONFIG, listenForFiles } from '../lib/transfer';

const LOCAL_API = 'http://localhost:3001';

async function fetchProjects() {
  const res = await fetch(`${LOCAL_API}/projects`);
  if (!res.ok) throw new Error();
  return res.json();
}

async function saveToProject({ folder, projectPath, name, content }) {
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

  // Destination state
  const [projects, setProjects] = useState([]);
  const [useLocalAPI, setUseLocalAPI] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const [browseResolving, setBrowseResolving] = useState(false);
  const [saveFolderHandle, setSaveFolderHandle] = useState(null); // FSA fallback (no server)

  const stepRef = useRef('idle');
  const sigRef = useRef(null);
  const pcRef = useRef(null);
  const filesBufferRef = useRef([]);

  function updateStep(s) { stepRef.current = s; setStep(s); }

  useEffect(() => {
    fetchProjects()
      .then((list) => { setProjects(list); setUseLocalAPI(true); })
      .catch(() => setUseLocalAPI(false));
    return () => { sigRef.current?.close(); pcRef.current?.close(); };
  }, []);

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

  // Native OS folder picker; resolve full path via sentinel file + local server
  async function handleBrowse() {
    setError('');
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      setBrowseResolving(true);

      const sentinel = `.claude-share-${Date.now()}`;
      const fh = await handle.getFileHandle(sentinel, { create: true });
      const writable = await fh.createWritable();
      await writable.write('tmp');
      await writable.close();

      try {
        const res = await fetch(`${LOCAL_API}/resolve-tmp?name=${encodeURIComponent(sentinel)}`);
        const data = await res.json().catch(() => null);
        if (data?.dir) {
          setCustomPath(data.dir);
        } else {
          setError(data?.error || 'Could not resolve path — please restart the server and try again, or type the path manually.');
        }
      } finally {
        await handle.removeEntry(sentinel).catch(() => {});
        setBrowseResolving(false);
      }
    } catch (e) {
      setBrowseResolving(false);
      if (e.name !== 'AbortError') setError(e.message);
    }
  }

  // Fallback when no local server: FSA write directly to picked folder
  async function handleBrowseFallback() {
    try {
      const dir = await window.showDirectoryPicker({ id: 'claude-save', mode: 'readwrite' });
      setSaveFolderHandle(dir);
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
    }
  }

  async function handleSave() {
    const files = filesBufferRef.current;
    if (!files.length) return;
    setError('');
    try {
      if (useLocalAPI && !showCustom && selectedFolder) {
        for (const f of files) await saveToProject({ folder: selectedFolder, name: f.name, content: f.content });
      } else if (useLocalAPI && showCustom) {
        if (!customPath.trim()) { setError('Select or type a project path'); return; }
        for (const f of files) await saveToProject({ projectPath: customPath.trim(), name: f.name, content: f.content });
      } else if (!useLocalAPI && saveFolderHandle) {
        for (const f of files) await saveSessionFile(saveFolderHandle, f.name, f.content);
      } else {
        setError('No save destination selected');
        return;
      }
      updateStep('saved');
    } catch (e) {
      setError(e.message);
    }
  }

  const canSave = useLocalAPI
    ? (showCustom ? customPath.trim().length > 0 : selectedFolder !== null)
    : saveFolderHandle !== null;

  const progressPct = progress ? Math.round((progress.received / progress.total) * 100) : 0;
  const totalSize = receivedFiles.reduce((acc, f) => acc + f.content.length, 0);

  const sortedProjects = [...projects].sort((a, b) => {
    if (a.displayPath === '~') return 1;
    if (b.displayPath === '~') return -1;
    return a.displayPath.localeCompare(b.displayPath);
  });
  const filteredProjects = sortedProjects.filter((p) =>
    p.displayPath !== '~' &&
    p.displayPath.toLowerCase().includes(filterText.toLowerCase())
  );

  function resetState() {
    updateStep('idle');
    setCodeInput(''); setReceivedFiles([]); setProgress(null);
    setTransferDone(false); setSelectedFolder(null);
    setCustomPath(''); setShowCustom(false); setSaveFolderHandle(null);
    filesBufferRef.current = [];
  }

  const DestinationPicker = () => (
    <div className="border-t border-gray-800 pt-4 mt-2">
      <p className="text-gray-500 text-xs mb-3">Save to Claude project:</p>

      {useLocalAPI ? (
        <>
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
                    {p.displayPath === '~' && <span className="text-yellow-600 ml-2">home dir</span>}
                    <span className="text-gray-600 ml-2">({p.sessionCount})</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {showCustom && (
            <div className="mb-3 space-y-2">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={customPath}
                  onChange={(e) => setCustomPath(e.target.value)}
                  placeholder="~/projects/my-project"
                  className="flex-1 bg-gray-950 border border-gray-700 focus:border-blue-500 rounded-lg px-3 py-2 text-sm font-mono text-gray-300 placeholder-gray-600 outline-none transition-colors"
                />
                <button
                  onClick={handleBrowse}
                  disabled={browseResolving}
                  className="px-3 py-2 border border-gray-700 hover:border-blue-500 text-gray-300 hover:text-white text-sm rounded-lg transition-colors disabled:opacity-50 shrink-0"
                >
                  {browseResolving ? '…' : 'Browse'}
                </button>
              </div>
              {customPath && !customPath.startsWith('~') && !customPath.startsWith('/') && (
                <p className="text-yellow-600 text-xs">Treated as <code className="bg-gray-800 px-1 rounded">~/{customPath}</code></p>
              )}
              <p className="text-gray-600 text-xs">
                Press <kbd className="bg-gray-800 px-1 rounded">Ctrl+H</kbd> in the picker to show hidden folders.
                The project directory will be created automatically.
              </p>
            </div>
          )}

          <button
            onClick={() => { setShowCustom(!showCustom); setSelectedFolder(null); setCustomPath(''); }}
            className="text-gray-600 hover:text-gray-400 text-xs transition-colors"
          >
            {showCustom ? '← Pick existing project' : '+ New project / custom path'}
          </button>
        </>
      ) : (
        <>
          <div className="bg-yellow-950 border border-yellow-900/50 rounded-lg px-3 py-2.5 mb-3">
            <p className="text-yellow-400 text-xs font-medium mb-1">Local server not running</p>
            <p className="text-yellow-700 text-xs mb-1">Session won't appear in <code className="bg-yellow-950 px-1">ccs</code> correctly without it.</p>
            <code className="text-green-400 text-xs">cd server &amp;&amp; node index.js</code>
          </div>
          {saveFolderHandle ? (
            <div className="flex items-center gap-2 px-3 py-2 bg-blue-900 border border-blue-600 rounded-lg mb-2">
              <span className="text-xs">📁</span>
              <span className="text-white text-xs font-mono truncate flex-1">{saveFolderHandle.name}</span>
              <button onClick={() => setSaveFolderHandle(null)} className="text-gray-400 hover:text-gray-200 text-xs">Change</button>
            </div>
          ) : (
            <button
              onClick={handleBrowseFallback}
              className="w-full border border-gray-700 hover:border-blue-500 text-gray-300 text-sm font-medium py-2.5 rounded-xl transition-colors"
            >
              Browse Folder…
            </button>
          )}
          <p className="text-gray-600 text-xs mt-2 text-center">
            Navigate to <code className="bg-gray-800 px-1 rounded">~/.claude/projects/</code> and pick or create a subfolder.
            Press <kbd className="bg-gray-800 px-1 rounded">Ctrl+H</kbd> for hidden folders.
          </p>
        </>
      )}

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

            <DestinationPicker />

            {transferDone && (
              <>
                {canSave && (
                  <p className="text-xs text-center mt-4 mb-1 font-mono text-green-400 truncate">
                    → {useLocalAPI
                        ? (showCustom
                            ? (customPath.startsWith('~') || customPath.startsWith('/') ? customPath : `~/${customPath}`)
                            : sortedProjects.find(p => p.folder === selectedFolder)?.displayPath)
                        : saveFolderHandle?.name}
                  </p>
                )}
                <button
                  onClick={handleSave}
                  disabled={!canSave}
                  className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-xl transition-colors"
                >
                  {canSave ? 'Save Session' : 'Select a destination above'}
                </button>
              </>
            )}
            {!transferDone && canSave && (
              <p className="text-gray-600 text-xs text-center mt-3">Destination ready — saving when transfer completes</p>
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
