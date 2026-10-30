import { useEffect, useState } from 'react';
import type { FlowFResult } from '@sc/ledger';
import type { VerifyOutcome } from '@sc/shared';
import { ENV } from '../env';
import { messenger } from '../services/app';
import { appDb, type MessageRow } from '../services/db';
import { Button } from './kit';

/** One result, plain language first (pitfalls U1, U2). Technical detail is secondary. */
const HEADLINE: Record<VerifyOutcome, { text: string; tone: string }> = {
  VERIFIED: { text: 'Verified. This message was sent by this person, at this time, and has not been changed.', tone: 'text-success' },
  PENDING: { text: 'Signed, but not on the public ledger yet. Check again in a minute.', tone: 'text-warning' },
  INVALID_SIGNATURE: { text: 'The signature does not match this sender. Do not trust this message.', tone: 'text-error' },
  KEY_MISMATCH: { text: "The sender's keys do not match the public registry. Do not trust this message.", tone: 'text-error' },
  INVALID_PROOF: { text: 'The proof does not match the public ledger. Do not trust this message.', tone: 'text-error' },
  CONTENT_ALTERED_OR_MISSING: { text: 'The stored message is missing or was changed after it was sent.', tone: 'text-error' },
};

export function VerifyPanel({ messageId, onClose }: { messageId: number; onClose: () => void }) {
  const [res, setRes] = useState<FlowFResult | null>(null);
  const [msg, setMsg] = useState<MessageRow | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(true);
  const [showTech, setShowTech] = useState(false);

  async function run() {
    setBusy(true);
    setErr('');
    try {
      setRes(await messenger.verify(messageId));
      setMsg((await appDb.messages.get(messageId)) ?? null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => void run(), [messageId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function exportPkg() {
    const json = await messenger.exportProof(messageId);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `proof-${messageId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <aside role="dialog" aria-label="Verify message" className="fixed inset-y-0 right-0 w-full max-w-md bg-surface-soft border-l border-hairline p-6 overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[24px] font-bold text-ink tracking-[-0.3px]">Verify message</h2>
        <Button variant="ghost" onClick={onClose} aria-label="Close">Close</Button>
      </div>
      {busy && <p role="status" className="text-primary">Checking the public ledger…</p>}
      {err && <p role="alert" className="text-error">{err}</p>}
      {res && (
        <>
          <p className={`text-[18px] font-semibold mb-5 ${HEADLINE[res.outcome].tone}`}>{HEADLINE[res.outcome].text}</p>
          {res.anchoredAt && <p className="text-muted mb-5">Recorded on {new Date(res.anchoredAt * 1000).toLocaleString()}</p>}
          <div className="flex gap-2 mb-5">
            <Button variant="secondary" onClick={() => void run()} disabled={busy}>Check again</Button>
            {msg?.anchor && <Button variant="secondary" onClick={() => void exportPkg()}>Export proof</Button>}
          </div>
          <button className="text-[13px] text-muted underline" onClick={() => setShowTech((v) => !v)} aria-expanded={showTech}>
            {showTech ? 'Hide' : 'Show'} technical details
          </button>
          {showTech && (
            <ol className="mt-3 space-y-2">
              {res.steps.map((s) => (
                <li key={s.id} className="text-[13px]">
                  <span className={s.status === 'pass' ? 'text-success' : s.status === 'fail' ? 'text-error' : 'text-muted-soft'}>
                    {s.status === 'pass' ? '✓' : s.status === 'fail' ? '✗' : '–'}
                  </span>{' '}
                  {s.label}
                  {s.detail && <div className="font-mono text-[12px] text-muted ml-4">{s.detail}</div>}
                </li>
              ))}
              {msg?.anchor && (
                <li className="font-mono text-[12px] text-muted break-all">
                  batch {msg.anchor.batchId} · tx{' '}
                  {ENV.explorerTx ? <a className="text-primary underline" href={ENV.explorerTx + msg.anchor.txHash} target="_blank" rel="noreferrer">{msg.anchor.txHash}</a> : msg.anchor.txHash}
                </li>
              )}
            </ol>
          )}
        </>
      )}
    </aside>
  );
}
