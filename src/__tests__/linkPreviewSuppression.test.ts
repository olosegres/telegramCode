import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLinkPreviewSuppression,
  installLinkPreviewSuppression,
} from '../utils/linkPreviewSuppression';
import type { CallApiHost } from '../outputTrace';

describe('applyLinkPreviewSuppression', () => {
  it('injects is_disabled into a bare sendMessage payload', () => {
    const out = applyLinkPreviewSuppression('sendMessage', { chat_id: 1, text: 'see https://x.io' });
    assert.deepEqual(out, {
      chat_id: 1,
      text: 'see https://x.io',
      link_preview_options: { is_disabled: true },
    });
  });

  it('injects is_disabled into a bare editMessageText payload', () => {
    const out = applyLinkPreviewSuppression('editMessageText', {
      chat_id: 1,
      message_id: 5,
      text: 'edited https://x.io',
    }) as Record<string, unknown>;
    assert.deepEqual(out.link_preview_options, { is_disabled: true });
  });

  it('does not mutate the input payload', () => {
    const input = { chat_id: 1, text: 'hi' };
    applyLinkPreviewSuppression('sendMessage', input);
    assert.equal('link_preview_options' in input, false);
  });

  it('respects a caller-provided link_preview_options (e.g. wants a preview)', () => {
    const input = { chat_id: 1, text: 'hi', link_preview_options: { is_disabled: false } };
    const out = applyLinkPreviewSuppression('sendMessage', input) as Record<string, unknown>;
    assert.equal(out, input);
    assert.deepEqual(out.link_preview_options, { is_disabled: false });
  });

  it('respects the legacy disable_web_page_preview flag', () => {
    const input = { chat_id: 1, text: 'hi', disable_web_page_preview: false };
    const out = applyLinkPreviewSuppression('sendMessage', input);
    assert.equal(out, input);
  });

  it('leaves non-text methods untouched', () => {
    const input = { chat_id: 1, photo: 'file_id', caption: 'look https://x.io' };
    const out = applyLinkPreviewSuppression('sendPhoto', input);
    assert.equal(out, input);
  });
});

describe('installLinkPreviewSuppression', () => {
  it('passes the augmented payload to the original callApi and preserves the result', async () => {
    const seen: Array<{ method: string; payload: object }> = [];
    const host: CallApiHost = {
      callApi: async (method, payload) => {
        seen.push({ method, payload });
        return { message_id: 42 };
      },
    };

    installLinkPreviewSuppression(host);

    const sent = await host.callApi('sendMessage', { chat_id: 1, text: 'https://x.io' });
    const edited = await host.callApi('editMessageText', { chat_id: 1, message_id: 5, text: 'x' });
    const photo = await host.callApi('sendPhoto', { chat_id: 1, photo: 'f' });

    assert.deepEqual((seen[0].payload as Record<string, unknown>).link_preview_options, {
      is_disabled: true,
    });
    assert.deepEqual((seen[1].payload as Record<string, unknown>).link_preview_options, {
      is_disabled: true,
    });
    assert.equal('link_preview_options' in (seen[2].payload as Record<string, unknown>), false);
    assert.deepEqual(sent, { message_id: 42 });
    assert.deepEqual(edited, { message_id: 42 });
    assert.deepEqual(photo, { message_id: 42 });
  });
});
