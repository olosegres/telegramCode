/**
 * @description Natural-language agent trigger parser. Extracted from
 * `bot.ts` (audit S19 / #25) so the regex / synonym list — which rots
 * silently when new spellings are added — can be unit-tested in
 * isolation without booting Telegraf.
 *
 * Patterns intentionally cover ru + en folklore spellings:
 *
 *   - "клод" / "клауд" / "клоуд" / "claude" / "cloud"
 *   - "опенкод" / "опен код" / "opencode" / "open code"
 *
 * Words can be preceded by "запусти(те)" (a colloquial "start <agent>"
 * trigger commonly used in Russian-language chats). Anything after a
 * trigger word that includes the agent name plus a space is treated as
 * the prompt argument.
 *
 * The function is pure: same input → same output, no I/O, no side
 * effects. Punctuation at the end of a bare trigger (`клод!`, `claude.`)
 * is tolerated so users don't get surprising "didn't recognise that"
 * responses.
 */

const startClaudePhrases = new Set([
  'клод', 'клауд', 'клоуд', 'claude', 'cloud',
  'запусти клод', 'запусти клода',
  'запусти клауд', 'запусти клауда',
  'запусти клоуд', 'запусти клоуда',
  'запусти claude', 'запусти cloud',
]);

const startOpencodePhrases = new Set([
  'opencode', 'опенкод', 'open code', 'опен код',
  'запусти opencode', 'запусти опенкод',
  'запусти open code', 'запусти опен код',
]);

const CLAUDE_ARGS_REGEX = /^(claude|клод|клауд|клоуд)\s+(.+)$/;
const OPENCODE_ARGS_REGEX = /^(opencode|опенкод|open code|опен код)\s+(.+)$/;

export interface AgentTriggerMatch {
  isMatch: boolean;
  adapterName?: 'claude' | 'opencode';
  args?: string;
}

export function parseAgentTrigger(text: string): AgentTriggerMatch {
  const normalized = text.toLowerCase().trim().replace(/[.,!?;:]+$/, '');
  if (startClaudePhrases.has(normalized)) return { isMatch: true, adapterName: 'claude' };
  const claudeArgs = normalized.match(CLAUDE_ARGS_REGEX);
  if (claudeArgs) return { isMatch: true, adapterName: 'claude', args: claudeArgs[2] };
  if (startOpencodePhrases.has(normalized)) return { isMatch: true, adapterName: 'opencode' };
  const ocArgs = normalized.match(OPENCODE_ARGS_REGEX);
  if (ocArgs) return { isMatch: true, adapterName: 'opencode', args: ocArgs[2] };
  return { isMatch: false };
}
