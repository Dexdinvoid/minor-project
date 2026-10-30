import Database from 'better-sqlite3';
import type { Hex } from '@sc/shared';

export interface LeafRow {
  leaf: Hex;
  commitment: Hex;
  sig: string;
  senderUserId: Hex;
  convoId: Hex;
  seq: number;
  createdAt: number;
  status: 'pending' | 'anchored';
  batchId: number | null;
  proof: string | null; // JSON Hex[]
}

export interface BatchRow {
  batchId: number;
  root: Hex;
  txHash: Hex;
  anchoredAt: number;
  leafCount: number;
  gasUsed: string;
  gasPrice: string;
}

export class BatcherDb {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leaves (
        leaf TEXT PRIMARY KEY, commitment TEXT NOT NULL, sig TEXT NOT NULL,
        senderUserId TEXT NOT NULL, convoId TEXT NOT NULL, seq INTEGER NOT NULL,
        createdAt INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        batchId INTEGER, proof TEXT,
        UNIQUE (senderUserId, convoId, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_leaves_status ON leaves(status, createdAt);
      CREATE TABLE IF NOT EXISTS batches (
        batchId INTEGER PRIMARY KEY, root TEXT NOT NULL, txHash TEXT NOT NULL, anchoredAt INTEGER NOT NULL,
        leafCount INTEGER NOT NULL, gasUsed TEXT NOT NULL, gasPrice TEXT NOT NULL
      );
    `);
  }

  findBySeq(senderUserId: string, convoId: string, seq: number): LeafRow | undefined {
    return this.db.prepare('SELECT * FROM leaves WHERE senderUserId = ? AND convoId = ? AND seq = ?').get(senderUserId, convoId, seq) as LeafRow | undefined;
  }

  getLeaf(leaf: string): LeafRow | undefined {
    return this.db.prepare('SELECT * FROM leaves WHERE leaf = ?').get(leaf) as LeafRow | undefined;
  }

  insertLeaf(r: Omit<LeafRow, 'status' | 'batchId' | 'proof'>): void {
    this.db.prepare('INSERT INTO leaves (leaf, commitment, sig, senderUserId, convoId, seq, createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(r.leaf, r.commitment, r.sig, r.senderUserId, r.convoId, r.seq, r.createdAt);
  }

  pending(limit: number): LeafRow[] {
    return this.db.prepare("SELECT * FROM leaves WHERE status = 'pending' ORDER BY createdAt ASC, rowid ASC LIMIT ?").all(limit) as LeafRow[];
  }

  pendingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM leaves WHERE status = 'pending'").get() as { c: number }).c;
  }

  /** Marks a batch anchored with all proofs in ONE transaction, so a crash never leaves half a batch. */
  commitBatch(b: BatchRow, proofs: Map<Hex, Hex[]>): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('INSERT INTO batches (batchId, root, txHash, anchoredAt, leafCount, gasUsed, gasPrice) VALUES (?,?,?,?,?,?,?)')
        .run(b.batchId, b.root, b.txHash, b.anchoredAt, b.leafCount, b.gasUsed, b.gasPrice);
      const upd = this.db.prepare("UPDATE leaves SET status = 'anchored', batchId = ?, proof = ? WHERE leaf = ?");
      for (const [leaf, proof] of proofs) upd.run(b.batchId, JSON.stringify(proof), leaf);
    });
    tx();
  }

  getBatch(batchId: number): BatchRow | undefined {
    return this.db.prepare('SELECT * FROM batches WHERE batchId = ?').get(batchId) as BatchRow | undefined;
  }

  allBatches(): BatchRow[] {
    return this.db.prepare('SELECT * FROM batches ORDER BY batchId ASC').all() as BatchRow[];
  }

  lastAnchorAt(): number | null {
    return (this.db.prepare('SELECT MAX(anchoredAt) AS t FROM batches').get() as { t: number | null }).t;
  }

  close(): void {
    this.db.close();
  }
}
