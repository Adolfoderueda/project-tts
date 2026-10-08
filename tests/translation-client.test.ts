import { describe, expect, test, vi } from 'vitest';
import { OllamaTranslator, TranslationError } from '../src/translation-client.js';

const config = { model: 'gemma4:e2b' as const, digest: 'a'.repeat(64) };
const tags = { models: [{ name: config.model, model: config.model, digest: config.digest }] };
const json = (value: unknown) => new Response(JSON.stringify(value));
const envelope = (translation: unknown = 'mañana') => ({
  model: config.model, created_at: '2026-10-01T00:00:00Z', done: true, done_reason: 'stop',
  message: { role: 'assistant', content: JSON.stringify({ translation }), thinking: 'PRIVATE_TEXT thinking' },
});
function fixture(chat: Response = json(envelope()), metadata: Response = json(tags)) {
  const fetchClient = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata).mockResolvedValueOnce(chat);
  return { fetchClient, translator: new OllamaTranslator(config, fetchClient) };
}
async function privateFailure(promise: Promise<string>) {
  const error = await promise.then(() => { throw new Error('Expected rejection'); }, (error: unknown) => error);
  expect(error).toBeInstanceOf(TranslationError);
  expect((error as Error).message).not.toMatch(/PRIVATE_TEXT|RAW_BODY/);
  expect((error as Error).cause).toBeUndefined();
}

