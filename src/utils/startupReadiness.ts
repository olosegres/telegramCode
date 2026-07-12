/**
 * @description Pure decision layer for the boot-time readiness status message
 * (plan 2026-07-12-startup-readiness-status). On startup the bot tells the owner
 * whether it can process messages in the topics / group, or — if not — a numbered
 * list of only the setup steps that are still unmet. This module holds the pure,
 * unit-testable core: which items are unmet, whether the bot is ready, the
 * cadence gate, and the full message composition (via an injected translate so
 * the numbering / header logic is testable without the i18n runtime). `bot.ts`
 * gathers the live facts and does the actual Telegram send.
 */

/** One of the three Telegram admin rights the bot needs in the paired group. */
export type BotRightKey = 'manageTopics' | 'pin' | 'delete';

/** The three admin rights, resolved from the bot's `getChatMember` in the group. */
export interface BotAdminRights {
  manageTopics: boolean;
  pin: boolean;
  delete: boolean;
}

/**
 * @description The checklist items, in the fixed order they render. The first
 * four are REQUIRED (their unmet state makes the bot not-ready); the two
 * `optional_*` items are informational only and never affect {@link
 * ReadinessReport.isReady}.
 */
export type ReadinessItemKey =
  | 'create_group'
  | 'grant_admin'
  | 'bind_topic'
  | 'install_agent'
  | 'optional_groq'
  | 'optional_owner';

/** The live facts `bot.ts` gathers at boot and feeds to {@link buildReadinessReport}. */
export interface ReadinessFacts {
  /** A forum supergroup is paired (`getAllowedGroupId() != null`). */
  groupPaired: boolean;
  /**
   * The bot's admin rights in the paired group, or `null` when unpaired / the
   * bot is not an administrator / the rights could not be read.
   */
  botRights: BotAdminRights | null;
  /** At least one topic in the paired group is bound to a folder. */
  hasBinding: boolean;
  /** Installed agent CLIs among `claude` / `opencode` (empty ⇒ none installed). */
  availableAgents: string[];
  /** `GROQ_API_KEY` is present (optional — enables voice input). */
  hasGroq: boolean;
  /** `OWNER_USER_ID` is set. */
  ownerSet: boolean;
  /**
   * Delivery fell back to the group's General topic because the owner DM was
   * unreachable / unset. Only ever surfaces the `optional_owner` hint (and only
   * when `ownerSet` is false — a set-but-unopened DM is not the same problem).
   */
  usedGeneralFallback: boolean;
}

/** The pure verdict {@link buildReadinessReport} produces. */
export interface ReadinessReport {
  /** True iff every REQUIRED item is met (optional items never block this). */
  isReady: boolean;
  /** The unmet items, in render order — drives the numbered checklist. */
  unmetKeys: ReadinessItemKey[];
  /** Which specific admin rights are missing (for the `grant_admin` item copy). */
  missingRights: BotRightKey[];
}

/** The order every checklist item renders in — matches the IDEAL list. */
const readinessItemOrder: ReadinessItemKey[] = [
  'create_group',
  'grant_admin',
  'bind_topic',
  'install_agent',
  'optional_groq',
  'optional_owner',
];

/** The REQUIRED items — an unmet one makes the bot not-ready. */
const requiredItemKeys: ReadinessItemKey[] = [
  'create_group',
  'grant_admin',
  'bind_topic',
  'install_agent',
];

/**
 * @description Telegram's canonical permission names for the three rights the
 * bot needs — proper nouns shown verbatim in the `grant_admin` item so the
 * operator can find the exact toggles in Telegram's admin UI. Kept here (not in
 * i18n) because they are feature identifiers, not translated prose.
 */
export const botRightLabels: Record<BotRightKey, string> = {
  manageTopics: 'Manage Topics',
  pin: 'Pin Messages',
  delete: 'Delete Messages',
};

/**
 * @description The admin rights the bot is missing. A `null` rights object (not
 * an admin / unreadable) counts as ALL three missing.
 */
export function getMissingBotRights(rights: BotAdminRights | null): BotRightKey[] {
  if (!rights) return ['manageTopics', 'pin', 'delete'];
  const missing: BotRightKey[] = [];
  if (!rights.manageTopics) missing.push('manageTopics');
  if (!rights.pin) missing.push('pin');
  if (!rights.delete) missing.push('delete');
  return missing;
}

