/** Same-origin pages and local development servers may use the relay. */
export function originAllowed(origin: string | null, host: string): boolean {
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return o.host === host || o.hostname === 'localhost' || o.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}
