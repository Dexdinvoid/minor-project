import { create } from 'zustand';
import type { Hex } from '@sc/shared';
import { appDb, type ContactRow, type MessageRow, type SessionRow } from './services/db';
import type { ConnStatus } from './services/sync';

type Phase = 'loading' | 'onboarding' | 'locked' | 'ready';

interface UiState {
  phase: Phase;
  conn: ConnStatus;
  me: { userId: Hex; name: string } | null;
  contacts: ContactRow[];
  sessions: Record<string, SessionRow>;
  activePeer: Hex | null;
  messages: MessageRow[];
  verifyingId: number | null;
  setPhase: (p: Phase) => void;
  setMe: (m: { userId: Hex; name: string }) => void;
  setActivePeer: (p: Hex | null) => void;
  openVerify: (id: number | null) => void;
  refresh: () => Promise<void>;
}

export const useUi = create<UiState>((set, get) => ({
  phase: 'loading',
  conn: 'offline',
  me: null,
  contacts: [],
  sessions: {},
  activePeer: null,
  messages: [],
  verifyingId: null,
  setPhase: (phase) => set({ phase }),
  setMe: (me) => set({ me }),
  setActivePeer: (activePeer) => {
    set({ activePeer });
    void get().refresh();
  },
  openVerify: (verifyingId) => set({ verifyingId }),
  async refresh() {
    const [contacts, sessions] = await Promise.all([appDb.contacts.toArray(), appDb.sessions.toArray()]);
    const { activePeer, me } = get();
    let messages: MessageRow[] = [];
    if (activePeer && me) {
      const s = sessions.find((x) => x.peerUserId === activePeer);
      if (s) messages = await appDb.messages.where('convoId').equals(s.convoId).sortBy('ts');
    }
    set({ contacts, sessions: Object.fromEntries(sessions.map((s) => [s.peerUserId, s])), messages });
  },
}));
