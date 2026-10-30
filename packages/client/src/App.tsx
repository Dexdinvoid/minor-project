import { useEffect } from 'react';
import { Onboarding } from './pages/Onboarding';
import { Chat } from './pages/Chat';
import { Vault } from './services/vault';
import { useUi } from './store';

export default function App() {
  const phase = useUi((s) => s.phase);
  useEffect(() => {
    void Vault.exists().then((has) => useUi.getState().setPhase(has ? 'locked' : 'onboarding'));
  }, []);
  if (phase === 'loading') return <p role="status" className="p-6 text-muted">Loading…</p>;
  if (phase === 'ready') return <Chat />;
  return <Onboarding />;
}
