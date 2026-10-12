import { timingSafeEqual, createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Hosted mode: the workspace runs behind a public HTTPS URL (for example a Render web service)
 * instead of on 127.0.0.1. It binds all interfaces, accepts only the configured public Host and
 * Origin, and puts every page and API call behind one shared password (HTTP Basic auth), because
 * anyone on the internet can reach the URL.
 */
export interface HostedOptions { publicUrl: string; password: string }

export const MIN_HOSTED_PASSWORD_LENGTH = 12;

/** Reads hosted settings from the environment. Render sets RENDER_EXTERNAL_URL on every web service. */
export function hostedFromEnvironment(env: NodeJS.ProcessEnv = process.env): HostedOptions | undefined {
  const publicUrl = (env.JEV_POLLS_PUBLIC_URL ?? env.RENDER_EXTERNAL_URL)?.trim();
  if (!publicUrl) return undefined;
  const password = env.JEV_POLLS_PASSWORD ?? '';
  if (password.length < MIN_HOSTED_PASSWORD_LENGTH) throw new Error(`Hosted workspaces need JEV_POLLS_PASSWORD with at least ${MIN_HOSTED_PASSWORD_LENGTH} characters.`);
  return { publicUrl, password };
}

/** The public origin, e.g. https://jev-polls.onrender.com, with no path. */
export function hostedOrigin(hosted: HostedOptions): URL {
  const url = new URL(hosted.publicUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('JEV_POLLS_PUBLIC_URL must be an http(s) URL.');
  return new URL(url.origin);
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** True when the request carries the shared password; any user name is accepted. */
export function hostedPasswordMatches(request: IncomingMessage, password: string): boolean {
  const header = request.headers.authorization ?? '';
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header);
  if (!match) return false;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  return timingSafeEqual(digest(decoded.slice(colon + 1)), digest(password));
}
