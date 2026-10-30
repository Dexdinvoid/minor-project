import { useEffect, useRef, useState } from 'react';
import type { Hex } from '@sc/shared';
import { Button, Field, StatusChip, short } from '../ui/kit';
import { VerifyPanel } from '../ui/VerifyPanel';
import { messenger } from '../services/app';
import { useUi } from '../store';

export function Chat() {
  const { me, contacts, sessions, activePeer, messages, conn, verifyingId, setActivePeer, openVerify } = useUi();
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [text, setText] = useState('');
  const [verifiable, setVerifiable] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ block: 'end' }), [messages.length]);

  const peer = contacts.find((c) => c.userId === activePeer);
  const session = activePeer ? sessions[activePeer] : undefined;
  const isVerifiable = session?.verifiable ?? verifiable;

  async function addContact() {
    setErr('');
    try {
      const c = await messenger.addContact(newId, newName);
      setNewId('');
      setNewName('');
      setActivePeer(c.userId);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function send() {
    if (!activePeer || !text.trim()) return;
    const t = text;
    setText('');
    setErr('');
    try {
      await messenger.send(activePeer, t, isVerifiable);
    } catch (e) {
      setErr((e as Error).message);
      setText(t);
    }
  }

  async function toggleVerifiable() {
    const next = !isVerifiable;
    setVerifiable(next);
    if (session) await messenger.setVerifiable(session.convoId, next);
  }

  return (
    <div className="h-full grid grid-cols-[300px_1fr]">
      <nav aria-label="Contacts" className="bg-surface-soft border-r border-hairline p-4 flex flex-col gap-4 overflow-y-auto">
        <div>
          <p className="text-[12px] font-semibold tracking-[1.5px] uppercase text-primary">You</p>
          <p className="text-ink font-semibold">{me?.name}</p>
          <button
            className="font-mono text-[12px] text-muted hover:text-ink break-all text-left"
            onClick={() => { void navigator.clipboard.writeText(me!.userId); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
            aria-label="Copy your ID"
          >
            {short(me!.userId)} · {copied ? 'copied' : 'copy ID'}
          </button>
          <p className="text-[12px] mt-1" role="status">
            <span className={conn === 'online' ? 'text-success' : 'text-warning'}>● {conn}</span>
          </p>
        </div>
        <ul className="space-y-1">
          {contacts.map((c) => (
            <li key={c.userId}>
              <button
                onClick={() => setActivePeer(c.userId as Hex)}
                aria-current={c.userId === activePeer}
                className={`w-full text-left px-3 py-2 rounded-md ${c.userId === activePeer ? 'bg-surface-elevated text-ink' : 'hover:bg-surface-card'}`}
              >
                <span className="block font-medium">{c.name}</span>
                <span className="block font-mono text-[11px] text-muted">{short(c.userId)}</span>
              </button>
            </li>
          ))}
          {contacts.length === 0 && <li className="text-muted text-[13px]">No contacts yet. Paste a friend's ID below.</li>}
        </ul>
        <div className="mt-auto space-y-2 border-t border-hairline pt-4">
          <Field label="Contact ID" value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="0x…" />
          <Field label="Name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Bob" />
          <Button variant="secondary" className="w-full" disabled={!newId} onClick={() => void addContact()}>Add contact</Button>
        </div>
      </nav>

      <section className="flex flex-col min-h-0" aria-label="Conversation">
        {!peer ? (
          <div className="m-auto text-center max-w-sm">
            <h2 className="text-[32px] font-bold text-ink tracking-[-1px]">Pick a contact</h2>
            <p className="text-muted mt-2">Everything you send is encrypted on this device before it leaves.</p>
          </div>
        ) : (
          <>
            <header className="h-16 px-6 flex items-center justify-between border-b border-hairline">
              <div>
                <h2 className="text-ink font-semibold text-[18px]">{peer.name}</h2>
                <p className="font-mono text-[11px] text-muted">{short(peer.userId)}</p>
              </div>
              <label className="flex items-center gap-2 text-[13px] text-body-strong cursor-pointer">
                <input type="checkbox" checked={isVerifiable} onChange={() => void toggleVerifiable()} className="accent-[#faff69]" />
                Verifiable mode
              </label>
            </header>
            {isVerifiable && (
              <p className="px-6 py-2 text-[12px] bg-surface-card text-warning border-b border-hairline">
                Messages you send are signed. That gives proof of authorship, but you can no longer deny having sent them.
              </p>
            )}
            <div className="flex-1 overflow-y-auto p-6 space-y-3" role="log" aria-live="polite">
              {messages.map((m) => (
                <div key={m.id} className={`max-w-[70%] ${m.direction === 'out' ? 'ml-auto text-right' : ''}`}>
                  <div className={`inline-block text-left px-4 py-2 rounded-lg ${m.direction === 'out' ? 'bg-primary text-on-primary' : 'bg-surface-elevated text-ink'}`}>{m.text}</div>
                  <div className="mt-1 flex gap-3 items-center justify-end text-[12px]">
                    {m.status === 'UploadFailed' ? (
                      <button className="text-error underline" onClick={() => void messenger.send(peer.userId as Hex, m.text, isVerifiable, m.id)}>
                        Failed to send · retry
                      </button>
                    ) : (
                      <StatusChip status={m.status} />
                    )}
                    {m.sig && <button className="text-primary underline" onClick={() => openVerify(m.id!)}>Verify</button>}
                  </div>
                </div>
              ))}
              <div ref={endRef} />
            </div>
            {err && <p role="alert" className="px-6 text-error text-[13px]">{err}</p>}
            <div className="p-4 border-t border-hairline flex gap-2">
              <input
                aria-label="Message" value={text} onChange={(e) => setText(e.target.value)} maxLength={4000}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && void send()}
                placeholder="Write a message"
                className="flex-1 h-10 px-3.5 rounded-md bg-surface-soft border border-hairline-strong text-ink placeholder:text-muted-soft focus:border-primary"
              />
              <Button onClick={() => void send()} disabled={!text.trim()}>Send</Button>
            </div>
          </>
        )}
      </section>
      {verifyingId !== null && <VerifyPanel messageId={verifyingId} onClose={() => openVerify(null)} />}
    </div>
  );
}
