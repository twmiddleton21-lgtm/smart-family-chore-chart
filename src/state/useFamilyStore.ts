import { DATA_SOURCE } from '../config';
import { useApiFamilyStore } from './apiStore';
import { useLocalFamilyStore } from './localStore';

// The data source is fixed at build time (see vite.config.ts), so the same
// hook is used for the whole life of the page.
//   "local": browser localStorage (released behaviour, default build)
//   "api":   shared family server (development build: `npm run dev:api`)
export const useFamilyStore = DATA_SOURCE === 'api' ? useApiFamilyStore : useLocalFamilyStore;

export type { ActionResult, FamilyActions, FamilyStore } from './storeTypes';
