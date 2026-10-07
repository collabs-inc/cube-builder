/** Privileged requests are POSTs or WebSocket upgrades, which browsers send
 * with Origin. An HTTPS reverse proxy needs no vendor-specific integration.
 * An HTTP rebinding page cannot manufacture an HTTPS Origin header. */
export function validateControlRequest(headers: Record<string, string | string[] | undefined>): boolean {
  const { host, origin } = headers;
  if (typeof host !== 'string' || typeof origin !== 'string' || !host || origin === 'null') return false;
  try {
    const scheme = headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    const target = new URL(`${scheme}//${host}`);
    if (target.username || target.password || target.pathname !== '/' || target.search || target.hash) return false;
    if (/[\s,/@#?\\]/.test(host)) return false;
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
    if (!loopback && scheme !== 'https:') return false;
    const source = new URL(origin);
    return source.origin === origin && source.origin === target.origin;
  } catch { return false; }
}
