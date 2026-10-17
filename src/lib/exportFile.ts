import type { FamilyData, Settings } from '../types';

// The family-data export file format, shared by the browser app and the
// server. The legacy client-side PIN is never written to an export file.

export const EXPORT_APP = 'smart-family-chore-chart';
export const EXPORT_FORMAT = 1;

export type ExportedFamily = Omit<FamilyData, 'settings'> & { settings: Omit<Settings, 'parentPin'> };

export interface ExportFile {
  app: typeof EXPORT_APP;
  exportFormat: typeof EXPORT_FORMAT;
  exportedAt: string;
  source: 'server' | 'browser';
  data: ExportedFamily;
}

/** Remove the legacy PIN (if any) from family data. */
export function withoutPin(data: FamilyData | ExportedFamily): ExportedFamily {
  const { parentPin: _drop, ...settings } = data.settings as Settings;
  return { ...data, settings };
}

export function toExportFile(data: FamilyData | ExportedFamily, source: ExportFile['source'], now = new Date()): ExportFile {
  return { app: EXPORT_APP, exportFormat: EXPORT_FORMAT, exportedAt: now.toISOString(), source, data: withoutPin(data) };
}

export function exportFileName(date: string): string {
  return `chore-chart-export-${date}.json`;
}
