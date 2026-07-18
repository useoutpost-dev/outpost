// Adapter — SOLE owner of Claude Code credential file path/format knowledge.
// This is an undocumented Claude Code surface (verified against Claude Code ~2025).
// Nothing outside this module should hardcode the credential path or file shape.

/**
 * In-sandbox path to the Claude Code OAuth credential file.
 *
 * Sandboxes run Claude Code as the non-root `outpost` user with
 * HOME=/home/outpost, so this Linux path is authoritative.
 *
 * NOTE: on macOS *hosts*, Claude Code stores credentials in the login Keychain
 * rather than in this file. Outpost sandboxes are always Linux, so the file
 * path below is the one that matters for seeding — the Keychain case never
 * applies inside a sandbox.
 */
export const CLAUDE_CREDENTIALS_PATH = '/home/outpost/.claude/.credentials.json';

/**
 * Env var that carries the base64-encoded credential file content into a
 * sandbox at boot. The entrypoint decodes it into CLAUDE_CREDENTIALS_PATH.
 */
export const CLAUDE_CREDENTIALS_ENV = 'OUTPOST_CLAUDE_CREDENTIALS_B64';

/**
 * Base64-encode raw credential file content for transport via env var.
 * UTF-8 is used so unicode survives the roundtrip.
 */
export function encodeCredentialsForEnv(fileContent: string): string {
  return Buffer.from(fileContent, 'utf8').toString('base64');
}

/**
 * Inverse of {@link encodeCredentialsForEnv}. Throws a plain Error on invalid
 * base64. The error NEVER contains decoded credential contents.
 */
export function decodeCredentialsFromEnv(value: string): string {
  // Node's base64 decoder is lenient (ignores stray chars), so validate the
  // shape first and confirm a clean roundtrip — otherwise silent corruption
  // would produce a garbage credential file.
  const normalized = value.trim();
  if (normalized.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error('invalid base64 in Claude credentials env value');
  }
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) {
    throw new Error('invalid base64 in Claude credentials env value');
  }
  return decoded.toString('utf8');
}

/**
 * True iff `content` parses as a JSON object shaped like a Claude Code
 * credential file: a top-level `claudeAiOauth` object with non-empty string
 * `accessToken` and `refreshToken`. Lenient about extra fields
 * (expiresAt, scopes, subscriptionType, ...). Never logs contents.
 */
export function validateCredentialsBlob(content: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (typeof oauth !== 'object' || oauth === null || Array.isArray(oauth)) {
    return false;
  }
  const { accessToken, refreshToken } = oauth as Record<string, unknown>;
  return (
    typeof accessToken === 'string' &&
    accessToken.length > 0 &&
    typeof refreshToken === 'string' &&
    refreshToken.length > 0
  );
}
