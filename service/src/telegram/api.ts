const API = 'https://api.telegram.org';

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface Button {
  text: string;
  data: string;
}

export interface VoiceFile {
  file_id: string;
  file_size?: number;
}

export interface Update {
  update_id: number;
  message?: {
    from?: { id: number };
    chat: { id: number; type: string };
    text?: string;
    voice?: VoiceFile;
    audio?: VoiceFile;
  };
  callback_query?: { id: string; from: { id: number }; data?: string };
}

export interface BotChat {
  sendText(to: number, text: string, buttons?: Button[]): Promise<void>;
  sendPicture(to: number, jpeg: Uint8Array, caption: string): Promise<void>;
  answer(buttonPress: string): Promise<void>;
  download(file: string): Promise<Uint8Array>;
}

// The token is part of every address here, so an address never goes into an error or a log.
export class TelegramApi implements BotChat {
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor({ token, fetch: fetchImpl = fetch }: { token: string; fetch?: typeof fetch }) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async #result<T>(method: string, init?: RequestInit, query = ''): Promise<T> {
    const response = await this.#fetch(`${API}/bot${this.#token}/${method}${query}`, init as RequestInit);
    const reply = (await response.json()) as { ok: boolean; description?: string; result?: T };
    if (!reply.ok || reply.result === undefined) throw new TelegramError(`Telegram refused ${method}: ${reply.description ?? response.status}`, response.status);
    return reply.result;
  }

  #json<T>(method: string, body: unknown): Promise<T> {
    return this.#result<T>(method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  me(): Promise<{ username: string }> {
    return this.#result('getMe');
  }

  updates(offset: number, waitSeconds: number): Promise<Update[]> {
    const query = new URLSearchParams({ offset: String(offset), timeout: String(waitSeconds), allowed_updates: JSON.stringify(['message', 'callback_query']) });
    return this.#result('getUpdates', undefined, `?${query}`);
  }

  async sendText(to: number, text: string, buttons?: Button[]): Promise<void> {
    await this.#json('sendMessage', {
      chat_id: to,
      text,
      ...(buttons ? { reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))] } } : {}),
    });
  }

  async sendPicture(to: number, jpeg: Uint8Array, caption: string): Promise<void> {
    const form = new FormData();
    form.set('chat_id', String(to));
    form.set('caption', caption);
    form.set('photo', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), 'alert.jpg');
    await this.#result('sendPhoto', { method: 'POST', body: form });
  }

  async answer(buttonPress: string): Promise<void> {
    await this.#json('answerCallbackQuery', { callback_query_id: buttonPress });
  }

  async download(file: string): Promise<Uint8Array> {
    const { file_path: path } = await this.#json<{ file_path: string }>('getFile', { file_id: file });
    const reply = await this.#fetch(`${API}/file/bot${this.#token}/${path}`);
    if (!reply.ok) throw new TelegramError('Telegram refused the file.', reply.status);
    return new Uint8Array(await reply.arrayBuffer());
  }
}

const LONG_POLL_SECONDS = 25;
const AFTER_A_FAILURE_MS = 5_000;
// 401 is a wrong token. 409 is another reader of this bot, or a webhook on it, which this must not take over: it may be another product's bot.
const CANNOT_READ = new Set([401, 409]);

// Long polling, so the bot needs no address of its own and opens nothing to the internet.
export async function pollUpdates(
  api: Pick<TelegramApi, 'updates'>,
  handle: (update: Update) => void,
  { wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)), stopped = () => false }: { wait?: (ms: number) => Promise<void>; stopped?: () => boolean } = {},
): Promise<void> {
  let offset = 0;
  while (!stopped()) {
    try {
      for (const update of await api.updates(offset, LONG_POLL_SECONDS)) {
        offset = update.update_id + 1;
        handle(update);
      }
    } catch (error) {
      console.error(`Reading Telegram: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof TelegramError && CANNOT_READ.has(error.status)) return;
      await wait(AFTER_A_FAILURE_MS);
    }
  }
}
