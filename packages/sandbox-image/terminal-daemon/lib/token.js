'use strict';

const crypto = require('crypto');

// Extract the bearer token from an Authorization header value.
// Returns the token string, or null if absent/malformed.
function extractBearer(authHeader) {
  if (typeof authHeader !== 'string') return null;
  const m = /^Bearer[ ]+(.+)$/.exec(authHeader.trim());
  if (!m) return null;
  const token = m[1].trim();
  return token.length > 0 ? token : null;
}

// Constant-time comparison of a presented token against the expected token.
// Hashes both sides to fixed-length digests so timingSafeEqual never sees
// unequal-length inputs (which would itself throw / leak length). Returns
// false for any falsy/empty input.
function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (presented.length === 0 || expected.length === 0) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = { extractBearer, tokenMatches };
