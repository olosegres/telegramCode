import type { ChatMode } from '../threadRouting';
import type { OutputTransport } from '../types';
import { createDmOutputTransport, type DmOutputTransportDeps } from './dmOutputTransport';

/**
 * @description Bot primitives the output transport routes through. The group
 * branch needs only `queueOutput` (the unchanged edit-in-place persist path);
 * the DM branch needs the full draft-manager surface ({@link DmOutputTransportDeps}).
 * All are injected as closures so the transport never reaches into the bot's
 * module state directly.
 */
export type OutputTransportDeps = DmOutputTransportDeps;

/**
 * @description Select the per-surface output transport from {@link ChatMode} —
 * the SINGLE mode decision (mirrors the AgentAdapter factory). Group is thin
 * (`queueOutput` + a noop finalize); DM owns the draft-cursor manager
 * (`createDmOutputTransport`). Inside the DM impl `checkIsDmMode()` is implicitly
 * true and never appears.
 */
export function createOutputTransport(
  chatMode: ChatMode,
  deps: OutputTransportDeps,
): OutputTransport {
  if (chatMode === 'group') {
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
  return createDmOutputTransport(deps);
}
