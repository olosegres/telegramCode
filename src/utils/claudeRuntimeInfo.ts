import * as fs from 'fs';
import type { AgentRuntimeInfo } from '../types';

const claude45ContextWindowTokens = 200_000;
const claude46AndLaterContextWindowTokens = 1_000_000;
export const claudeRuntimeInfoTailBytes = 128 * 1024;

function checkIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkIsTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function getClaudeContextUsedTokens(usage: unknown): number | null {
  if (!checkIsRecord(usage) || !checkIsTokenCount(usage.input_tokens)) return null;
  const outputTokens = usage.output_tokens;
  const cacheReadTokens = usage.cache_read_input_tokens;
  const cacheCreationTokens = usage.cache_creation_input_tokens;
  if (
    (outputTokens !== undefined && !checkIsTokenCount(outputTokens)) ||
    (cacheReadTokens !== undefined && !checkIsTokenCount(cacheReadTokens)) ||
    (cacheCreationTokens !== undefined && !checkIsTokenCount(cacheCreationTokens))
  ) {
    return null;
  }
  return usage.input_tokens + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0) + (outputTokens ?? 0);
}

/**
 * @description Return the documented context window for an exact Claude model
 * family. Unknown aliases and model ids deliberately stay unknown rather than
 * inheriting a default from a neighbouring model.
 *
 * The minor group is capped at two digits so a released id whose family carries
 * no minor at all (`claude-opus-4-20250514`) can never have its 8-digit DATE
 * read as the minor — that misread reported a 1M window for a 200k model.
 * Such an id has no minor to match on, so it stays honestly unknown.
 */
export function getClaudeContextWindowTokens(model: string): number | null {
  const match = model.toLowerCase().match(/(?:^|\/)claude-(?:opus|sonnet|haiku)-(\d+)-(\d{1,2})(?:-|$)/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 4 && minor === 5) return claude45ContextWindowTokens;
  if (major === 5 || (major === 4 && minor >= 6)) return claude46AndLaterContextWindowTokens;
  return null;
}

/**
 * @description Parse the latest valid main-session runtime fields from a Claude
 * transcript. Sidechain records are not part of the topic's live conversation,
 * so their version, model, and usage must never overwrite main-session data.
 */
export function parseClaudeRuntimeInfo(transcript: string): AgentRuntimeInfo {
  let version: string | null = null;
  let latestContextEntry: { model: string; contextUsedTokens: number } | null = null;

  for (const line of transcript.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!checkIsRecord(entry) || entry.isSidechain === true) continue;

    if (typeof entry.version === 'string' && entry.version.trim()) {
      version = entry.version;
    }
    if (entry.type !== 'assistant' || !checkIsRecord(entry.message)) continue;

    const model = entry.message.model;
    const usedTokens = getClaudeContextUsedTokens(entry.message.usage);
    if (typeof model === 'string' && model.trim() && usedTokens !== null) {
      latestContextEntry = { model, contextUsedTokens: usedTokens };
    }
  }

  return {
    version,
    model: latestContextEntry?.model ?? null,
    contextWindowTokens: latestContextEntry === null ? null : getClaudeContextWindowTokens(latestContextEntry.model),
    contextUsedTokens: latestContextEntry?.contextUsedTokens ?? null,
  };
}

/**
 * @description Read only the transcript tail needed for the latest runtime
 * metadata. A nonzero read offset can start in a JSONL record, so that partial
 * first line is discarded before parsing.
 */
export async function readClaudeRuntimeInfo(filePath: string): Promise<AgentRuntimeInfo> {
  let fileHandle: fs.promises.FileHandle | null = null;
  try {
    fileHandle = await fs.promises.open(filePath, 'r');
    const { size } = await fileHandle.stat();
    const bytesToRead = Math.min(size, claudeRuntimeInfoTailBytes);
    if (bytesToRead === 0) return parseClaudeRuntimeInfo('');

    const offset = size - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, offset);
    const text = buffer.toString('utf8', 0, bytesRead);
    if (offset === 0) return parseClaudeRuntimeInfo(text);

    const firstLineBreak = text.indexOf('\n');
    return parseClaudeRuntimeInfo(firstLineBreak === -1 ? '' : text.slice(firstLineBreak + 1));
  } finally {
    if (fileHandle) await fileHandle.close();
  }
}
