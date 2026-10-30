import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { MessageStatus } from '@sc/shared';

export function Button({ variant = 'primary', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' }) {
  const base = 'h-10 px-5 rounded-md text-sm font-semibold transition-colors disabled:cursor-not-allowed';
  const v = {
    primary: 'bg-primary text-on-primary hover:bg-primary-active disabled:bg-primary-disabled disabled:text-muted',
    secondary: 'bg-surface-elevated text-ink border border-hairline-strong hover:bg-surface-card disabled:text-muted-soft',
    ghost: 'text-body hover:text-ink hover:bg-surface-card disabled:text-muted-soft',
  }[variant];
  return <button className={`${base} ${v} ${className}`} {...p} />;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-surface-card border border-hairline rounded-lg p-6 ${className}`}>{children}</div>;
}

export function Field({ label, ...p }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="block text-[13px] font-medium text-body-strong mb-1">{label}</span>
      <input
        className="w-full h-10 px-3.5 rounded-md bg-surface-soft border border-hairline-strong text-ink placeholder:text-muted-soft focus:border-primary"
        {...p}
      />
    </label>
  );
}

/** Plain-language status labels: no cryptographic jargon in the main UI (pitfall U1). */
const STATUS: Record<MessageStatus, { label: string; tone: string }> = {
  Composed: { label: 'Encrypting…', tone: 'text-muted' },
  Encrypted: { label: 'Encrypting…', tone: 'text-muted' },
  UploadFailed: { label: 'Failed to send · tap to retry', tone: 'text-error' },
  Uploaded: { label: 'Sending…', tone: 'text-muted' },
  Sent: { label: 'Sent', tone: 'text-body' },
  Delivered: { label: 'Delivered', tone: 'text-body' },
  Submitted: { label: 'Signed · waiting for proof', tone: 'text-warning' },
  Anchored: { label: 'Proof ready', tone: 'text-info' },
  Verified: { label: 'Verified', tone: 'text-success' },
  Invalid: { label: 'Could not verify', tone: 'text-error' },
  FetchPending: { label: 'Fetching…', tone: 'text-muted' },
};

export function StatusChip({ status }: { status: MessageStatus }) {
  const s = STATUS[status];
  return <span className={`text-[12px] font-medium ${s.tone}`}>{s.label}</span>;
}

export const short = (hex: string) => `${hex.slice(0, 8)}…${hex.slice(-6)}`;
