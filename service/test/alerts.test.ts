import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { drawOutlines } from '../src/alerts/draw.js';
import { TelegramSender } from '../src/alerts/telegram.js';

async function greyPicture(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 } } }).jpeg().toBuffer(),
  );
}

async function pixel(jpeg: Uint8Array, x: number, y: number) {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]!, width: info.width, height: info.height };
}

describe('drawOutlines', () => {
  it('fills the outline in its colour and leaves the rest of the picture alone', async () => {
    const drawn = await drawOutlines(await greyPicture(200, 100), [{ path: 'M20 20L80 20L80 80L20 80Z', colour: '#ff0000' }]);

    const inside = await pixel(drawn, 50, 50);
    const outside = await pixel(drawn, 150, 50);
    expect(inside.width).toBe(200);
    expect(inside.r - inside.g).toBeGreaterThan(40);
    expect(Math.abs(outside.r - outside.g)).toBeLessThan(10);
  });
});

describe('TelegramSender', () => {
  it('sends a picture with its caption to the chat', async () => {
    let url = '';
    let form: FormData | undefined;
    const sender = new TelegramSender({
      botToken: 'TOKEN',
      chatId: '42',
      fetch: async (u, init) => {
        url = String(u);
        form = init?.body as FormData;
        return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
      },
    });

    const id = await sender.sendPicture(Uint8Array.of(1, 2, 3), 'Front door opened');

    expect(id).toBe(7);
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendPhoto');
    expect(form?.get('chat_id')).toBe('42');
    expect(form?.get('caption')).toBe('Front door opened');
    expect(form?.get('photo')).toBeInstanceOf(Blob);
  });

  it('sends several pictures as one album, captioned on the first', async () => {
    let url = '';
    let form: FormData | undefined;
    const sender = new TelegramSender({
      botToken: 'TOKEN',
      chatId: '42',
      fetch: async (u, init) => {
        url = String(u);
        form = init?.body as FormData;
        return new Response(JSON.stringify({ ok: true, result: [{ message_id: 11 }, { message_id: 12 }] }));
      },
    });

    const id = await sender.sendPictures([Uint8Array.of(1), Uint8Array.of(2)], 'Front door opened');

    expect(id).toBe(11);
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMediaGroup');
    expect(JSON.parse(String(form?.get('media')))).toEqual([
      { type: 'photo', media: 'attach://picture0', caption: 'Front door opened' },
      { type: 'photo', media: 'attach://picture1' },
    ]);
    expect(form?.get('picture1')).toBeInstanceOf(Blob);
  });

  it('sends a clip as a video', async () => {
    let url = '';
    const sender = new TelegramSender({
      botToken: 'TOKEN',
      chatId: '42',
      fetch: async (u) => ((url = String(u)), new Response(JSON.stringify({ ok: true, result: { message_id: 8 } }))),
    });

    await sender.sendClip(Uint8Array.of(1), 'Front door opened');

    expect(url).toBe('https://api.telegram.org/botTOKEN/sendVideo');
  });

  it('fails with what Telegram said when the send is refused', async () => {
    const sender = new TelegramSender({
      botToken: 'TOKEN',
      chatId: '42',
      fetch: async () => new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 }),
    });

    await expect(sender.sendPicture(Uint8Array.of(1), 'x')).rejects.toThrow(/chat not found/);
  });
});
