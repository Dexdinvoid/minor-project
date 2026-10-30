import { useEffect, useState } from 'react';
import { Button, Card, Field } from '../ui/kit';
import { messenger, vault } from '../services/app';
import { Vault } from '../services/vault';
import { useUi } from '../store';
import type { OnboardStep } from '../services/messenger';

const STEPS: Record<OnboardStep, string> = {
  keys: 'Creating your keys on this device…',
  upload: 'Publishing your public keys…',
  funding: 'Funding your test wallet…',
  register: 'Registering your ID on the public ledger…',
  inbox: 'Opening your private inbox…',
  done: 'Done',
};

export function Onboarding() {
  const phase = useUi((s) => s.phase);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [step, setStep] = useState<OnboardStep | null>(null);
  const [err, setErr] = useState('');
  const [hasId, setHasId] = useState(false);
  useEffect(() => void Vault.exists().then(setHasId), []);

  const locked = phase === 'locked' || hasId;
  const busy = step !== null && step !== 'done';

  async function go() {
    setErr('');
    try {
      if (locked) {
        await messenger.unlock(pw);
      } else {
        await messenger.onboard(name.trim(), pw, setStep);
      }
      useUi.getState().setMe({ userId: vault.userId, name: vault.name });
      useUi.getState().setPhase('ready');
      await useUi.getState().refresh();
    } catch (e) {
      setStep(null);
      setErr(locked ? 'Wrong passphrase.' : (e as Error).message);
    }
  }

  return (
    <main className="min-h-full grid place-items-center p-6">
      <div className="w-full max-w-md">
        <p className="text-[12px] font-semibold tracking-[1.5px] uppercase text-primary mb-3">Verifiable private messaging</p>
        <h1 className="text-[40px] leading-[1.05] font-bold text-ink tracking-[-1.5px] mb-3">
          {locked ? 'Welcome back.' : 'Messages only you can read. Proof anyone can check.'}
        </h1>
        <p className="mb-6 text-body">
          {locked ? 'Enter your passphrase to unlock this device.' : 'Your keys are created on this device and never leave it. Your passphrase protects them.'}
        </p>
        <Card className="space-y-4">
          {!locked && <Field label="Display name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Alice" maxLength={40} autoComplete="off" />}
          <Field
            label="Passphrase" type="password" value={pw} onChange={(e) => setPw(e.target.value)}
            placeholder={locked ? '' : 'At least 10 characters'} autoComplete={locked ? 'current-password' : 'new-password'}
            onKeyDown={(e) => e.key === 'Enter' && !busy && pw.length >= (locked ? 1 : 10) && void go()}
          />
          {!locked && <p className="text-[12px] text-muted">If you forget it, your identity cannot be recovered. There is no reset.</p>}
          {busy && step && <p role="status" className="text-primary text-[13px]">{STEPS[step]}</p>}
          {err && <p role="alert" className="text-error text-[13px]">{err}</p>}
          <Button className="w-full" disabled={busy || pw.length < (locked ? 1 : 10) || (!locked && !name.trim())} onClick={() => void go()}>
            {locked ? 'Unlock' : 'Create identity'}
          </Button>
        </Card>
      </div>
    </main>
  );
}
