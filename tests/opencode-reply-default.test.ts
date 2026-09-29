import { describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  headers: vi.fn(),
  make: vi.fn(),
}));
vi.mock('@opencode/client/service', () => ({ Service: { discover: mocks.discover, headers: mocks.headers } }));
vi.mock('@opencode/client', () => ({ OpenCode: { make: mocks.make } }));

import { createReplyClient } from '../src/opencode-reply.js';

describe('default OpenCode adapter', () => {
  test('discovers the existing service and passes its authentication headers to V2 client', async () => {
    const endpoint = { url: 'http://127.0.0.1:54321', password: 'test-secret' };
    const headers = { Authorization: 'Basic locally-derived' };
    const client = { session: { get: vi.fn(), prompt: vi.fn() } };
    mocks.discover.mockResolvedValueOnce(endpoint);
    mocks.headers.mockReturnValueOnce(headers);
    mocks.make.mockReturnValueOnce(client);

    expect(await createReplyClient()).toBe(client);
    expect(mocks.discover).toHaveBeenCalledOnce();
    expect(mocks.headers).toHaveBeenCalledWith(endpoint);
    expect(mocks.make).toHaveBeenCalledWith({ baseUrl: endpoint.url, headers });
  });

  test('does not construct a client when no healthy service exists', async () => {
    mocks.discover.mockResolvedValueOnce(undefined);
    await expect(createReplyClient()).rejects.toThrow(/No healthy OpenCode V2 service/);
    expect(mocks.make).not.toHaveBeenCalled();
  });
});
