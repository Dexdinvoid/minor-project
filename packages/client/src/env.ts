const e = import.meta.env;
export const ENV = {
  relayUrl: (e.VITE_RELAY_URL as string | undefined) ?? 'http://127.0.0.1:4000',
  batcherUrl: (e.VITE_BATCHER_URL as string | undefined) ?? 'http://127.0.0.1:4100',
  rpcUrl: (e.VITE_CHAIN_RPC_URL as string | undefined) ?? 'http://127.0.0.1:8545',
  keyRegistry: (e.VITE_KEY_REGISTRY_ADDRESS as string | undefined) ?? '',
  anchorRegistry: (e.VITE_ANCHOR_REGISTRY_ADDRESS as string | undefined) ?? '',
  explorerTx: (e.VITE_EXPLORER_TX_URL as string | undefined) ?? '', // e.g. https://sepolia.etherscan.io/tx/
};
export const wsUrl = (): string => ENV.relayUrl.replace(/^http/, 'ws') + '/ws';
