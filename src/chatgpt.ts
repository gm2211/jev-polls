import { execFile } from 'node:child_process';
import { createChatGptClient, type ChatGptClient } from '@byos/chatgpt-local';

export type ChatGptDraftClient = Pick<ChatGptClient, 'status' | 'accounts' | 'selectAccount' | 'signIn' | 'disconnect' | 'listModels' | 'generate'>;
export function createDraftClient(): ChatGptDraftClient {
  return createChatGptClient({ appName: 'Jev Polls', namespace: 'jev-polls-chatgpt', openBrowser: url => new Promise<void>((resolve, reject) => {
    // OAuth authorization URL contains no token or secret. Never pass credentials to a subprocess.
    if (process.platform !== 'darwin') { reject(new Error('Browser opener unavailable')); return; }
    execFile('/usr/bin/open', [url], error => error ? reject(new Error('Browser could not open')) : resolve());
  }) });
}
export function chatGptMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
  switch (code) {
    case 'quota': return 'ChatGPT usage limit reached. Review ChatGPT Settings → Usage or choose another drafting provider.';
    case 'reconnect-required': case 'consent-required': case 'auth-failed': return 'Reconnect ChatGPT and approve access, then try again.';
    case 'storage-unavailable': return 'ChatGPT credentials could not be stored securely. Check Keychain access.';
    case 'unsupported': return 'This ChatGPT account or model does not support this request. Choose another model or drafting provider.';
    case 'canceled': return 'ChatGPT request cancelled. Workspace unchanged.';
    default: return 'ChatGPT could not complete this request. Refresh the connection and retry. Workspace unchanged.';
  }
}

/** Only public account metadata crosses the local HTTP boundary. */
export class ChatGptConnection {
  private pending?: { controller: AbortController; work: Promise<void> };
  private message?: string;
  constructor(readonly client: ChatGptDraftClient) {}
  async snapshot() {
    const status = await this.client.status();
    return { connected: status.connected, planEnabled: status.planEnabled,
      ...(status.account ? { account: { id: status.account.id, label: status.account.label } } : {}),
      accounts: (await this.client.accounts()).map(account => ({ id: account.id, label: account.label, connected: account.connected })),
      signingIn: !!this.pending, ...(this.message ? { message: this.message } : {}) };
  }
  start(accountId?: string) {
    if (this.pending) return;
    this.message = undefined;
    const controller = new AbortController();
    const work = this.client.signIn({ signal: controller.signal, enablePlan: true, ...(accountId ? { accountId } : {}) })
      .then(() => { this.message = 'ChatGPT connected. Choose a drafting model.'; })
      .catch(error => { this.message = chatGptMessage(error); })
      .finally(() => { if (this.pending?.controller === controller) this.pending = undefined; });
    this.pending = { controller, work };
  }
  async cancel() { const pending = this.pending; pending?.controller.abort(); await pending?.work; }
  async disconnect() { await this.cancel(); const result = await this.client.disconnect(); this.message = result.revoked ? 'ChatGPT disconnected.' : 'ChatGPT removed from this app. Remote revocation could not be confirmed; review connected apps in ChatGPT.'; }
  async select(id: string) { await this.cancel(); await this.client.selectAccount(id); this.message = undefined; }
  async close() { await this.cancel(); }
}