describe('local translator', () => {
  test.each(['en', 'es'] as const)('identity %s preserves exact text without HTTP or masking', async (language) => {
    const { fetchClient, translator } = fixture();
    const text = '  mañana\r\n`unclosed PRIVATE_TEXT';
    expect(await translator.translate(text, language, language)).toBe(text);
    expect(fetchClient).not.toHaveBeenCalled();
  });

  test('entirely protected content preserves bytes without HTTP', async () => {
    const { fetchClient, translator } = fixture();
    const text = '\t`PRIVATE_TEXT`\r\n```sh\r\necho ñ\r\n```\r\n';
    expect(await translator.translate(text, 'en', 'es')).toBe(text);
    expect(fetchClient).not.toHaveBeenCalled();
  });

  test.each(['', ' \r\n', 'ñ'.repeat(2001), 'PRIVATE_TEXT `unclosed'])('invalid input fails before HTTP: %j', async (text) => {
    const { fetchClient, translator } = fixture();
    await privateFailure(translator.translate(text, 'en', 'es'));
    expect(fetchClient).not.toHaveBeenCalled();
  });

  test.each([['en', 'es', 'English', 'Spanish'], ['es', 'en', 'Spanish', 'English']] as const)(
    '%s to %s uses only fixed local stateless bounded requests', async (source, target, sourceLabel, targetLabel) => {
      const { fetchClient, translator } = fixture();
      expect(await translator.translate('PRIVATE_TEXT', source, target)).toBe('mañana');
      expect(fetchClient).toHaveBeenCalledTimes(2);
      expect(fetchClient.mock.calls.map(([url]) => url)).toEqual([
        'http://127.0.0.1:11434/api/tags', 'http://127.0.0.1:11434/api/chat',
      ]);
      for (const [, init] of fetchClient.mock.calls) {
        expect(init?.redirect).toBe('error');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
      }
      const init = fetchClient.mock.calls[1][1]!;
      expect(init.method).toBe('POST');
      const request = JSON.parse(init.body as string);
      expect(request).toMatchObject({ model: config.model, stream: false, think: false, keep_alive: '30s',
        options: { temperature: 0, num_ctx: 4096, num_predict: 1024 },
        format: { type: 'object', properties: { translation: { type: 'string' } }, required: ['translation'], additionalProperties: false },
      });
      expect(Object.keys(request.format.properties)).toEqual(['translation']);
      expect(request.tools).toBeUndefined();
      expect(request.messages).toHaveLength(2);
      expect(request.messages[0].role).toBe('system');
      expect(request.messages[0].content).toContain(sourceLabel);
      expect(request.messages[0].content).toContain(targetLabel);
      expect(request.messages[0].content).toMatch(/without.*(answer|execut)/i);
      expect(request.messages[1]).toEqual({ role: 'user', content: JSON.stringify({ source: 'PRIVATE_TEXT' }) });
    });

  test('masks source code and restores exact original bytes, including model delimiters', async () => {
    const fetchClient = vi.fn<typeof fetch>().mockResolvedValueOnce(json(tags)).mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      const source = JSON.parse(body.messages[1].content).source as string;
      expect(source).not.toContain('PRIVATE_TEXT');
      expect(source).not.toContain('<|think|>');
      return json(envelope(source.replace('Run', 'Mañana ejecuta')));
    });
    const translator = new OllamaTranslator(config, fetchClient);
    const code = '`PRIVATE_TEXT <|think|>`\r\n```sh\r\necho ñ\r\n```\r\n';
    expect(await translator.translate(`Run ${code}`, 'en', 'es')).toBe(`Mañana ejecuta ${code}`);
  });

  test('restored output is bounded in Unicode code points, not masked length', async () => {
    const fetchClient = vi.fn<typeof fetch>().mockResolvedValueOnce(json(tags)).mockImplementationOnce(async (_url, init) => {
      const source = JSON.parse(JSON.parse(init!.body as string).messages[1].content).source as string;
      return json(envelope(source.replace('Run', 'ñ'.repeat(1900))));
    });
    await privateFailure(new OllamaTranslator(config, fetchClient).translate(`Run \`${'x'.repeat(200)}\``, 'en', 'es'));
    expect(fetchClient).toHaveBeenCalledTimes(2);
  });

  test('accepts exactly 2000 code points without trimming or counting UTF-16 units', async () => {
    const result = '🙂'.repeat(1998) + 'ñ ';
    const { translator } = fixture(json(envelope(result)));
    expect(await translator.translate('hello', 'en', 'es')).toBe(result);
  });

  test('bounds restored text rather than rejecting inflated opaque placeholders', async () => {
    const text = 'Run ' + Array.from({ length: 50 }, () => '`x`').join(' ');
    const fetchClient = vi.fn<typeof fetch>().mockResolvedValueOnce(json(tags)).mockImplementationOnce(async (_url, init) => {
      const masked = JSON.parse(JSON.parse(init!.body as string).messages[1].content).source as string;
      expect([...masked].length).toBeGreaterThan(2000);
      return json(envelope(masked.replace('Run', 'Ejecuta')));
    });
    expect(await new OllamaTranslator(config, fetchClient).translate(text, 'en', 'es')).toBe(text.replace('Run', 'Ejecuta'));
  });

  test.each(['duplicate', 'unknown', 'reordered'] as const)('rejects %s literal markers', async (mutation) => {
    const fetchClient = vi.fn<typeof fetch>().mockResolvedValueOnce(json(tags)).mockImplementationOnce(async (_url, init) => {
      const masked = JSON.parse(JSON.parse(init!.body as string).messages[1].content).source as string;
      const markers = masked.match(/__PVB_[\w-]+_\d+__/gu)!;
      const output = mutation === 'duplicate' ? masked + markers[0]
        : mutation === 'unknown' ? masked + markers[0].replace('0__', '99__')
        : `Usa ${markers[1]} y ${markers[0]}`;
      return json(envelope(output));
    });
    await privateFailure(new OllamaTranslator(config, fetchClient).translate('Use `PRIVATE_TEXT first` and `second`', 'en', 'es'));
    expect(fetchClient).toHaveBeenCalledTimes(2);
  });

  test('malformed configured digest prevents metadata and inference calls', async () => {
    const fetchClient = vi.fn<typeof fetch>();
    await privateFailure(new OllamaTranslator({ ...config, digest: 'PRIVATE_TEXT' }, fetchClient).translate('hello', 'en', 'es'));
    expect(fetchClient).not.toHaveBeenCalled();
  });

  test.each([{}, { models: null }, { models: [{}] }, { models: [{ name: config.model, digest: 'b'.repeat(64) }] },
    { models: [{ name: 'other', digest: config.digest }] }, { models: [{ name: config.model, digest: 'PRIVATE_TEXT' }] },
  ])('malformed or changed model metadata prevents inference: %j', async (metadata) => {
    const { translator, fetchClient } = fixture(json(envelope()), json(metadata));
    await privateFailure(translator.translate('PRIVATE_TEXT', 'en', 'es'));
    expect(fetchClient).toHaveBeenCalledTimes(1);
  });

  test('checks the installed digest every translation with no accumulated history', async () => {
    const fetchClient = vi.fn<typeof fetch>().mockResolvedValueOnce(json(tags)).mockResolvedValueOnce(json(envelope()))
      .mockResolvedValueOnce(json({ models: [{ name: config.model, digest: 'b'.repeat(64) }] }));
    const translator = new OllamaTranslator(config, fetchClient);
    expect(await translator.translate('one', 'en', 'es')).toBe('mañana');
    await privateFailure(translator.translate('PRIVATE_TEXT two', 'en', 'es'));
    expect(fetchClient).toHaveBeenCalledTimes(3);
  });

  const malformedEnvelopes: unknown[] = [null, [], {}, { ...envelope(), model: 'other' },
    { ...envelope(), done: false }, { ...envelope(), done_reason: 'length' }, { ...envelope(), done_reason: 'error' },
    { ...envelope(), message: null }, { ...envelope(), message: { role: 'user', content: '{"translation":"mañana"}' } },
    { ...envelope(), message: { role: 'assistant', content: 1 } },
    { ...envelope(), message: { ...envelope().message, tool_calls: [{ function: { name: 'PRIVATE_TEXT' } }] } },
    { ...envelope(), message: { ...envelope().message, tool_calls: {} } },
  ];
  test.each(malformedEnvelopes.map((body) => ({ body })))('rejects invalid chat envelope without retries: $body', async ({ body }) => {
    const { translator, fetchClient } = fixture(json(body));
    await privateFailure(translator.translate('PRIVATE_TEXT', 'en', 'es'));
    expect(fetchClient).toHaveBeenCalledTimes(2);
  });

  test.each(['', ' ', 1, null, 'ñ'.repeat(2001), '<|channel>', '<channel|>', '<|think|>',
    '<think>PRIVATE_TEXT</think>', '<start_of_turn>model', '<end_of_turn>', '<|im_start|>assistant',
  ])('rejects invalid translation or visible control artifacts: %j', async (translation) => {
    const { translator, fetchClient } = fixture(json(envelope(translation)));
    await privateFailure(translator.translate('PRIVATE_TEXT', 'en', 'es'));
    expect(fetchClient).toHaveBeenCalledTimes(2);
  });

  test.each(['RAW_BODY PRIVATE_TEXT', '```json\n{"translation":"hola"}\n```', '{"translation":"hola","extra":"PRIVATE_TEXT"}',
    '{}', 'null', '[]', '{"translation":'])('strict inner JSON rejects %j', async (content) => {
    const { translator, fetchClient } = fixture(json({ ...envelope(), message: { role: 'assistant', content } }));
    await privateFailure(translator.translate('PRIVATE_TEXT', 'en', 'es'));
    expect(fetchClient).toHaveBeenCalledTimes(2);
  });

  test('missing literal marker fails rather than mutating code', async () => {
    const { translator, fetchClient } = fixture();
    await privateFailure(translator.translate('PRIVATE_TEXT `echo ñ`', 'en', 'es'));
    expect(fetchClient).toHaveBeenCalledTimes(2);
  });

  test.each(['tags', 'chat'] as const)('invalid outer JSON at %s is private and not retried', async (stage) => {
    const bad = new Response('RAW_BODY PRIVATE_TEXT');
    const { translator, fetchClient } = fixture(stage === 'chat' ? bad : json(envelope()), stage === 'tags' ? bad : json(tags));
    await privateFailure(translator.translate('PRIVATE_TEXT', 'en', 'es'));
    expect(fetchClient).toHaveBeenCalledTimes(stage === 'tags' ? 1 : 2);
  });

  test.each([['tags', 500], ['chat', 503], ['tags', 302], ['chat', 307]] as const)('HTTP %s %i is private and never retried', async (stage, status) => {
    const bad = new Response('RAW_BODY PRIVATE_TEXT', { status });
    const { translator, fetchClient } = fixture(stage === 'chat' ? bad : json(envelope()), stage === 'tags' ? bad : json(tags));
    await privateFailure(translator.translate('PRIVATE_TEXT', 'en', 'es'));
    expect(fetchClient).toHaveBeenCalledTimes(stage === 'tags' ? 1 : 2);
  });

  test.each(['tags', 'chat'] as const)('unavailable/timeout at %s is sanitized without retry', async (stage) => {
    const fetchClient = vi.fn<typeof fetch>();
    if (stage === 'chat') fetchClient.mockResolvedValueOnce(json(tags));
    fetchClient.mockRejectedValueOnce(new Error('PRIVATE_TEXT RAW_BODY timeout'));
    await privateFailure(new OllamaTranslator(config, fetchClient).translate('PRIVATE_TEXT', 'en', 'es'));
    expect(fetchClient).toHaveBeenCalledTimes(stage === 'tags' ? 1 : 2);
  });

  test.each([
    ['tags', false], ['chat', false], ['tags', true], ['chat', true],
  ] as const)('HTTP failure at %s cancels body best-effort (cancel rejects: %s)', async (stage, rejects) => {
    let cancellations = 0;
    const bad = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('RAW_BODY PRIVATE_TEXT Bearer secret-token')); },
      cancel() {
        cancellations++;
        if (rejects) return Promise.reject(new Error('RAW_BODY PRIVATE_TEXT Bearer secret-token'));
      },
    }), { status: 503 });
    const read = vi.spyOn(bad.body!, 'getReader');
    const { translator, fetchClient } = fixture(stage === 'chat' ? bad : json(envelope()), stage === 'tags' ? bad : json(tags));
    const error = await translator.translate('PRIVATE_TEXT', 'en', 'es').catch((error: unknown) => error);
    expect(error).toBeInstanceOf(TranslationError);
    expect((error as Error).message).toMatch(/local translation failed/i);
    expect((error as Error).message).not.toMatch(/RAW_BODY|PRIVATE_TEXT|Bearer|secret-token/);
    expect((error as Error).cause).toBeUndefined();
    expect(cancellations).toBe(1);
    expect(read).not.toHaveBeenCalled();
    expect(fetchClient).toHaveBeenCalledTimes(stage === 'tags' ? 1 : 2);
  });

  test('uses a 120-second timeout for each request', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const { translator } = fixture();
      await translator.translate('hello', 'en', 'es');
      expect(timeout.mock.calls).toEqual([[120_000], [120_000]]);
    } finally { timeout.mockRestore(); }
  });

  test.each(['tags', 'chat'] as const)('streaming %s body over 1 MiB cancels even without Content-Length', async (stage) => {
    const cancel = vi.fn();
    let chunks = 0;
    const bad = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(512 * 1024)); }, cancel,
    }));
    const { translator, fetchClient } = fixture(stage === 'chat' ? bad : json(envelope()), stage === 'tags' ? bad : json(tags));
    await privateFailure(translator.translate('PRIVATE_TEXT', 'en', 'es'));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(chunks).toBeLessThanOrEqual(4);
    expect(fetchClient).toHaveBeenCalledTimes(stage === 'tags' ? 1 : 2);
  });

  test('stream read failures do not leak private text', async () => {
    const bad = new Response(new ReadableStream({ start(controller) { controller.error(new Error('PRIVATE_TEXT RAW_BODY')); } }));
    const { translator, fetchClient } = fixture(bad);
    await privateFailure(translator.translate('PRIVATE_TEXT', 'en', 'es'));
    expect(fetchClient).toHaveBeenCalledTimes(2);
  });

  test.each(['tags', 'chat'] as const)('accepts a valid %s body at exactly 1 MiB', async (stage) => {
    const encoded = JSON.stringify(stage === 'tags' ? tags : envelope());
    const boundary = new Response(encoded + ' '.repeat(1024 * 1024 - Buffer.byteLength(encoded)));
    const { translator } = fixture(stage === 'chat' ? boundary : json(envelope()), stage === 'tags' ? boundary : json(tags));
    expect(await translator.translate('hello', 'en', 'es')).toBe('mañana');
  });

  test('counts response bytes rather than decoded characters', async () => {
    const { translator, fetchClient } = fixture(new Response(JSON.stringify(envelope('ñ'.repeat(600_000)))));
    await privateFailure(translator.translate('PRIVATE_TEXT', 'en', 'es'));
    expect(fetchClient).toHaveBeenCalledTimes(2);
  });

  test('invalid UTF-8 response is rejected rather than replacing bytes', async () => {
    const body = new Uint8Array(Buffer.from(JSON.stringify(envelope('ñ'))));
    const index = body.indexOf(0xc3);
    body[index] = 0xff;
    const { translator, fetchClient } = fixture(new Response(body));
    await privateFailure(translator.translate('PRIVATE_TEXT', 'en', 'es'));
    expect(fetchClient).toHaveBeenCalledTimes(2);
  });
});
