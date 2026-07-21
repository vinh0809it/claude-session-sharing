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
  getCwdFromProjectHandle,
  homeFromHandle,
  getProjectsHandle,
} from '../lib/projectUtils';

export default function Receiver({ onBack }) {
  const [step, setStep] = useState('idle');
  const [codeInput, setCodeInput] = useState('');
  const [progress, setProgress] = useState(null);
  const [transferDone, setTransferDone] = useState(false);
  const [receivedFiles, setReceivedFiles] = useState([]);
  const [error, setError] = useState('');

  const [projects, setProjects] = useState([]);
  const [filterText, setFilterText] = useState('');
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customPath, setCustomPath] = useState('');

  // FSA state
  const [fsaHandle, setFsaHandle] = useState(null);
  const [fsaHome, setFsaHome] = useState('');
  const [fsaReady, setFsaReady] = useState(false);

  const stepRef = useRef('idle');
  const sigRef = useRef(null);
  const pcRef = useRef(null);
  const filesBufferRef = useRef([]);

  function updateStep(s) { stepRef.current = s; setStep(s); }

  useEffect(() => {
    (async () => {
      const handle = await dbGet('claudeHandle').catch(() => null);
      const home = await dbGet('home').catch(() => null);
      if (handle && home) {
        const perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          await initFsa(handle, home);
          return;
        }
        setFsaHandle(handle);
        setFsaHome(home);
      }
      // else: no handle stored — will show setup in DestinationPicker
    })();
    return () => { sigRef.current?.close(); pcRef.current?.close(); };
  }, []);

  async function initFsa(handle, home) {
    setFsaHandle(handle);
    setFsaHome(home);
    const list = await listProjectsFromHandle(handle, home);
    setProjects(list);
    setFsaReady(true);
  }

  async function handleReconnect() {
    setError('');
    try {
      const perm = await fsaHandle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') await initFsa(fsaHandle, fsaHome);
      // permission denied — user will need to re-pick
    } catch (e) { setError(e.message); }
  }

  async function handlePickFolder() {
    setError('');
    try {
      const homeHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      const home = homeFromHandle(homeHandle);
      const projectsHandle = await getProjectsHandle(homeHandle);
      await dbSet('claudeHandle', projectsHandle);
      await dbSet('home', home);
      await initFsa(projectsHandle, home);
    } catch (e) {
      if (e.name === 'NotFoundError') setError('Could not find .claude/projects inside that folder. Make sure you picked your home directory.');
      else if (e.name !== 'AbortError') setError(e.message);
    }
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
    if (!files.length || !fsaHandle) return;
    setError('');
    try {
      let absPath, folder;
      if (showCustom) {
        let p = customPath.trim();
        if (!p) { setError('Enter a destination path'); return; }
        if (p.startsWith('~')) p = fsaHome + p.slice(1);
        else if (!p.startsWith('/')) p = fsaHome + '/' + p;
        absPath = p;
        folder = pathToFolder(absPath, fsaHome);
      } else {
        if (!selectedFolder) { setError('Select a project'); return; }
        folder = selectedFolder;
        const projHandle = await fsaHandle.getDirectoryHandle(folder);
        absPath = await getCwdFromProjectHandle(projHandle);
        if (!absPath) {
          // no existing sessions — fall back (naive decode, may be wrong for names with dashes)
          absPath = folderToDisplayPath(folder, fsaHome);
          if (absPath.startsWith('~')) absPath = fsaHome + absPath.slice(1);
        }
      }
      for (const f of files) {
        await saveToHandle(fsaHandle, folder, f.name, rewriteCwd(f.content, absPath));
      }
      updateStep('saved');
    } catch (e) {
      setError(e.message);
    }
  }

  const canSave = fsaReady && (showCustom ? customPath.trim().length > 0 : selectedFolder !== null);
  const pct = progress ? Math.round((progress.received / progress.total) * 100) : 0;
  const totalSize = receivedFiles.reduce((acc, f) => acc + f.content.length, 0);
  const filtered = projects.filter((p) => p.displayPath.toLowerCase().includes(filterText.toLowerCase()));

  function resetState() {
    updateStep('idle');
    setCodeInput(''); setReceivedFiles([]); setProgress(null);
    setTransferDone(false); setSelectedFolder(null);
    setCustomPath(''); setShowCustom(false);
    filesBufferRef.current = [];
  }

  const SetupInline = () => {
    if (fsaReady) return null;
    if (fsaHandle && fsaHome) {
      return (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-3">
          <p className="text-gray-400 text-xs mb-2">Re-grant access to <code className="bg-gray-800 px-1 rounded">~/.claude/projects</code> to save here.</p>
          <button onClick={handleReconnect} className="w-full bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium py-1.5 rounded-lg transition-colors">Grant Access</button>
          {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
        </div>
      );
    }
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-3">
        <p className="text-white text-xs font-medium mb-1">One-time setup</p>
        <p className="text-gray-500 text-xs mb-3">Pick your home directory (e.g. <code className="bg-gray-800 px-1 rounded">/home/username</code>). The app finds your Claude sessions automatically.</p>
        <button onClick={handlePickFolder} className="w-full bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium py-1.5 rounded-lg transition-colors">Pick Home Directory</button>
        {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
      </div>
    );
  };

  const DestinationPicker = () => (
    <div className="border-t border-gray-800 pt-4 mt-2">
      <p className="text-gray-500 text-xs mb-3">Save to Claude project:</p>
      <SetupInline />
      {fsaReady && (
        <>
          {!showCustom && (
            <>
              {projects.length > 5 && (
                <input type="text" placeholder="Filter…" value={filterText} onChange={(e) => setFilterText(e.target.value)}
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-300 placeholder-gray-600 outline-none mb-2" />
              )}
              <div className="max-h-44 overflow-y-auto space-y-1 mb-2">
                {filtered.map((p) => (
                  <button key={p.folder} onClick={() => setSelectedFolder(p.folder)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors ${
                      selectedFolder === p.folder
                        ? 'bg-blue-900 border border-blue-600 text-white'
                        : 'bg-gray-950 border border-gray-800 text-gray-300 hover:border-gray-600'
                    }`}>
                    <span className="font-mono">{p.displayPath}</span>
                    <span className="text-gray-600 ml-2">({p.sessionCount})</span>
                  </button>
                ))}
                {filtered.length === 0 && <p className="text-gray-600 text-xs px-2 py-1">No projects found.</p>}
              </div>
            </>
          )}
          {showCustom && (
            <div className="mb-3">
              <input type="text" value={customPath} onChange={(e) => setCustomPath(e.target.value)}
                placeholder="~/projects/my-project"
                className="w-full bg-gray-950 border border-gray-700 focus:border-blue-500 rounded-lg px-3 py-2 text-sm font-mono text-gray-300 placeholder-gray-600 outline-none" />
              {customPath && !customPath.startsWith('~') && !customPath.startsWith('/') && (
                <p className="text-yellow-600 text-xs mt-1">Treated as <code className="bg-gray-800 px-1 rounded">~/{customPath}</code></p>
              )}
              <p className="text-gray-600 text-xs mt-1">The project folder will be created automatically.</p>
            </div>
          )}
          <button onClick={() => { setShowCustom(!showCustom); setSelectedFolder(null); setCustomPath(''); }}
            className="text-gray-600 hover:text-gray-400 text-xs transition-colors">
            {showCustom ? '← Pick existing project' : '+ New project / custom path'}
          </button>
        </>
      )}
      {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
    </div>
  );

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <button onClick={onBack} className="text-gray-500 hover:text-gray-300 text-sm mb-8 flex items-center gap-1 transition-colors">← Back</button>
        <h1 className="text-2xl font-bold text-white mb-8">Receive a Session</h1>

        {step === 'idle' && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8">
            <label className="block text-gray-400 text-sm mb-2">Enter the 6-character code from the sender:</label>
            <input type="text" value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
              onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
              placeholder="ABCDEF"
              className="w-full bg-gray-950 border border-gray-700 focus:border-blue-500 rounded-xl px-4 py-3 text-2xl font-mono tracking-[0.3em] text-white text-center placeholder-gray-700 outline-none transition-colors"
              spellCheck={false} />
            {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
            <button onClick={handleConnect} disabled={codeInput.length !== 6}
              className="mt-4 w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-xl transition-colors">
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
                  <div className="bg-blue-500 h-1.5 rounded-full transition-all duration-200" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )}
            <DestinationPicker />
            {transferDone && (
              <>
                {canSave && (
                  <p className="text-xs text-center mt-4 mb-1 font-mono text-green-400 truncate">
                    → {showCustom
                        ? (customPath.startsWith('~') || customPath.startsWith('/') ? customPath : `~/${customPath}`)
                        : projects.find((p) => p.folder === selectedFolder)?.displayPath}
                  </p>
                )}
                <button onClick={handleSave} disabled={!canSave}
                  className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-xl transition-colors mt-3">
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
            <button onClick={resetState} className="bg-gray-800 hover:bg-gray-700 text-white text-sm px-5 py-2 rounded-xl transition-colors mr-3">Receive Another</button>
            <button onClick={onBack} className="text-gray-500 hover:text-gray-300 text-sm transition-colors">Go Home</button>
          </div>
        )}

        {step === 'error' && (
          <div className="bg-gray-900 border border-red-900 rounded-2xl p-8 text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <p className="text-red-400 font-medium mb-4">{error}</p>
            <button onClick={() => { updateStep('idle'); setError(''); }} className="bg-gray-800 hover:bg-gray-700 text-white text-sm px-5 py-2 rounded-xl transition-colors">Try Again</button>
          </div>
        )}
      </div>
    </div>
  );
}
