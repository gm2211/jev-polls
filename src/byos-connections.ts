import { AsyncEntry } from '@napi-rs/keyring';
import type { ByosProvider, CatalogModel, SignInMethod } from '@byos/core';
import { claude, grok, groq, huggingface, openrouter, ProviderRequestError, CLAUDE_API_KEY_SETUP } from '@byos/providers';

/**
 * Drafting providers that come from BYOS (`@byos/providers`) and connect with a key the user pastes.
 * The workspace server is the user's own loopback process, so like `@byos/chatgpt-local` the key
 * lives in the OS credential store (macOS Keychain), never in workspace files, browser storage, logs
 * or HTTP responses. Requests go straight from this process to the provider's own host.
 */
export const BYOS_ENGINES = ['grok', 'openrouter', 'claude-api', 'groq', 'huggingface'] as const;
export type ByosEngine = typeof BYOS_ENGINES[number];
export const isByosEngine = (value: unknown): value is ByosEngine => (BYOS_ENGINES as readonly unknown[]).includes(value);

export interface ByosEngineInfo {
  id: ByosEngine; label: string; available: boolean; installed: boolean; authenticated: boolean; message: string;
  /** Present when the user connects by pasting a key: where to get one. */
  keyHint?: string; setup?: { label: string; url: string }[];
}
/** Trusted runtime injection only (tests use an in-memory map). */
export interface ByosKeyStore { read(engine: ByosEngine): Promise<string | null>; write(engine: ByosEngine, key: string): Promise<void>; remove(engine: ByosEngine): Promise<void> }
export class ByosConnectionError extends Error {}

const LABELS: Record<ByosEngine, string> = { grok: 'Grok (xAI)', openrouter: 'OpenRouter', 'claude-api': 'Claude API', groq: 'Groq', huggingface: 'Hugging Face' };
const KEY_PAGES: Partial<Record<ByosEngine, { label: string; url: string }[]>> = {
  grok: [{ label: 'Create an xAI API key', url: 'https://console.x.ai' }],
  openrouter: [{ label: 'Create an OpenRouter key', url: 'https://openrouter.ai/settings/keys' }],
  'claude-api': CLAUDE_API_KEY_SETUP,
  groq: [{ label: 'Create a Groq API key', url: 'https://console.groq.com/keys' }],
  huggingface: [{ label: 'Create a Hugging Face access token', url: 'https://huggingface.co/settings/tokens' }],
};
const MAX_KEY_LENGTH = 1000;
const MAX_MODELS = 400;

export function keychainKeyStore(namespace = 'jev-polls'): ByosKeyStore {
  const entry = (engine: ByosEngine) => {
    if (process.platform !== 'darwin') throw new ByosConnectionError('Saving API keys needs the macOS Keychain. Use ChatGPT, Codex or Claude Code on this computer.');
    return new AsyncEntry(`byos.${namespace}`, engine);
  };
  const guard = async <T>(run: () => Promise<T>) => { try { return await run(); } catch (error) { throw error instanceof ByosConnectionError ? error : new ByosConnectionError('The API key could not be read or saved securely. Check Keychain access.'); } };
  return {
    read: engine => guard(async () => (await entry(engine).getPassword()) ?? null),
    write: (engine, key) => guard(() => entry(engine).setPassword(key)),
    remove: engine => guard(async () => { await entry(engine).deletePassword(); }),
  };
}

/** Environment variables that supply a BYOS key on hosts without a Keychain, such as a hosted workspace. */
export const BYOS_KEY_ENV: Record<ByosEngine, string> = { grok: 'XAI_API_KEY', openrouter: 'OPENROUTER_API_KEY', 'claude-api': 'ANTHROPIC_API_KEY', groq: 'GROQ_API_KEY', huggingface: 'HF_TOKEN' };

/** Keys from the environment take precedence; everything else falls through to the given store. */
export function environmentKeyStore(fallback: ByosKeyStore, env: NodeJS.ProcessEnv = process.env): ByosKeyStore {
  const fromEnv = (engine: ByosEngine) => env[BYOS_KEY_ENV[engine]]?.trim() || null;
  return {
    read: async engine => fromEnv(engine) ?? fallback.read(engine),
    write: async (engine, key) => { if (fromEnv(engine)) throw new ByosConnectionError(`This key is set by ${BYOS_KEY_ENV[engine]} on the server. Change it there.`); await fallback.write(engine, key); },
    remove: async engine => { if (fromEnv(engine)) throw new ByosConnectionError(`This key is set by ${BYOS_KEY_ENV[engine]} on the server. Remove it there.`); await fallback.remove(engine); },
  };
}

function provider(engine: ByosEngine): ByosProvider {
  switch (engine) {
    case 'grok': return grok({ deviceCodeViaSite: false });
    case 'openrouter': return openrouter({ appTitle: 'Jev Polls', referer: 'https://github.com/gm2211/jev-polls' });
    case 'claude-api': return claude();
    case 'groq': return groq();
    case 'huggingface': return huggingface();
  }
}
/** BYOS's own key hint; OpenRouter's BYOS sign-in is browser PKCE only, and its pasted keys work the same way. */
const keyHint = (engine: ByosEngine) => provider(engine).signIn.find((method): method is Extract<SignInMethod, { kind: 'api-key' }> => method.kind === 'api-key')?.hint
  ?? (engine === 'openrouter' ? 'An OpenRouter API key from openrouter.ai/settings/keys' : undefined);

