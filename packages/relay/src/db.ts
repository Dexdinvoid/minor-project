import Database from 'better-sqlite3';

export interface InboxRow {
  inboxId: string;
  inboxPub: string;
  kind: 'random' | 'first';
  createdAt: number;
}

export interface MessageRow {
  msgId: string;
  inboxId: string;
  bytes: Buffer;
  receivedAt: number;
}

/** SQLite in WAL mode with a single writer connection and short transactions (pitfall S10). */
export class RelayDb {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inboxes (
        inboxId TEXT PRIMARY KEY, inboxPub TEXT NOT NULL, kind TEXT NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        msgId TEXT PRIMARY KEY, inboxId TEXT NOT NULL, bytes BLOB NOT NULL, receivedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(inboxId, receivedAt);
      CREATE TABLE IF NOT EXISTS challenges (
        nonce TEXT PRIMARY KEY, inboxId TEXT NOT NULL, expiresAt INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS rest_sigs (sigHash TEXT PRIMARY KEY, seenAt INTEGER NOT NULL);
    `);
  }

  registerInbox(row: InboxRow): 'created' | 'exists' | 'conflict' {
    const existing = this.getInbox(row.inboxId);
    if (existing) return existing.inboxPub === row.inboxPub ? 'exists' : 'conflict';
    this.db
      .prepare('INSERT INTO inboxes (inboxId, inboxPub, kind, createdAt) VALUES (?, ?, ?, ?)')
      .run(row.inboxId, row.inboxPub, row.kind, row.createdAt);
    return 'created';
  }

  getInbox(inboxId: string): InboxRow | undefined {
    return this.db.prepare('SELECT * FROM inboxes WHERE inboxId = ?').get(inboxId) as InboxRow | undefined;
  }

  pendingCount(inboxId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE inboxId = ?').get(inboxId) as { c: number }).c;
  }

  /** Atomic cap check + insert so concurrent posts cannot exceed the limit. */
  enqueue(msg: MessageRow, cap: number): boolean {
    const tx = this.db.transaction((m: MessageRow) => {
      if (this.pendingCount(m.inboxId) >= cap) return false;
      this.db
        .prepare('INSERT INTO messages (msgId, inboxId, bytes, receivedAt) VALUES (?, ?, ?, ?)')
        .run(m.msgId, m.inboxId, m.bytes, m.receivedAt);
      return true;
    });
    return tx(msg);
  }

  listMessages(inboxId: string, limit = 200): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE inboxId = ? ORDER BY receivedAt ASC, rowid ASC LIMIT ?')
      .all(inboxId, limit) as MessageRow[];
  }

  ack(inboxId: string, msgId: string): boolean {
    return this.db.prepare('DELETE FROM messages WHERE inboxId = ? AND msgId = ?').run(inboxId, msgId).changes === 1;
  }

  createChallenge(nonce: string, inboxId: string, expiresAt: number): void {
    this.db.prepare('INSERT INTO challenges (nonce, inboxId, expiresAt, used) VALUES (?, ?, ?, 0)').run(nonce, inboxId, expiresAt);
  }

  /** Single use + expiry in one atomic statement (pitfall S8). */
  consumeChallenge(nonce: string, inboxId: string, now: number): boolean {
    return (
      this.db
        .prepare('UPDATE challenges SET used = 1 WHERE nonce = ? AND inboxId = ? AND used = 0 AND expiresAt > ?')
        .run(nonce, inboxId, now).changes === 1
    );
  }

  /** Returns false if this REST signature was already seen (replay). */
  rememberRestSig(sigHash: string, now: number): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO rest_sigs (sigHash, seenAt) VALUES (?, ?)').run(sigHash, now).changes === 1;
  }

  /** TTL cleanup: messages older than ttl, expired/used challenges, old REST signatures. */
  purge(now: number, messageTtlMs: number, restWindowMs: number): { messages: number } {
    const messages = this.db.prepare('DELETE FROM messages WHERE receivedAt < ?').run(now - messageTtlMs).changes;
    this.db.prepare('DELETE FROM challenges WHERE expiresAt < ? OR used = 1').run(now);
    this.db.prepare('DELETE FROM rest_sigs WHERE seenAt < ?').run(now - 2 * restWindowMs);
    return { messages };
  }

  /** Used by tests to prove the relay stores only opaque bytes. */
  rawMessageBytes(msgId: string): Buffer | undefined {
    return (this.db.prepare('SELECT bytes FROM messages WHERE msgId = ?').get(msgId) as { bytes: Buffer } | undefined)?.bytes;
  }

  close(): void {
    this.db.close();
  }
}
