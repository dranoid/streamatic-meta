import { describe, expect, it } from 'vitest';
import { recordSecondOpinion } from '../src/alerts/second-opinion.js';
import { TelegramSender } from '../src/alerts/telegram.js';
import { SparkClient } from '../src/spark/client.js';
import { SparkSecondOpinion } from '../src/spark/second-opinion.js';

const before = { bytes: Uint8Array.of(0xff, 0xd8, 0xff), mimeType: 'image/jpeg' as const };
const now = { bytes: Uint8Array.of(0xff, 0xd8, 0xfe), mimeType: 'image/jpeg' as const };

function captions() {
  const edits: Array<{ messageId: number; caption: string }> = [];
  return { edits, editCaption: async (messageId: number, caption: string) => void edits.push({ messageId, caption }) };
}

describe('recordSecondOpinion', () => {
  const caption = 'Streamatic alert: front door\nRule: Alert me if the front door opens after 9 pm.';

  it('adds the confirmation and its reason to the alert already sent', async () => {
    const sender = captions();
    const judge = { judge: async () => ({ confirmed: true, reason: 'The door stands open with a person in the doorway.' }) };

    const opinion = await recordSecondOpinion({ judge, sender, messageId: 7, caption, rule: 'Alert me if the front door opens after 9 pm.', zone: 'front door', zoneOutline: 'M1 1Z', before, now });

    expect(opinion.confirmed).toBe(true);
    expect(sender.edits).toEqual([
      {
        messageId: 7,
        caption: `${caption}\nSecond opinion (Muse Spark Open): confirmed. The door stands open with a person in the doorway.`,
      },
    ]);
  });

  it('marks the alert unconfirmed when the second model disagrees', async () => {
    const sender = captions();
    const judge = { judge: async () => ({ confirmed: false, reason: 'The door is closed.' }) };

    await recordSecondOpinion({ judge, sender, messageId: 7, caption, rule: 'r', zone: 'front door', zoneOutline: 'M1 1Z', before, now });

    expect(sender.edits[0]!.caption).toMatch(/Second opinion \(Muse Spark Open\): unconfirmed\. The door is closed\.$/);
  });

  it('says so when the second model could not judge', async () => {
    const sender = captions();
    const judge = { judge: async () => ({ confirmed: null, reason: '' }) };

    await recordSecondOpinion({ judge, sender, messageId: 7, caption, rule: 'r', zone: 'front door', zoneOutline: 'M1 1Z', before, now });

    expect(sender.edits[0]!.caption).toMatch(/Second opinion \(Muse Spark Open\): could not judge from the pictures\.$/);
  });
});

describe('SparkSecondOpinion', () => {
  function judgeWith(content: string) {
    let body: any;
    const marked: Array<{ bytes: number[]; path: string }> = [];
    const spark = new SparkClient({
      apiKey: 'test',
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
      },
    });
    // Stand-in for drawing: appends the path's length, so a marked picture differs from the plain one.
    const mark = async (jpeg: Uint8Array, path: string) => {
      marked.push({ bytes: [...jpeg], path });
      return Uint8Array.of(...jpeg, path.length);
    };
    return { judge: new SparkSecondOpinion(spark, mark), body: () => body, marked };
  }

  it('shows Spark Open the zone at setup and now, with the rule but no verdict', async () => {
    const { judge, body } = judgeWith('{"confirmed": true, "reason": "Open."}');

    const opinion = await judge.judge({ rule: 'Alert me if the front door opens after 9 pm.', zone: 'front door', zoneOutline: 'M1 1Z', before, now });

    const content = body().messages[0].content;
    expect(opinion).toEqual({ confirmed: true, reason: 'Open.' });
    expect(content[0].text).toContain('Alert me if the front door opens after 9 pm.');
    expect(content[0].text).not.toMatch(/alert (was|has been) (sent|raised|triggered)/i);
    expect(content.filter((c: any) => c.type === 'text').map((c: any) => c.text).slice(1)).toEqual(['Picture: at setup', 'Picture: now']);
  });

  it('marks where the zone is on both pictures and tells Spark Open what the mark means', async () => {
    const { judge, body, marked } = judgeWith('{"confirmed": true, "reason": "Open."}');

    await judge.judge({ rule: 'r', zone: 'front door', zoneOutline: 'M10 10L20 20Z', before, now });

    expect(marked).toEqual([
      { bytes: [...before.bytes], path: 'M10 10L20 20Z' },
      { bytes: [...now.bytes], path: 'M10 10L20 20Z' },
    ]);
    const content = body().messages[0].content;
    const sent = content.filter((c: any) => c.type === 'image_url').map((c: any) => c.image_url.url);
    expect(sent).toEqual([
      `data:image/jpeg;base64,${Buffer.from([...before.bytes, 13]).toString('base64')}`,
      `data:image/jpeg;base64,${Buffer.from([...now.bytes, 13]).toString('base64')}`,
    ]);
    expect(content[0].text).toMatch(/dashed white outline/);
  });
});

describe('TelegramSender.editCaption', () => {
  it('replaces the caption of a message already sent', async () => {
    let url = '';
    let body: any;
    const sender = new TelegramSender({
      botToken: 'TOKEN',
      chatId: '42',
      fetch: async (u, init) => {
        url = String(u);
        body = Object.fromEntries((init?.body as FormData).entries());
        return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
      },
    });

    await sender.editCaption(7, 'New caption');

    expect(url).toBe('https://api.telegram.org/botTOKEN/editMessageCaption');
    expect(body).toEqual({ chat_id: '42', message_id: '7', caption: 'New caption' });
  });
});