/** Join the missing rights into the human list for the `grant_admin` item copy. */
export function formatMissingRights(keys: BotRightKey[]): string {
  return keys.map((key) => botRightLabels[key]).join(', ');
}

/**
 * @description Turn the live facts into the readiness verdict.
 *
 * `isReady` is true iff NONE of the required items are unmet:
 *   groupPaired  &&  all admin rights held  &&  a binding exists  &&  an agent CLI installed.
 * The optional groq / owner items are informational — they populate `unmetKeys`
 * (so they render inside a not-ready checklist) but never flip `isReady`.
 *
 * `grant_admin` is only unmet while a group IS paired (you cannot grant admin
 * before the group exists — an unpaired bot shows `create_group` instead).
 */
export function buildReadinessReport(facts: ReadinessFacts): ReadinessReport {
  const missingRights = facts.groupPaired ? getMissingBotRights(facts.botRights) : [];

  const unmet = new Set<ReadinessItemKey>();
  if (!facts.groupPaired) unmet.add('create_group');
  if (facts.groupPaired && missingRights.length > 0) unmet.add('grant_admin');
  if (!facts.hasBinding) unmet.add('bind_topic');
  if (facts.availableAgents.length === 0) unmet.add('install_agent');
  if (!facts.hasGroq) unmet.add('optional_groq');
  if (!facts.ownerSet && facts.usedGeneralFallback) unmet.add('optional_owner');

  const isReady = requiredItemKeys.every((key) => !unmet.has(key));
  const unmetKeys = readinessItemOrder.filter((key) => unmet.has(key));

  return { isReady, unmetKeys, missingRights };
}

/**
 * @description Cadence gate. A COLD start always sends (ready or not). A HOT
 * reload stays silent when fully ready (no spam on frequent rebuilds) and sends
 * only when something is missing.
 */
export function checkShouldSendStartupStatus(input: {
  isHotReload: boolean;
  isReady: boolean;
}): boolean {
  return !(input.isHotReload && input.isReady);
}

/** A resolved delivery surface for the boot-time status: the owner DM or the group's General topic. */
export type StartupTarget = 'owner' | 'general';

/**
 * @description Resolve the ordered delivery targets for the boot-time status.
 *
 * The READY status is only meaningful in the owner's private DM, so it is
 * DM-ONLY and NEVER falls back to the group's General topic (a "✅ Ready" in the
 * shared group is pure noise). If there is no owner DM, a ready status resolves
 * to an empty list — nothing is delivered (the caller logs it).
 *
 * The NOT-READY checklist is actionable, so it uses the owner DM when available
 * and falls back to General otherwise (owner first):
 *
 *   ready      → hasOwnerTarget ? ['owner'] : []            (private-only, never 'general')
 *   not-ready  → ['owner', 'general'] filtered to the available surfaces (owner first)
 */
export function resolveStartupTargets(
  isReady: boolean,
  hasOwnerTarget: boolean,
  hasGeneralTarget: boolean,
): StartupTarget[] {
  if (isReady) {
    return hasOwnerTarget ? ['owner'] : [];
  }
  const targets: StartupTarget[] = [];
  if (hasOwnerTarget) targets.push('owner');
  if (hasGeneralTarget) targets.push('general');
  return targets;
}

/** Injected translate — `(code, opts) => string`, so composition is testable without the i18n runtime. */
export type StartupStatusTranslate = (code: string, opts?: Record<string, string>) => string;

/**
 * @description Compose the full status message. Ready ⇒ the short ready line.
 * Not ready ⇒ a header followed by the unmet items renumbered 1..N (the
 * `grant_admin` line interpolates the missing-rights list).
 */
export function buildStartupStatusText(
  report: ReadinessReport,
  translate: StartupStatusTranslate,
): string {
  if (report.isReady) {
    return translate('startup.ready');
  }
  const header = translate('startup.header_not_ready');
  const lines = report.unmetKeys.map((key, index) => {
    const itemText =
      key === 'grant_admin'
        ? translate('startup.item.grant_admin', { missing: formatMissingRights(report.missingRights) })
        : translate(`startup.item.${key}`);
    return `${index + 1}. ${itemText}`;
  });
  return `${header}\n\n${lines.join('\n')}`;
}
