import type { ChatMode } from '../threadRouting';
import type { OutputTransport, ThreadKey } from '../types';
import { createDmOutputTransport, type DmOutputTransportDeps } from './dmOutputTransport';
import { getGroupDeltaContinuation } from '../utils/outputFlushPlan';

/**
 * @description Bot primitives the output transport routes through. The group
 * branch needs only `queueOutput` (the unchanged edit-in-place persist path);
 * the DM branch needs the full draft-manager surface ({@link DmOutputTransportDeps}).
 * `checkIsDmKey` is the per-chat discriminator the `both` dispatcher uses to pick
 * the impl for each key. All are injected as closures so the transport never
 * reaches into the bot's module state directly.
 */
export type OutputTransportDeps = DmOutputTransportDeps & {
  /** True iff the key belongs to the DM surface (its chat is the owner's). */
  checkIsDmKey(key: ThreadKey): boolean;
  /**
   * Group-path finalize: drain the thread's coalesced-but-unsent output buffer
   * to a permanent message so the agent's final answer is never discarded on
   * teardown (S2). Owned by `bot.ts` (it touches the output-queue state +
   * `sendOutputImmediate`); the group transport just delegates `finalizeInFlight`
   * to it. Idempotent — a fully-delivered turn is a no-op.
   */
  finalizeGroupOutput(key: ThreadKey): Promise<void>;
};

/**
 * @description The thin group output transport — `queueOutput` edit-in-place +
 * `finalizeGroupOutput` reconcile (S2) + noop dispose, never the draft path.
 * Shared by `group` mode and the group leg of the `both` dispatcher.
 */
function createGroupOutputTransport(deps: OutputTransportDeps): OutputTransport {
  return {
    deliverOutput(key, output, meta) {
      const startsNewParagraph = meta?.startsNewParagraph === true;
      // S3 (edit-in-place): the Claude scrape adapter marks no continuations, so a
      // growing block used to send one NEW message per poll flush (the table
      // flood). Synthesise the flag so a poll delta EDITS the growing message in
      // place, breaking to a new message only at a paragraph/block boundary
      // (`startsNewParagraph`) or a fresh turn (`needsNewMessage`, honoured by
      // `getOutputFlushPlan`). OpenCode (outputsDeltas false) passes through.
      const isContinuation = getGroupDeltaContinuation(
        meta?.isContinuation === true,
        deps.checkOutputsDeltas(key),
        startsNewParagraph,
      );
      deps.queueOutput(
        key,
        output,
        isContinuation,
        meta?.isFinal === true,
        meta?.isComplete === true,
        startsNewParagraph,
      );
    },
    // S2: drain the coalesced-but-unsent output to a permanent message so the
    // final answer is never discarded on teardown. `bot.ts` owns the drain (it
    // touches the output-queue state); idempotent — a fully-delivered turn is a
    // no-op, so the status-ordering finalize and a fully-delivered teardown
    // never double-post.
    finalizeInFlight: (key) => deps.finalizeGroupOutput(key),
    disposeThread: () => {},
    checkIsStreaming: () => false,
  };
}

/**
 * @description Select the output transport from {@link ChatMode} — the SINGLE
 * mode decision (mirrors the AgentAdapter factory). `group` is the thin
 * edit-in-place impl; `dm` owns the draft-cursor manager
 * (`createDmOutputTransport`). `both` builds BOTH and returns a DISPATCHER whose
 * every method routes by `checkIsDmKey(key)` to the right impl — so one process
 * streams the owner DM via the cursor AND the group edit-in-place at once.
 */
export function createOutputTransport(
  chatMode: ChatMode,
  deps: OutputTransportDeps,
): OutputTransport {
  if (chatMode === 'group') return createGroupOutputTransport(deps);
  if (chatMode === 'dm') return createDmOutputTransport(deps);

  // `both` — route each per-thread call to the impl owning that key's surface.
  const dmTransport = createDmOutputTransport(deps);
  const groupTransport = createGroupOutputTransport(deps);
  const pickTransport = (key: ThreadKey): OutputTransport =>
    deps.checkIsDmKey(key) ? dmTransport : groupTransport;
  return {
    deliverOutput(key, output, meta) {
      pickTransport(key).deliverOutput(key, output, meta);
    },
    finalizeInFlight(key) {
      return pickTransport(key).finalizeInFlight(key);
    },
    disposeThread(key) {
      pickTransport(key).disposeThread(key);
    },
    checkIsStreaming(key) {
      return pickTransport(key).checkIsStreaming(key);
    },
  };
}
