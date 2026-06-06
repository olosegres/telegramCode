import { getBindGateDecision } from '../utils/bindGateDecision';
import type { BindingData } from '../state';
import { keyToString, type ThreadKey } from '../types';

/**
 * @description Invert a directory (an OpenCode instance's absolute working
 * folder) to the serialized thread keys bound to it. The scheduler MCP server's
 * `dir:<directory>` scope (S5) needs this to resolve which threads a directory
 * token may touch; `bot.ts` has the forward `binding → workDir` mapping
 * ({@link getBindGateDecision}) but no inverse, so this is the single pure place
 * that walks every binding and matches its RESOLVED workDir against `directory`.
 *
 * Why resolved workDir and not the raw `subdir`: the OpenCode injection (S6)
 * scopes the token to `stream.directory`, which is `path.join(workRoot, subdir)`
 * — the same value `getBindGateDecision` computes. Comparing against the raw
 * relative `subdir` would miss every match. Pure (no I/O): the caller passes the
 * binding list and `workRoot`, so it is unit-testable without booting the bot.
 */
export function getThreadKeysForDirectory(
  bindings: Array<{ key: ThreadKey; data: BindingData }>,
  workRoot: string,
  directory: string,
): string[] {
  const matches: string[] = [];
  for (const { key, data } of bindings) {
    const decision = getBindGateDecision(data, workRoot);
    if (decision.kind === 'proceed' && decision.workDir === directory) {
      matches.push(keyToString(key));
    }
  }
  return matches;
}
