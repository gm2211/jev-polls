import { AsyncEntry } from '@napi-rs/keyring';

const SERVICE = 'jev-polls';
const ACCOUNT = 'typesafe-api-key';

export type ApiKeySource = 'environment' | 'keychain' | 'none';
export interface AuthStatus {
  configured: boolean;
  source: ApiKeySource;
}

function environmentKey(): string | undefined {
  const value = process.env.TYPESAFE_API_KEY?.trim();
  return value || undefined;
}

function keychainEntry(): AsyncEntry {
  return new AsyncEntry(SERVICE, ACCOUNT);
}

/** Read the environment override or the saved macOS Keychain credential. */
export async function readApiKey(): Promise<string | undefined> {
  const fromEnvironment = environmentKey();
  if (fromEnvironment) return fromEnvironment;
  if (process.platform !== 'darwin') return undefined;

  try {
    const stored = await keychainEntry().getPassword();
    return stored?.trim() || undefined;
  } catch {
    throw new Error('Could not read the TypeSafe API key from Keychain.');
  }
}

/** Report whether credentials are available without returning their contents. */
export async function authStatus(): Promise<AuthStatus> {
  if (environmentKey()) return { configured: true, source: 'environment' };
  if (process.platform !== 'darwin') return { configured: false, source: 'none' };

  try {
    const stored = await keychainEntry().getPassword();
    return stored?.trim()
      ? { configured: true, source: 'keychain' }
      : { configured: false, source: 'none' };
  } catch {
    throw new Error('Could not check TypeSafe Keychain credentials.');
  }
}

/** Save a credential in macOS Keychain; secret values are never written to files. */
export async function setApiKey(secret: string): Promise<void> {
  const value = secret.trim();
  if (!value) throw new Error('The TypeSafe API key cannot be empty.');
  if (process.platform !== 'darwin') {
    throw new Error('Saving API keys requires macOS Keychain; set TYPESAFE_API_KEY in the environment on this platform.');
  }
  try {
    await keychainEntry().setPassword(value);
  } catch {
    throw new Error('Could not save the TypeSafe API key in Keychain.');
  }
}
