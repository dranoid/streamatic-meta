import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { sendZoneAlert } from '../src/alerts/send-alert.js';
import type { Frame, ZoneAlert } from '../src/rules/zone-rule.js';

async function frame(at: number): Promise<Frame> {
  const bytes = new Uint8Array(
    await sharp({ create: { width: 100, height: 60, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer(),
  );
  return { at, width: 100, height: 60, picture: { bytes, mimeType: 'image/jpeg' }, gray: { width: 1, height: 1, data: new Uint8Array(1) } };
}

function fakeSender() {
  const sent: Array<{ kind: 'picture' | 'clip' | 'pictures'; bytes: Uint8Array | Uint8Array[]; caption: string }> = [];
  return {
    sent,
    sendPicture: async (bytes: Uint8Array, caption: string) => (sent.push({ kind: 'picture', bytes, caption }), 1),
    sendPictures: async (bytes: Uint8Array[], caption: string) => (sent.push({ kind: 'pictures', bytes, caption }), 3),
    sendClip: async (bytes: Uint8Array, caption: string) => (sent.push({ kind: 'clip', bytes, caption }), 2),
  };
}

async function doorAlert(): Promise<ZoneAlert> {
  return {
    rule: 'Alert me if the front door opens after 9 pm.',
    zone: 'front door',
    at: at2124,
    picture: await frame(at2124),
    outline: { word: 'door', objectId: '0', box: { left: 10, top: 10, right: 40, bottom: 50 }, path: 'M10 10L40 10L40 50L10 50Z' },
    clip: [],
    judged: [],
  };
}

const noClip = async () => new Uint8Array();

const at2124 = Date.UTC(2026, 9, 28, 20, 24, 15);

describe('sendZoneAlert', () => {
  it('sends the alert picture with the outline drawn and a caption naming the zone, camera, time and rule', async () => {
    const picture = await frame(at2124);
    const alert: ZoneAlert = {
      rule: 'Alert me if the front door opens after 9 pm.',
      zone: 'front door',
      at: at2124,
      picture,
      outline: { word: 'door', objectId: '0', box: { left: 10, top: 10, right: 40, bottom: 50 }, path: 'M10 10L40 10L40 50L10 50Z' },
      clip: [],
      judged: [],
    };
    const sender = fakeSender();

    await sendZoneAlert({ alert, sender, camera: 'Table parlour', timeZone: 'Africa/Lagos', makeClip: async () => new Uint8Array() });

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.kind).toBe('picture');
    expect(sender.sent[0]!.bytes).not.toEqual(picture.picture.bytes);
    expect(sender.sent[0]!.caption).toBe(
      'Streamatic alert: front door\nCamera: Table parlour\nTime: 21:24:15, 28 October 2026\nRule: Alert me if the front door opens after 9 pm.',
    );
  });

  it('sends the plain picture when the person chose the normal view', async () => {
    const alert = await doorAlert();
    const sender = fakeSender();

    await sendZoneAlert({ alert, sender, camera: 'Table parlour', timeZone: 'Africa/Lagos', makeClip: noClip, view: 'plain' });

    expect(sender.sent.map((s) => [s.kind, s.bytes])).toEqual([['picture', alert.picture!.picture.bytes]]);
  });

  it('sends the outlined and the plain picture together when the person chose both', async () => {
    const alert = await doorAlert();
    const sender = fakeSender();

    await sendZoneAlert({ alert, sender, camera: 'Table parlour', timeZone: 'Africa/Lagos', makeClip: noClip, view: 'both' });

    expect(sender.sent).toHaveLength(1);
    const [outlined, plain] = sender.sent[0]!.bytes as Uint8Array[];
    expect(sender.sent[0]!.kind).toBe('pictures');
    expect(outlined).not.toEqual(alert.picture!.picture.bytes);
    expect(plain).toEqual(alert.picture!.picture.bytes);
  });

  it('sends the moment as a clip when the alert has no single picture', async () => {
    const clip = [await frame(at2124), await frame(at2124 + 1000)];
    const alert: ZoneAlert = { rule: 'Alert me if anyone is behind the counter.', zone: 'counter', at: at2124, picture: null, outline: null, clip, judged: [] };
    const sender = fakeSender();
    let clipped = 0;

    await sendZoneAlert({
      alert,
      sender,
      camera: 'Shop',
      timeZone: 'Africa/Lagos',
      makeClip: async (jpegs) => ((clipped = jpegs.length), Uint8Array.of(9)),
    });

    expect(clipped).toBe(2);
    expect(sender.sent.map((s) => [s.kind, s.bytes])).toEqual([['clip', Uint8Array.of(9)]]);
  });
});
