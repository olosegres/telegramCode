import type { ThreadKey } from './types';
import { keyToString } from './types';
import { createSerialQueue, type SerialQueue } from './utils/serialQueue';

/**
 * @description Per-thread FIFO queues for voice transcription jobs. Telegraf's
 * polling loop awaits `Promise.all(updates.map(handleUpdate))` before issuing
 * the next `getUpdates`, so a slow Groq transcription awaited inside the voice
 * handler stalls intake of EVERY update (the whole bot freezes). The handler
 * therefore does only cheap gating, then ENQUEUES the download+transcribe+
 * forward job here and returns — the job runs off the update loop.
 *
 * One queue per thread key preserves per-topic ORDER (two voices in one topic
 * transcribe+forward in arrival order) while letting different topics run in
 * parallel; a stuck job blocks only its own thread's queue, never the bot.
 *
 * The map is bounded by the number of topics, so entries are never evicted.
 */
const voiceTranscriptionQueues = new Map<string, SerialQueue>();

/**
 * @description Get (create-on-miss) the voice transcription queue for a thread.
 */
export function getVoiceTranscriptionQueue(key: ThreadKey): SerialQueue {
  const kStr = keyToString(key);
  let queue = voiceTranscriptionQueues.get(kStr);
  if (!queue) {
    queue = createSerialQueue();
    voiceTranscriptionQueues.set(kStr, queue);
  }
  return queue;
}
