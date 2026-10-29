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

  sendClip(mp4: Uint8Array, caption: string): Promise<number> {
    return this.#send('sendVideo', 'video', new Blob([new Uint8Array(mp4)], { type: 'video/mp4' }), 'alert.mp4', caption);
  }

  async #send(method: string, field: string, file: Blob, name: string, caption: string): Promise<number> {
    const form = new FormData();
    form.set('chat_id', this.#chatId);
    form.set('caption', caption);
    form.set(field, file, name);
    const response = await this.#fetch(`https://api.telegram.org/bot${this.#botToken}/${method}`, { method: 'POST', body: form });
    const reply = (await response.json()) as { ok: boolean; description?: string; result?: { message_id: number } };
    if (!reply.ok || !reply.result) {
      throw new TelegramError(`Telegram refused the alert: ${reply.description ?? response.status}`);
    }
    return reply.result.message_id;
  }
}
