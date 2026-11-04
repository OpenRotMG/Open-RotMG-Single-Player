import type { View } from './runtime';
import type { ImportPreview, SaveResult } from './saves';
declare global {
  interface Window { launcher: {
    status(): Promise<View>; start(): Promise<void>; stop(): Promise<void>; client(): Promise<void>; help(): Promise<void>;
    importPlayer(): Promise<ImportPreview | undefined>; confirmImport(expected: string, password: string, confirmation: string, replace: boolean): Promise<SaveResult | undefined>; cancelImport(): Promise<boolean>;
    makeBackup(): Promise<SaveResult>; openBackupFolder(): Promise<SaveResult>; restoreBackup(): Promise<SaveResult | undefined>;
    changed(callback: (view: View) => void): void;
  } }
}
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const start = element<HTMLButtonElement>('start'), stop = element<HTMLButtonElement>('stop'), client = element<HTMLButtonElement>('client');
const password = element<HTMLInputElement>('password'), confirmation = element<HTMLInputElement>('confirmation');
let preview: ImportPreview | undefined;
let submitting = false;
function clearPasswords() { password.value = ''; confirmation.value = ''; }
function render(view: View) {
  element('status').textContent = view.status.toUpperCase();
  element('message').textContent = view.operation ? `${view.operation} — ${view.message}` : view.message;
  element('diagnostics').textContent = `Detailed logs: ${view.diagnostics}`;
  element('logs').textContent = view.logs.join('\n');
  const busy = !!view.operation || view.closing;
  if (view.closing || (submitting && !view.operation)) hidePreview();
  start.disabled = busy || view.status !== 'stopped';
  stop.disabled = busy || !['starting', 'ready'].includes(view.status);
  client.disabled = busy || view.status !== 'ready';
  for (const id of ['import', 'backup', 'folder', 'restore']) element<HTMLButtonElement>(id).disabled = busy || !['stopped', 'ready'].includes(view.status);
}
const invoke = (action: () => Promise<unknown>) => { element('error').textContent = ''; void action().catch(error => { element('error').textContent = String(error); }); };
function result(value: SaveResult | undefined) {
  if (value) element('save-result').textContent = [value.message, value.disclosure, value.path].filter(Boolean).join('\n');
}
function hidePreview() { preview = undefined; clearPasswords(); element('import-preview').hidden = true; }
start.onclick = () => invoke(() => window.launcher.start());
stop.onclick = () => invoke(() => window.launcher.stop());
client.onclick = () => invoke(() => window.launcher.client());
element('help').onclick = () => invoke(() => window.launcher.help());
element('import').onclick = () => invoke(async () => {
  hidePreview(); element('save-result').textContent = '';
  const selected = await window.launcher.importPlayer();
  if (!selected) return;
  preview = selected; clearPasswords();
  element('import-summary').textContent = `${selected.name} · exported ${new Date(selected.exported_at * 1000).toISOString()} · ${selected.character_count} owned characters (including dead/deleted)\n${selected.disclosure}`;
  element<HTMLInputElement>('local-login').value = selected.login;
  element('replace-warning').hidden = !selected.replaced;
  element('import-confirm').textContent = selected.replaced ? 'Back up and replace this player' : 'Import player';
  element('import-preview').hidden = false;
});
element('import-confirm').onclick = () => invoke(async () => {
  if (!preview || submitting) return;
  const selected = preview;
  submitting = true;
  element<HTMLButtonElement>('import-confirm').disabled = true;
  element<HTMLButtonElement>('import-cancel').disabled = true;
  let outcome: Promise<SaveResult | undefined>;
  try {
    outcome = window.launcher.confirmImport(selected.expected, password.value, confirmation.value, selected.replaced);
    clearPasswords();
    result(await outcome); hidePreview();
  } finally {
    clearPasswords(); submitting = false;
    element<HTMLButtonElement>('import-confirm').disabled = false;
    element<HTMLButtonElement>('import-cancel').disabled = false;
  }
});
element('import-cancel').onclick = () => invoke(async () => {
  if (submitting) return;
  clearPasswords(); const canceled = await window.launcher.cancelImport(); hidePreview();
  if (!canceled) throw new Error('No pending preview was canceled. The import may already have completed; inspect its outcome before trying again.');
});
const saveAction = (action: () => Promise<SaveResult | undefined>) => invoke(async () => { element('save-result').textContent = ''; result(await action()); });
element('backup').onclick = () => saveAction(() => window.launcher.makeBackup());
element('folder').onclick = () => saveAction(() => window.launcher.openBackupFolder());
element('restore').onclick = () => saveAction(() => window.launcher.restoreBackup());
window.addEventListener('pagehide', clearPasswords);
window.launcher.changed(render);
invoke(async () => render(await window.launcher.status()));
