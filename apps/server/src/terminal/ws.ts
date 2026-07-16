import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { OutpostError } from '@outpost/shared-api';
import type { SessionManager } from './session-manager.js';

/**
 * Registers the terminal WebSocket route.
 *
 * GET /api/sandboxes/:id/terminal
 *
 * The global `onRequest` auth gate (registerAuthGate) runs BEFORE this handler
 * on the upgrade request — an unauthenticated upgrade is rejected with 401 and
 * no WebSocket is ever established. We add no PUBLIC_PATHS entry; the route is
 * gated by the same rule as every other /api route.
 *
 * By the time the handler runs the socket is already upgraded, so sandbox-state
 * failures (404 unknown, 409 not running / no token) are reported to the client
 * as a JSON control frame plus a clean close rather than an HTTP status.
 */
export interface TerminalRouteDeps {
  sessionManager: SessionManager;
  /** Resolve the sandbox's current status + terminal token from the DB. */
  lookupSandbox(id: string): { status: string; terminalToken: string | null } | undefined;
}

/** Application close codes (4000-4999 are reserved for app use per RFC 6455). */
const CLOSE_NOT_FOUND = 4404;
const CLOSE_CONFLICT = 4409;
const CLOSE_INTERNAL = 4500;

export function registerTerminalRoute(app: FastifyInstance, deps: TerminalRouteDeps): void {
  const { sessionManager, lookupSandbox } = deps;

  app.get('/api/sandboxes/:id/terminal', { websocket: true }, async (socket: WebSocket, req) => {
    const { id } = req.params as { id: string };

    try {
      const sandbox = lookupSandbox(id);
      if (!sandbox) {
        closeWith(socket, CLOSE_NOT_FOUND, 'NOT_FOUND', 'sandbox not found');
        return;
      }
      if (sandbox.status !== 'running') {
        closeWith(socket, CLOSE_CONFLICT, 'CONFLICT', 'sandbox is not running');
        return;
      }
      if (!sandbox.terminalToken) {
        closeWith(socket, CLOSE_CONFLICT, 'CONFLICT', 'terminal unavailable');
        return;
      }

      await sessionManager.attach(id, socket);
    } catch (err) {
      // attach() can throw OutpostError (e.g. token became null) or a dial error.
      if (OutpostError.is(err)) {
        closeWith(socket, CLOSE_CONFLICT, err.code, err.safeMessage);
      } else {
        req.log.error(`terminal: attach failed for sandbox ${id}`);
        closeWith(socket, CLOSE_INTERNAL, 'INTERNAL', 'terminal error');
      }
    }
  });
}

/** Send a machine-readable error control frame, then close cleanly. Never logs
 *  terminal data or tokens. */
function closeWith(socket: WebSocket, code: number, errorCode: string, message: string): void {
  try {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: 'error', code: errorCode, message }));
    }
  } catch {
    /* ignore: we're closing anyway */
  }
  try {
    socket.close(code, message);
  } catch {
    /* ignore */
  }
}
