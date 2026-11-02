import type { View } from './runtime';
declare global {
  interface Window { launcher: { status(): Promise<View>; start(): Promise<void>; stop(): Promise<void>; client(): Promise<void>; help(): Promise<void>; changed(callback: (view: View) => void): void } }
}
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const start = element<HTMLButtonElement>('start'), stop = element<HTMLButtonElement>('stop'), client = element<HTMLButtonElement>('client');
function render(view: View) {
  element('status').textContent = view.status.toUpperCase();
  element('message').textContent = view.message;
  element('diagnostics').textContent = `Detailed logs: ${view.diagnostics}`;
  element('logs').textContent = view.logs.join('\n');
  start.disabled = view.status !== 'stopped';
  stop.disabled = !['starting', 'ready'].includes(view.status);
  client.disabled = view.status !== 'ready';
}
const invoke = (action: () => Promise<unknown>) => { element('error').textContent = ''; void action().catch(error => { element('error').textContent = String(error); }); };
start.onclick = () => invoke(() => window.launcher.start());
stop.onclick = () => invoke(() => window.launcher.stop());
client.onclick = () => invoke(() => window.launcher.client());
element('help').onclick = () => invoke(() => window.launcher.help());
window.launcher.changed(render);
invoke(async () => render(await window.launcher.status()));
