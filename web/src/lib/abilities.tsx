import { createContext, useContext } from 'react';
import type { AppInfo } from '@/lib/api';

const AbilitiesContext = createContext<AppInfo | null>(null);

export const AbilitiesProvider = AbilitiesContext.Provider;

// What this copy can spend on. A copy that does not say, as the private app does not, can do all of it.
export function useAbilities() {
  const app = useContext(AbilitiesContext);
  return { models: app?.models !== false, telegram: app?.telegram === true };
}
