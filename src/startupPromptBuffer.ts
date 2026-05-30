/**
 * @description FIFO buffer for prompts typed while an agent session is still
 * starting up.
 *
 * Both backends have a startup window where the session is not yet ready to
 * receive input: Claude boots a tmux pane + `node-pty`, OpenCode boots the
 * local server and `POST /session`. A message typed during that window used to
 * be dropped — the bot saw `checkIsActive === false`, routed the text to the
 * "no agent running" guidance, and the user had to retype once the session was
 * up. This buffer captures those prompts and replays them, in arrival order,
 * the moment the session becomes active.
 *
 * Adapter-agnostic on purpose: the startup race is identical for Claude and
 * OpenCode, so the fix lives in the bot layer instead of being duplicated in
 * each adapter. Keyed by `keyToString(ThreadKey)`.
 */
export class StartupPromptBuffer {
  private startingThreads = new Set<string>();
  private bufferedPrompts = new Map<string, string[]>();
  /** Threads that already received the "queued while starting" ack, so we
   *  ack once per startup window rather than on every buffered prompt. */
  private ackedThreads = new Set<string>();

  /** Mark a thread as mid-startup; inbound text should now be buffered. */
  markStarting(threadId: string): void {
    this.startingThreads.add(threadId);
  }

  /** Whether a thread's session is currently starting. */
  checkIsStarting(threadId: string): boolean {
    return this.startingThreads.has(threadId);
  }

  /**
   * Buffer one prompt for a starting thread.
   * @returns `true` if this is the first buffered prompt for the current
   * startup window (the caller uses it to send the ack only once).
   */
  addPrompt(threadId: string, text: string): boolean {
    const prompts = this.bufferedPrompts.get(threadId) ?? [];
    prompts.push(text);
    this.bufferedPrompts.set(threadId, prompts);

    const isFirstForWindow = !this.ackedThreads.has(threadId);
    this.ackedThreads.add(threadId);
    return isFirstForWindow;
  }

  /**
   * End the startup window and return the buffered prompts in FIFO order,
   * clearing all per-thread state. Call on successful start to replay them.
   */
  drainPrompts(threadId: string): string[] {
    const prompts = this.bufferedPrompts.get(threadId) ?? [];
    this.startingThreads.delete(threadId);
    this.bufferedPrompts.delete(threadId);
    this.ackedThreads.delete(threadId);
    return prompts;
  }

  /**
   * End the startup window and discard the buffer without replaying. Call when
   * the start fails — the prompts would have nowhere to go.
   */
  discardPrompts(threadId: string): void {
    this.startingThreads.delete(threadId);
    this.bufferedPrompts.delete(threadId);
    this.ackedThreads.delete(threadId);
  }
}
