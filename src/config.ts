// Build-time configuration (see vite.config.ts).

declare const __SFCC_DATA_SOURCE__: string;

export type DataSource = 'local' | 'api';

/** "local" (browser storage, default) or "api" (shared-backend development build). */
export const DATA_SOURCE: DataSource = __SFCC_DATA_SOURCE__ === 'api' ? 'api' : 'local';
