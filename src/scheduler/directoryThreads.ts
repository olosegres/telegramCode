import { resolveBoundWorkDir } from '../validation';
import type { BindingData } from '../state';
import { keyToString, type ThreadKey } from '../types';

/**
 * @description Invert a directory (an OpenCode instance's absolute working
 * folder) to the serialized thread keys bound to it. The scheduler MCP server's
 * `dir:<directory>` scope (S5) needs this to resolve which threads a directory
 * token may touch; `bot.ts` has the forward `binding → workDir` mapping
 * (`resolveBoundWorkDir`) but no inverse, so this is the single place that walks
 * every binding and matches its RESOLVED workDir against `directory`.
 *
 * Why resolved workDir and not the raw `subdir`: the OpenCode injection (S6)
 * scopes the token to the canonical agent workdir. Comparing against the raw
 * relative `subdir`, or an unresolved `WORK_ROOT`, would miss symlinked roots.
 */
export function getThreadKeysForDirectory(
  bindings: Array<{ key: ThreadKey; data: BindingData }>,
  workRoot: string,
  directory: string,
): string[] {
  const matches: string[] = [];
  for (const { key, data } of bindings) {
    const decision = resolveBoundWorkDir(workRoot, data);
    if (decision.kind === 'proceed' && decision.workDir === directory) {
      matches.push(keyToString(key));
    }
  }
  return matches;
}
