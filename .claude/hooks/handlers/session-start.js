/**
 * SessionStart hook handler.
 *
 * Fires on: new session, resume, /clear, /compact.
 *
 * Payload (per https://code.claude.com/docs/en/hooks):
 *   {
 *     session_id: string,
 *     transcript_path: string,
 *     cwd: string,
 *     hook_event_name: "SessionStart",
 *     source: "startup" | "resume" | "clear" | "compact"
 *   }
 *
 * Common uses:
 *   - Inject git/branch/TODO context (write to stdout — becomes model context)
 *   - Pre-warm caches, fetch tickets
 *
 * Currently a no-op. The router still writes the invocation log.
 */

'use strict';

/**
 * @param {object} payload
 * @param {{ eventName: string, rawStdin: string, argv: string[], env: NodeJS.ProcessEnv,
 *           projectDir: string, hooksDir: string, logsDir: string,
 *           log: (msg: string) => void }} ctx
 */
module.exports = function sessionStart(payload, ctx) {
  // no-op
};
