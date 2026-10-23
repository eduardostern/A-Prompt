/**
 * DeepSeek chat API, called straight from the browser with the visitor's own
 * key (DeepSeek allows this origin). OpenAI-style streaming: SSE `data:`
 * lines carrying `choices[0].delta.content`, and `reasoning_content` while
 * the model thinks, ending with `data: [DONE]`.
 */
export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_MODEL = 'deepseek-flash'; // DeepSeek V4.1 Flash

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatChunk {
  kind: 'text' | 'thinking';
  text: string;
}

export interface ChatOptions {
  key: string;
  messages: ChatMessage[];
  /** Let the model think first (slower, better code). */
  thinking?: boolean;
  maxTokens?: number;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

export type ChatFn = (options: ChatOptions) => AsyncIterable<ChatChunk>;

/** A failed call; `status` 0 means the network, not DeepSeek. */
export class DeepSeekError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Short explanations for the BBS screen. */
export function explain(err: unknown): string {
  if (!(err instanceof DeepSeekError)) return 'The line went dead. Try again.';
  switch (err.status) {
    case 0: return 'Cannot reach api.deepseek.com. Check your connection.';
    case 401: return 'DeepSeek refused the key. Fix it in the AI board panel or type it again.';
    case 402: return 'Your DeepSeek balance is empty. Top up at platform.deepseek.com/top_up.';
    case 429: return 'DeepSeek is busy (rate limit). Wait a moment and try again.';
    case 500: case 503: return 'DeepSeek is overloaded right now. Try again shortly.';
    default: return `DeepSeek error ${err.status}: ${err.message}`;
  }
}

export async function* streamChat(options: ChatOptions): AsyncGenerator<ChatChunk> {
  const fetchFn = options.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.key}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: options.messages,
        stream: true,
        max_tokens: options.maxTokens ?? 4096,
        reasoning_effort: options.thinking ? 'high' : 'none',
      }),
      signal: options.signal,
    });
  } catch (e) {
    throw new DeepSeekError(0, (e as Error).message);
  }
  if (!res.ok || !res.body) {
    let message = res.statusText;
    try {
      const body = await res.json() as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch { /* not JSON */ }
    throw new DeepSeekError(res.status, message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      throw new DeepSeekError(0, (e as Error).message);
    }
    if (chunk.done) return;
    pending += decoder.decode(chunk.value, { stream: true });
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      let json: { choices?: { delta?: { content?: string | null; reasoning_content?: string | null } }[] };
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = json.choices?.[0]?.delta;
      if (delta?.reasoning_content) yield { kind: 'thinking', text: delta.reasoning_content };
      if (delta?.content) yield { kind: 'text', text: delta.content };
    }
  }
}
