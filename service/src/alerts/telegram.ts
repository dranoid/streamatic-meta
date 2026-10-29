export interface TelegramSenderOptions {
  botToken: string;
  chatId: string;
  fetch?: typeof fetch;
}

export class TelegramError extends Error {}

export class TelegramSender {
  readonly #botToken: string;
  readonly #chatId: string;
  readonly #fetch: typeof fetch;

  constructor(options: TelegramSenderOptions) {
    this.#botToken = options.botToken;
    this.#chatId = options.chatId;
    this.#fetch = options.fetch ?? fetch;
  }

  sendPicture(jpeg: Uint8Array, caption: string): Promise<number> {
    return this.#send('sendPhoto', 'photo', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), 'alert.jpg', caption);
  }

  async sendPictures(jpegs: Uint8Array[], caption: string): Promise<number> {
    const form = new FormData();
    form.set('chat_id', this.#chatId);
    form.set(
      'media',
      JSON.stringify(jpegs.map((_, i) => ({ type: 'photo', media: `attach://picture${i}`, ...(i === 0 ? { caption } : {}) }))),
    );
    jpegs.forEach((jpeg, i) => form.set(`picture${i}`, new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), `alert-${i}.jpg`));
    const sent = await this.#post<Array<{ message_id: number }>>('sendMediaGroup', form);
    return sent[0]!.message_id;
  }

  async editCaption(messageId: number, caption: string): Promise<void> {
    const form = new FormData();
    form.set('chat_id', this.#chatId);
    form.set('message_id', String(messageId));
    form.set('caption', caption);
    await this.#post('editMessageCaption', form);
  }

  sendClip(mp4: Uint8Array, caption: string): Promise<number> {
    return this.#send('sendVideo', 'video', new Blob([new Uint8Array(mp4)], { type: 'video/mp4' }), 'alert.mp4', caption);
  }

  async #send(method: string, field: string, file: Blob, name: string, caption: string): Promise<number> {
    const form = new FormData();
    form.set('chat_id', this.#chatId);
    form.set('caption', caption);
    form.set(field, file, name);
    return (await this.#post<{ message_id: number }>(method, form)).message_id;
  }

  async #post<T>(method: string, form: FormData): Promise<T> {
    const response = await this.#fetch(`https://api.telegram.org/bot${this.#botToken}/${method}`, { method: 'POST', body: form });
    const reply = (await response.json()) as { ok: boolean; description?: string; result?: T };
    if (!reply.ok || reply.result === undefined) {
      throw new TelegramError(`Telegram refused the alert: ${reply.description ?? response.status}`);
    }
    return reply.result;
  }
}
