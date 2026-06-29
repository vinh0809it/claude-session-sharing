export default function Home({ onSend, onReceive }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8">
      <div className="mb-12 text-center">
        <div className="text-5xl mb-4">⚡</div>
        <h1 className="text-4xl font-bold text-white mb-3">Claude Session Share</h1>
        <p className="text-gray-400 text-lg">Transfer Claude Code sessions peer-to-peer, instantly</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 w-full max-w-xl">
        <button
          onClick={onSend}
          className="bg-gray-900 hover:bg-gray-800 border border-gray-800 hover:border-purple-600 rounded-2xl p-8 text-left transition-all duration-150 group"
        >
          <div className="text-3xl mb-4 group-hover:scale-110 transition-transform duration-150">↑</div>
          <h2 className="text-xl font-semibold text-white mb-2">Share a Session</h2>
          <p className="text-gray-500 text-sm leading-relaxed">
            Pick a session from your machine and generate a 6-character code to share it.
          </p>
        </button>

        <button
          onClick={onReceive}
          className="bg-gray-900 hover:bg-gray-800 border border-gray-800 hover:border-blue-600 rounded-2xl p-8 text-left transition-all duration-150 group"
        >
          <div className="text-3xl mb-4 group-hover:scale-110 transition-transform duration-150">↓</div>
          <h2 className="text-xl font-semibold text-white mb-2">Receive a Session</h2>
          <p className="text-gray-500 text-sm leading-relaxed">
            Enter a code to receive a session directly from the sender's browser.
          </p>
        </button>
      </div>

      <p className="mt-10 text-gray-700 text-xs text-center">
        Sessions transfer directly between browsers — the server only brokers the connection, never sees your data.
      </p>
    </div>
  );
}
