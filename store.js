// Everything is saved on this device (localStorage). Export a backup now and then.
const KEY = 'runplan.v1';

const blank = () => ({
  profile: null, plan: null, logs: {}, extras: [], vdotHistory: [],
  sync: { athleteId: '0', apiKey: '', lastSync: null, imported: [] },
  seen: {}, lastBackup: null,
});

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...blank(), ...JSON.parse(raw) } : blank();
  } catch {
    return blank();
  }
}

export function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); return true; } catch { return false; }
}

export function exportFile(state) {
  // The API key is left out so the backup file is safe to keep anywhere.
  const copy = { ...state, sync: { ...state.sync, apiKey: '' } };
  const blob = new Blob([JSON.stringify(copy, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `runplan-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function importFile(file, current) {
  const data = JSON.parse(await file.text());
  if (!data || typeof data !== 'object' || !('plan' in data) || !('logs' in data)) throw new Error('Not a Runplan backup file');
  return { ...blank(), ...data, sync: { ...blank().sync, ...data.sync, apiKey: current.sync.apiKey } };
}

export const reset = () => localStorage.removeItem(KEY);