/** Fixed public messages: raw provider errors can echo request data and never reach the UI. */
function providerMessage(engine: ByosEngine, error: unknown, connecting = false): string {
  const label = LABELS[engine];
  const status = error instanceof ProviderRequestError ? error.status : (error as { name?: string })?.name === 'OpenRouterAuthenticationError' ? 401 : 0;
  if (error instanceof ByosConnectionError) return error.message;
  if (status === 401 || status === 403) return `${label} did not accept this key. Check it, or paste a new one.`;
  // BYOS model listing reports a refusal without its status; on connect that almost always means the key.
  if (connecting) return `${label} did not accept this key, or could not be reached. Check the key and your connection, then try again.`;
  if (status === 402 || status === 429) return `${label} refused the request because of credits or rate limits. Check your ${label} account, or choose another drafting provider.`;
  if ((error as { name?: string })?.name === 'AbortError') return `${label} request cancelled. Workspace unchanged.`;
  return `${label} could not complete this request. Try again or choose another drafting provider. Workspace unchanged.`;
}

export interface ByosGenerateRequest { engine: ByosEngine; model: string; instructions: string; input: string; signal?: AbortSignal; onProgress?: (progress: { phase: 'starting' | 'generating' | 'receiving'; outputChars: number; outputTokens?: number }) => void }

export class ByosConnections {
  private readonly cache = new Map<ByosEngine, string | null>();
  constructor(private readonly store: ByosKeyStore = environmentKeyStore(keychainKeyStore())) {}

  private async key(engine: ByosEngine): Promise<string | null> {
    if (!this.cache.has(engine)) this.cache.set(engine, await this.store.read(engine));
    return this.cache.get(engine) ?? null;
  }

  async engines(): Promise<ByosEngineInfo[]> {
    return Promise.all(BYOS_ENGINES.map(async (id): Promise<ByosEngineInfo> => {
      const label = LABELS[id], policy = provider(id).availability();
      const base = { id, label, installed: true, keyHint: keyHint(id), setup: KEY_PAGES[id] };
      if (!policy.available) return { ...base, authenticated: false, available: false, message: policy.reason };
      try {
        const connected = !!await this.key(id);
        return { ...base, authenticated: connected, available: connected, message: connected ? `Ready with your ${label} key. Drafting only; studies use TypeSafe.` : `Paste your ${label} key to draft with it.` };
      } catch (error) { return { id, label, installed: true, authenticated: false, available: false, message: providerMessage(id, error) }; }
    }));
  }

  /** Checks the key by listing models, then saves it. The key is never returned. */
  async connect(engine: ByosEngine, rawKey: string): Promise<CatalogModel[]> {
    const key = rawKey.trim();
    if (!key || key.length > MAX_KEY_LENGTH || /\s/.test(key)) throw new ByosConnectionError(`Paste a single ${LABELS[engine]} key with no spaces.`);
    let models: CatalogModel[];
    try { models = await provider(engine).listModels(key, AbortSignal.timeout(20_000)); }
    catch (error) { throw new ByosConnectionError(providerMessage(engine, error, true)); }
    try { await this.store.write(engine, key); } catch (error) { throw new ByosConnectionError(providerMessage(engine, error)); }
    this.cache.set(engine, key);
    return visible(models);
  }

  async disconnect(engine: ByosEngine): Promise<void> {
    try { await this.store.remove(engine); } catch (error) { throw new ByosConnectionError(providerMessage(engine, error)); }
    this.cache.set(engine, null);
  }

  async models(engine: ByosEngine): Promise<CatalogModel[]> {
    const key = await this.key(engine).catch(error => { throw new ByosConnectionError(providerMessage(engine, error)); });
    if (!key) throw new ByosConnectionError(`Paste a ${LABELS[engine]} key first.`);
    try { return visible(await provider(engine).listModels(key, AbortSignal.timeout(20_000))); }
    catch (error) { throw new ByosConnectionError(providerMessage(engine, error)); }
  }

  /** Streams one completion and returns its text. Only model output leaves this method. */
  async generate(request: ByosGenerateRequest): Promise<string> {
    const key = await this.key(request.engine).catch(error => { throw new ByosConnectionError(providerMessage(request.engine, error)); });
    if (!key) throw new ByosConnectionError(`Paste a ${LABELS[request.engine]} key first.`);
    let text = '', outputTokens: number | undefined;
    request.onProgress?.({ phase: 'starting', outputChars: 0 });
    try {
      for await (const event of provider(request.engine).stream(key, { model: request.model, signal: request.signal, messages: [{ role: 'system', content: request.instructions }, { role: 'user', content: request.input }] })) {
        if (event.type === 'text') { text += event.text; request.onProgress?.({ phase: 'generating', outputChars: text.length, outputTokens }); }
        else if (event.type === 'reasoning') request.onProgress?.({ phase: 'generating', outputChars: text.length, outputTokens });
        else if (event.type === 'usage' && event.outputTokens !== undefined) outputTokens = event.outputTokens;
      }
    } catch (error) { throw new ByosConnectionError(providerMessage(request.engine, error)); }
    request.onProgress?.({ phase: 'receiving', outputChars: text.length, outputTokens });
    return text;
  }
}

function visible(models: CatalogModel[]): CatalogModel[] {
  return models.filter(model => !model.hidden).slice(0, MAX_MODELS).map(({ id, name, recommended }) => ({ id, name, ...(recommended ? { recommended } : {}) }));
}

/** Models sometimes wrap JSON in prose or a fence; take the outermost object. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced) return JSON.parse(fenced[1]!);
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new SyntaxError('No JSON object');
  return JSON.parse(trimmed.slice(start, end + 1));
}
