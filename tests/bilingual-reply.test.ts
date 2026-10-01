import { expect, test, vi } from 'vitest';
import { replyBilingualToEvent, type BilingualReview } from '../src/bilingual-reply.js';
import type { VerifiedDestination } from '../src/opencode-reply.js';
import type { ChatLanguage, ProjectConfig } from '../src/config.js';
import type { CapturedEvent } from '../src/events.js';

const project: ProjectConfig = { id: 'demo', name: 'Demo Project', directory: 'C:\\demo' };
const event: CapturedEvent = { id: 'event-1', projectId: 'demo', projectName: 'Demo Project', sessionId: 'session-1', kind: 'turn-ended', occurredAt: '2026-09-29T00:00:00Z', summary: 'Turn finished', rawEventType: 'session.idle' };
const destination = { project, sessionId: event.sessionId };
function setup(options: { language?: ChatLanguage; source?: string | null; translated?: string; target?: string | null; approved?: boolean; error?: string } = {}) {
  const order: string[] = [];
  const verify = vi.fn(async () => { order.push('verify'); return destination; });
  const transcribe = vi.fn(async () => { order.push('transcribe'); return 'texto original'; });
  const edit = vi.fn(async () => { order.push('edit'); return options.source === undefined ? 'texto revisado' : options.source; });
  const translate = vi.fn(async () => { order.push('translate'); if (options.error) throw new Error(options.error); return options.translated ?? 'reviewed text'; });
  const editTarget = vi.fn(async () => { order.push('editTarget'); return options.target === undefined ? 'final correction' : options.target; });
  const confirmBilingual = vi.fn(async () => { order.push('confirm'); return options.approved ?? true; });
  const send = vi.fn(async () => { order.push('send'); });
  return { order, translate, editTarget, confirmBilingual, send, run: () => replyBilingualToEvent(event, project, 'recording.wav', options.language ?? 'en', { transcribe }, { translate }, { verify, send }, { edit, editTarget, confirmBilingual }) };
}
test('verifies first, translates edited source once, and sends exactly approved target correction', async () => {
  const { run, order, translate, confirmBilingual, send } = setup();
  expect(await run()).toBe('sent');
  expect(order).toEqual(['verify', 'transcribe', 'edit', 'translate', 'editTarget', 'confirm', 'send']);
  expect(translate).toHaveBeenCalledExactlyOnceWith('texto revisado', 'es', 'en');
  expect(confirmBilingual).toHaveBeenCalledWith(destination, { spanishText: 'texto revisado', targetText: 'final correction', chatLanguage: 'en' });
  expect(send).toHaveBeenCalledExactlyOnceWith(destination, 'final correction');
});
test('Spanish destination skips translation but offers final review', async () => {
  const c = setup({ language: 'es' });
  expect(await c.run()).toBe('sent');
  expect(c.translate).not.toHaveBeenCalled();
  expect(c.editTarget).toHaveBeenCalledWith({ spanishText: 'texto revisado', targetText: 'texto revisado', chatLanguage: 'es' });
});
test.each([{ source: null }, { source: '   ' }, { target: null }, { target: '\n ' }, { approved: false }])('cancels without send %j', async options => {
  const c = setup(options);
  expect(await c.run()).toBe('cancelled');
  expect(c.send).not.toHaveBeenCalled();
});
test.each(['source', 'translated', 'target'] as const)('bounds %s before next stage', async field => {
  const c = setup({ [field]: '😀'.repeat(2001) });
  await expect(c.run()).rejects.toThrow('2000');
  expect(c.send).not.toHaveBeenCalled();
  expect(c.confirmBilingual).not.toHaveBeenCalled();
  if (field === 'source') expect(c.translate).not.toHaveBeenCalled();
  if (field === 'translated') expect(c.editTarget).not.toHaveBeenCalled();
});
test.each(['Translation failed', 'Model digest mismatch'])('%s prevents confirmation', async error => {
  const c = setup({ error });
  await expect(c.run()).rejects.toThrow(error);
  expect(c.confirmBilingual).not.toHaveBeenCalled();
  expect(c.send).not.toHaveBeenCalled();
});

test('keeps exact immutable approved bytes even if the prompt mutates its review object', async () => {
  const targetText = 'final\n`C:\\demo`\r\x1b[31m\u202e';
  const send = vi.fn(async () => undefined);
  const translate = vi.fn(async () => 'reviewed text');
  const confirmBilingual = vi.fn(async (dest: VerifiedDestination, review: BilingualReview) => {
    expect(dest).toBe(destination);
    expect(review.targetText).toBe(targetText);
    review.targetText = 'changed by prompt';
    return true;
  });
  expect(await replyBilingualToEvent(event, project, 'recording.wav', 'en',
    { transcribe: async () => 'texto original' }, { translate }, { verify: async () => destination, send },
    { edit: async () => 'texto revisado', editTarget: async () => targetText, confirmBilingual })).toBe('sent');
  expect(translate).toHaveBeenCalledExactlyOnceWith('texto revisado', 'es', 'en');
  expect(send).toHaveBeenCalledExactlyOnceWith(destination, targetText);
});

test('invalid empty translation fails before target editing', async () => {
  const c = setup({ translated: '   ' });
  await expect(c.run()).rejects.toThrow('empty');
  expect(c.editTarget).not.toHaveBeenCalled();
  expect(c.confirmBilingual).not.toHaveBeenCalled();
  expect(c.send).not.toHaveBeenCalled();
});
