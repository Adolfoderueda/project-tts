import { describe, expect, test, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type { CapturedEvent } from '../src/events.js';
import type { ProjectConfig } from '../src/config.js';
import type { VerifiedDestination } from '../src/opencode-reply.js';
import { replyToEvent, LineTerminalPrompt } from '../src/reply.js';

const project: ProjectConfig = { id: 'demo', name: 'Demo Project', directory: 'C:\\demo' };
const event: CapturedEvent = { id: 'event-1', projectId: 'demo', projectName: 'Demo Project', sessionId: 'session-1', kind: 'turn-ended', occurredAt: '2026-09-29T00:00:00Z', summary: 'Turn finished', rawEventType: 'session.idle' };
const destination: VerifiedDestination = { project, sessionId: event.sessionId };

describe('replyToEvent', () => {
  function setup(options: { transcript?: string; edited?: string | null; approved?: boolean; verifyError?: Error; transcribeError?: Error; sendError?: Error } = {}) {
    const send = vi.fn(async () => { if (options.sendError) throw options.sendError; });
    const verify = vi.fn(async () => { if (options.verifyError) throw options.verifyError; return destination; });
    const transcribe = vi.fn(async () => { if (options.transcribeError) throw options.transcribeError; return options.transcript ?? 'texto original'; });
    const edit = vi.fn(async () => { expect(send).not.toHaveBeenCalled(); return options.edited === undefined ? 'texto corregido' : options.edited; });
    const confirm = vi.fn(async () => { expect(send).not.toHaveBeenCalled(); return options.approved ?? false; });
    return { send, verify, transcribe, edit, confirm, run: () => replyToEvent(event, project, 'recording.wav', { transcribe }, { verify, send }, { edit, confirm }) };
  }

  test('sends only final edited text after verified destination is explicitly approved', async () => {
    const context = setup({ approved: true });
    expect(await context.run()).toBe('sent');
    expect(context.transcribe).toHaveBeenCalledWith('recording.wav');
    expect(context.verify).toHaveBeenCalledWith(project, event.sessionId);
    expect(context.edit).toHaveBeenCalledWith('texto original');
    expect(context.confirm).toHaveBeenCalledWith(destination, 'texto corregido');
    expect(context.send).toHaveBeenCalledExactlyOnceWith(destination, 'texto corregido');
  });

  test.each([{ edited: null }, { approved: false }, { edited: '   ', approved: true }, { transcript: '   ', approved: true }])('cancels without sending for %j', async (options) => {
    const context = setup(options);
    expect(await context.run()).toBe('cancelled');
    expect(context.send).not.toHaveBeenCalled();
    if (options.transcript === '   ') expect(context.edit).not.toHaveBeenCalled();
    if (options.edited === '   ') expect(context.confirm).not.toHaveBeenCalled();
  });

  test.each(['verifyError', 'transcribeError', 'sendError'] as const)('%s fails without extra sends', async (field) => {
    const context = setup({ approved: true, [field]: new Error('secret-token') });
    await expect(context.run()).rejects.toThrow('secret-token');
    expect(context.send).toHaveBeenCalledTimes(field === 'sendError' ? 1 : 0);
    if (field === 'verifyError') expect(context.confirm).not.toHaveBeenCalled();
  });
});

describe('LineTerminalPrompt', () => {
  function terminal() {
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = '';
    output.on('data', chunk => { printed += chunk.toString(); });
    const prompt = new LineTerminalPrompt(input, output, event);
    return { input, prompt, printed: () => printed };
  }

  test('shows original and complete final text, project, event and verified session before literal yes', async () => {
    const { input, prompt, printed } = terminal();
    const editing = prompt.edit('original');
    input.write('corregido final\n');
    expect(await editing).toBe('corregido final');
    const confirmation = prompt.confirm(destination, 'corregido final');
    expect(printed()).toContain('original');
    expect(printed()).toContain('Demo Project');
    expect(printed()).toContain('session-1');
    expect(printed()).toContain('event-1');
    expect(printed()).toContain('Turn finished');
    expect(printed()).toContain('corregido final');
    input.write('yes\n');
    expect(await confirmation).toBe(true);
    prompt.close();
  });

  test.each(['', 'y', 'YES', ' yes ', 'no', 'unexpected'])('rejects answer %j', async answer => {
    const { input, prompt } = terminal();
    const response = prompt.confirm(destination, 'final');
    input.write(`${answer}\n`);
    expect(await response).toBe(false);
    prompt.close();
  });

  test('does not treat a pre-typed yes as approval of an unseen destination', async () => {
    const { input, prompt } = terminal();
    const editing = prompt.edit('original');
    input.write('changed\nyes\n');
    expect(await editing).toBe('changed');
    const confirmation = prompt.confirm(destination, 'changed');
    input.write('no\n');
    expect(await confirmation).toBe(false);
    prompt.close();
  });

  test('EOF cancels edit and confirmation, including after editing', async () => {
    const first = terminal();
    const editing = first.prompt.edit('original');
    first.input.end();
    expect(await editing).toBeNull();
    first.prompt.close();
    const second = terminal();
    const edited = second.prompt.edit('original');
    second.input.write('\n');
    expect(await edited).toBe('original');
    const confirmation = second.prompt.confirm(destination, 'original');
    second.input.end();
    expect(await confirmation).toBe(false);
    second.prompt.close();
  });

  test('Ctrl+C cancels instead of sending', async () => {
    const { input, prompt } = terminal();
    const response = prompt.confirm(destination, 'final');
    input.write('\x03');
    expect(await response).toBe(false);
    prompt.close();
  });
});
