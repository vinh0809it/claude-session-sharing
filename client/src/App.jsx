import { useState } from 'react';
import Home from './pages/Home';
import Sender from './pages/Sender';
import Receiver from './pages/Receiver';

export default function App() {
  const [page, setPage] = useState('home');

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {page === 'home' && (
        <Home onSend={() => setPage('sender')} onReceive={() => setPage('receiver')} />
      )}
      {page === 'sender' && <Sender onBack={() => setPage('home')} />}
      {page === 'receiver' && <Receiver onBack={() => setPage('home')} />}
    </div>
  );
}
