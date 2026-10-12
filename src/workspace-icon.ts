import { readFileSync } from 'node:fs';

// Poll-results mark: three answer bars with the leading one highlighted. Embedded as data URIs so the
// workspace and saved reports need no extra routes and stay within the `img-src data:` policy.
const iconFile = (name: string) => readFileSync(new URL('../assets/icon/' + name, import.meta.url));

/** The mark as inline SVG for the workspace wordmark. */
export const JEV_MARK_SVG = iconFile('jev.svg').toString('utf8').trim();

const dataUri = (type: string, data: Buffer) => `data:${type};base64,${data.toString('base64')}`;

/** Tab icon (SVG, with a PNG fallback for browsers without SVG favicons) and the home-screen icon. */
export const FAVICON_LINKS = `<link rel="icon" type="image/svg+xml" href="${dataUri('image/svg+xml', iconFile('jev.svg'))}"><link rel="icon" type="image/png" sizes="32x32" href="${dataUri('image/png', iconFile('jev-32.png'))}"><link rel="apple-touch-icon" href="${dataUri('image/png', iconFile('apple-touch-icon.png'))}">`;
