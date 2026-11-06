/**
 * Minimal dual-format LLM client (PROJECT_PLAN.md §13 — AI analysis reports).
 *
 * Supports two on-the-wire formats the deployer picks in console settings:
 *   - 'anthropic'  → POST {base}/v1/messages, `x-api-key` + `anthropic-version`,
 *                    response `content[].text`.
 *   - 'openai'     → POST {base}/chat/completions, `Authorization: Bearer`,
 *                    response `choices[0].message.content`. This covers OpenAI
 *                    itself and every OpenAI-compatible endpoint (DeepSeek,
 *                    OpenRouter, local vLLM/Ollama, …), so `base` is fully
 *                    user-configurable.
 *
 * The provider, base URL, model name and API key are all supplied by the
 * deployer (stored in instance_settings, edited via the console). No secret is
 * ever written into a repo file (§21); the key lives only in the deployer's own
 * D1 and is never returned to the browser.
 */

export type AiProvider = 'openai' | 'anthropic';

export interface AiConfig {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** Sensible default base URLs when the deployer leaves the field blank. */
export const DEFAULT_BASE_URL: Record<AiProvider, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

export class LlmError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Read a bounded slice of the provider's error body for diagnostics (never the
 *  key — only the upstream's own message), so the console can show *why* a call
 *  failed (bad key, unknown model, rate limit) instead of a bare 500. */
async function errorText(res: Response, apiKey: string): Promise<string> {
  let body = '';
  try {
    body = await res.text();
    if (apiKey) body = body.replaceAll(apiKey, '[redacted]');
    body = body.slice(0, 500);
  } catch { /* ignore */ }
  return body || res.statusText || `HTTP ${res.status}`;
}

/** A non-streaming report needs one JSON response. Never expose raw network
 * errors or malformed provider bodies, which can contain credentials. */
async function requestJSON(url: string, init: RequestInit, apiKey: string): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new LlmError(res.status, await errorText(res, apiKey));
    if (res.headers.get('content-type')?.includes('text/event-stream')) {
      await res.body?.cancel();
      throw new LlmError(502, 'AI provider returned a stream despite stream=false. Check its non-streaming API support.');
    }
    let data: unknown;
    try { data = await res.json(); }
    catch (error) {
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw error;
      throw new LlmError(502, 'AI provider returned invalid JSON. Check the API base URL and response format.');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new LlmError(502, 'AI provider returned an unexpected response format.');
    }
    return data as Record<string, unknown>;
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      throw new LlmError(504, 'AI provider timed out after 60 seconds. Please retry.');
    }
    throw new LlmError(502, 'Could not connect to the AI provider. Check the API base URL and try again.');
  }
}

/**
 * One-shot completion. Returns the assistant's text. Throws LlmError on a
 * non-2xx upstream response (status carried through so the caller can map it).
 */
export async function callLLM(cfg: AiConfig, system: string, user: string, maxTokens = 2200): Promise<string> {
  const base = (cfg.baseUrl || DEFAULT_BASE_URL[cfg.provider]).replace(/\/+$/, '');

  if (cfg.provider === 'anthropic') {
    const data = await requestJSON(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    }, cfg.apiKey);
    const blocks = Array.isArray(data.content) ? data.content : [];
    const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();
    if (!text) throw new LlmError(502, 'empty response from model');
    return text;
  }

  // openai-compatible
  const data = await requestJSON(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      // Some compatible gateways (including APIMart) default to SSE.
      stream: false,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  }, cfg.apiKey);
  const content = Array.isArray(data.choices) ? data.choices[0]?.message?.content : null;
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) throw new LlmError(502, 'empty response from model');
  return text;
}
