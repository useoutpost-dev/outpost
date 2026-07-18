'use strict';

// Parse a text control frame (JSON) into a validated command object.
// Returns { type, ... } on success, or { type: 'error', reason } if the frame
// is malformed or unrecognized. NEVER throws — a bad control frame must not
// crash the daemon.
function parseControlFrame(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return { type: 'error', reason: 'invalid-json' };
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return { type: 'error', reason: 'not-an-object' };
  }
  switch (msg.type) {
    case 'resize': {
      const cols = msg.cols;
      const rows = msg.rows;
      if (
        !Number.isInteger(cols) ||
        !Number.isInteger(rows) ||
        cols <= 0 ||
        rows <= 0 ||
        cols > 10000 ||
        rows > 10000
      ) {
        return { type: 'error', reason: 'invalid-resize' };
      }
      return { type: 'resize', cols, rows };
    }
    case 'ping':
      return { type: 'ping' };
    case 'pong':
      return { type: 'pong' };
    default:
      return { type: 'error', reason: 'unknown-type' };
  }
}

module.exports = { parseControlFrame };
