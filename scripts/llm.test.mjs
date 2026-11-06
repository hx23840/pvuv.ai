import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['workers/console/src/llm.ts'], bundle: true,
  write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { callLLM, LlmError } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const config = { provider: 'openai', baseUrl: 'https://provider.example/v1/', model: 'test-model', apiKey: 'test-secret' };
const completion = (text) => Response.json({ choices: [{ message: { content: text } }] });

test('requests non-streaming JSON from gateways that default to SSE', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://provider.example/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer test-secret');
    assert.equal(options.headers.accept, 'application/json');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'test-model');
    assert.equal(body.max_tokens, 2200);
    return body.stream === false ? completion('  ## Report\nValid report  ')
      : new Response('data: {"choices":[]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  assert.equal(await callLLM(config, 'system', 'snapshot'), '## Report\nValid report');
});

test('Anthropic format still returns text and explicitly disables streaming', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(JSON.parse(options.body).stream, false);
    assert.equal(options.headers['x-api-key'], 'test-secret');
    return Response.json({ content: [{ type: 'thinking', text: 'private reasoning' }, { type: 'text', text: 'Report' }] });
  });
  assert.equal(await callLLM({ ...config, provider: 'anthropic', baseUrl: '' }, 'system', 'snapshot'), 'Report');
});

test('unexpected streams are cancelled and return an actionable provider error', async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }));
  await assert.rejects(callLLM(config, '', ''), (e) => e instanceof LlmError && e.status === 502 && /stream=false/.test(e.message));
  assert.equal(cancelled, true);
});

test('invalid JSON, null and non-text completions do not escape as internal errors', async (t) => {
  const responses = [new Response('<html>secret diagnostic</html>'), Response.json(null),
    Response.json({ choices: [{ message: { content: { unexpected: true } } }] })];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  for (let i = 0; i < 3; i++) {
    await assert.rejects(callLLM(config, '', ''), (e) => e instanceof LlmError && e.status === 502 && !e.message.includes('secret diagnostic'));
  }
});

test('network failures and timeouts give safe, specific diagnostics', async (t) => {
  let timeout = false;
  t.mock.method(globalThis, 'fetch', async () => {
    if (timeout) throw new DOMException('aborted', 'TimeoutError');
    throw new Error('connection failed with test-secret');
  });
  await assert.rejects(callLLM(config, '', ''), (e) => e instanceof LlmError && /connect/.test(e.message) && !e.message.includes('test-secret'));
  timeout = true;
  await assert.rejects(callLLM(config, '', ''), (e) => e instanceof LlmError && e.status === 504 && /60 seconds/.test(e.message));
});

test('provider rejection preserves status and explanation while redacting the key', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Invalid key test-secret', { status: 401 }));
  await assert.rejects(callLLM(config, '', ''), (e) => e instanceof LlmError && e.status === 401 && e.message === 'Invalid key [redacted]');
});
