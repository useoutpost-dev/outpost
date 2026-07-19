// Pure preview-host parsing. NO imports of db, fastify, or any I/O module.
// The output of this function is the ONLY thing that decides which sandbox a
// preview request maps to; the target address itself is resolved from the DB,
// never from anything parsed here (SSRF invariant 1).

export interface PreviewHostMatch {
  /** Sandbox name (everything before the final `-<port>` segment of the label). */
  name: string;
  /** Forwarded port, guaranteed in the range 1–65535. */
  port: number;
}

// label = <name>-<port>: name starts with a letter (a leading digit is rejected
// so the whole label can't be read as a bare port), may contain [a-z0-9-]; the
// final hyphen-delimited numeric run (2–5 digits) is the port.
const LABEL_RE = /^([a-z][a-z0-9-]*)-(\d{2,5})$/;

/**
 * Parse a Host header into `{ name, port }` when it exactly matches
 * `<name>-<port>.<previewDomain>` (case-insensitive), else null.
 *
 * - An optional `:port` suffix on the Host header is stripped first.
 * - The domain suffix must match `previewDomain` EXACTLY — a spoofed suffix such
 *   as `x.previewDomain.attacker.com` returns null (no substring/`endsWith` match).
 * - `port` must be in 1–65535.
 */
export function parsePreviewHost(host: string, previewDomain: string): PreviewHostMatch | null {
  if (!host || !previewDomain) return null;

  // Preview hosts are DNS names, never IPv6 literals. Accept either a bare
  // hostname or one numeric authority port, and reject malformed suffixes.
  const authority = /^([^:]+)(?::(\d{1,5}))?$/.exec(host);
  if (!authority) return null;
  const authorityPort = authority[2] === undefined ? undefined : Number(authority[2]);
  if (authorityPort !== undefined && (authorityPort < 1 || authorityPort > 65535)) return null;
  const hostname = authority[1]?.toLowerCase();
  if (!hostname) return null;

  const domain = previewDomain.toLowerCase();
  const suffix = `.${domain}`;
  if (!hostname.endsWith(suffix)) return null;

  const label = hostname.slice(0, hostname.length - suffix.length);
  // A wildcard/bare/empty label, or one that still contains a dot (i.e. a
  // deeper subdomain than a single label), is not a valid preview host.
  if (label.length === 0 || label.includes('.')) return null;

  const m = LABEL_RE.exec(label);
  if (!m) return null;

  const name = m[1] ?? '';
  const port = Number(m[2]);
  if (!name || !Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { name, port };
}
