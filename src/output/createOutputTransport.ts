import type { ChatMode } from '../threadRouting';
import type { OutputTransport, ThreadKey } from '../types';
import { createDmOutputTransport, type DmOutputTransportDeps } from './dmOutputTransport';

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
};

/**
 * @description The thin group output transport — `queueOutput` edit-in-place +
 * noop finalize/dispose, never the draft path. Shared by `group` mode and the
 * group leg of the `both` dispatcher.
 */
function createGroupOutputTransport(deps: OutputTransportDeps): OutputTransport {
  return {
    deliverOutput(key, output, meta) {
      deps.queueOutput(
        key,
        output,
        meta?.isContinuation === true,
        meta?.isFinal === true,
        meta?.isComplete === true,
        meta?.startsNewParagraph === true,
      );
    },
    finalizeInFlight: async () => {},
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
