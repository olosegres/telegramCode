import type { CallApiHost } from '../outputTrace';

/**
 * Bot API methods whose payload can carry `link_preview_options`. A media send
 * (`sendPhoto`/`sendVideo`/…) does not expand a standalone URL preview card, so
 * only the text-message methods are rewritten.
 */
const linkPreviewMethods = new Set(['sendMessage', 'editMessageText']);

/**
 * @description Default a text-message API payload to NO link preview by
 * injecting `link_preview_options: { is_disabled: true }`. Pure — returns the
 * payload to send. A caller that already set `link_preview_options` (or the
 * legacy `disable_web_page_preview`) wins; we only supply the default when
 * neither is present, and leave non-text methods untouched.
 */
export function applyLinkPreviewSuppression(method: string, payload: object): object {
  if (!linkPreviewMethods.has(method)) return payload;
  const base = payload as Record<string, unknown>;
  if ('link_preview_options' in base || 'disable_web_page_preview' in base) return payload;
  return { ...base, link_preview_options: { is_disabled: true } };
}

/**
 * @description Wrap `telegram.callApi` so every text message / edit the bot
 * sends defaults to NO link preview. Operator complaint: each agent message
 * containing a URL expanded into a large preview card, one per message, in the
 * muted topic. Installed once at boot alongside `installCallApiTrace`, and
 * OUTSIDE it (installed after) so the trace records the payload actually sent.
 */
export function installLinkPreviewSuppression(host: CallApiHost): void {
  const originalCallApi = host.callApi.bind(host);
  host.callApi = (method, payload, options) =>
    originalCallApi(method, applyLinkPreviewSuppression(method, payload), options);
}
