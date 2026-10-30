import { Messenger } from './messenger';
import { Vault } from './vault';
import { useUi } from '../store';

/** Singletons live outside React so secret keys are never in component or Zustand state (pitfall U3). */
export const vault = new Vault();
export const messenger = new Messenger(vault, {
  onChange: () => void useUi.getState().refresh(),
  onConn: (s) => useUi.setState({ conn: s }),
});
