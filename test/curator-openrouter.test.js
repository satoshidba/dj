import test from 'node:test';
import assert from 'node:assert/strict';
import { curate } from '../server/curator.js';

test('curator requests only the free router and handles its structured response', async () => {
  const original = globalThis.fetch;
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test';
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ title: 'Jazz', description: 'Jazz', tempo_target: '', tracks: [], alternates: [] }) } }] }) };
  };
  try {
    const sp = { topArtists: async () => [], topTracks: async () => [], recentlyPlayed: async () => [] };
    const result = await curate({ userId: 'test-free-router', sp, brief: 'jazz', length: 6, familiarity: 0.5 });
    assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(request.body.model, 'openrouter/free');
    assert.equal(request.body.response_format.type, 'json_schema');
    assert.equal(result.title, 'Jazz');
  } finally {
    globalThis.fetch = original;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
  }
});
