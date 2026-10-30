import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initCrypto } from '@sc/crypto';
import App from './App';
import './index.css';

// Pitfall C1: libsodium must be ready before any crypto call.
void initCrypto().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
