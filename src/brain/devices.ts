// Device previews: the page being built, shown as a phone, a tablet or a desktop would show it, for
// testing during development. The window code is in main.ts; this part has no Electron in it, and
// lives with the brain because the MCP server, which runs as plain Node outside the app's archive, uses it too.

export interface Device {
  id: string;
  name: string;
  /** Screen size in CSS pixels, held upright. */
  width: number;
  height: number;
  /** Device pixels per CSS pixel. */
  scale: number;
  /** A phone or tablet: touch, a mobile viewport and a mobile browser's user agent. */
  mobile: boolean;
  /** The browser this device would send; none keeps the app's own (a desktop Chrome). */
  userAgent?: string;
}

const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPADOS = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const android = (model: string) => `Mozilla/5.0 (Linux; Android 14; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36`;

export const DEVICES: Device[] = [
  { id: "iphone-se", name: "iPhone SE", width: 375, height: 667, scale: 2, mobile: true, userAgent: IOS },
  { id: "iphone-15", name: "iPhone 15 Pro", width: 393, height: 852, scale: 3, mobile: true, userAgent: IOS },
  { id: "iphone-15-max", name: "iPhone 15 Pro Max", width: 430, height: 932, scale: 3, mobile: true, userAgent: IOS },
  { id: "pixel-8", name: "Pixel 8", width: 412, height: 915, scale: 2.625, mobile: true, userAgent: android("Pixel 8") },
  { id: "galaxy-s24", name: "Galaxy S24", width: 360, height: 780, scale: 3, mobile: true, userAgent: android("SM-S921B") },
  { id: "ipad-mini", name: "iPad mini", width: 768, height: 1024, scale: 2, mobile: true, userAgent: IPADOS },
  { id: "ipad-pro", name: "iPad Pro 12.9\"", width: 1024, height: 1366, scale: 2, mobile: true, userAgent: IPADOS },
  { id: "laptop", name: "Laptop", width: 1366, height: 768, scale: 1, mobile: false },
  { id: "desktop", name: "Desktop 1080p", width: 1920, height: 1080, scale: 1, mobile: false },
];

export const deviceById = (id: unknown): Device | undefined => DEVICES.find((d) => d.id === id);

/**
 * The address to preview, or null when it is not one: only http and https, so a preview can never open
 * a file on this computer or a custom protocol. "localhost:3000" alone gets http:// in front.
 */
export function previewAddress(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let text = input.trim();
  if (!text || text.length > 2048) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Whether an address is on this computer or the local network: what a dev server answers on. Claude
 * Code may only preview these. The preview windows keep sign-ins, so a session must not be able to
 * walk them through the user's accounts on the internet.
 */
export function isLocalAddress(address: string): boolean {
  let host: string;
  try {
    host = new URL(address).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0") return true;
  // IPv6 link-local and unique-local addresses.
  if (/^fe[89ab][0-9a-f]:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host)) return true;
  const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  // A name ending in .local is a computer on the local network (mDNS).
  if (!ip) return host.endsWith(".local");
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/** The screen size turned sideways or not. */
export function oriented(device: Device, landscape: boolean): { width: number; height: number } {
  return landscape ? { width: device.height, height: device.width } : { width: device.width, height: device.height };
}

/** How far to shrink a screen of `width` by `height` to fit in 90% of the room there is; never enlarged. */
export function fitScale(width: number, height: number, room: { width: number; height: number }): number {
  return Math.min(1, (room.width * 0.9) / width, (room.height * 0.9) / height);
}
