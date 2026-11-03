import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { VoiceClient, VoiceNotes, toWav, voiceKeywords } from '../src/voice/voice-note.js';

const run = promisify(execFile);

// A real recording, as a browser or a phone would send it: a tone in a compressed container.
async function recording(seconds: number, extension = 'ogg'): Promise<Uint8Array> {
  const folder = await mkdtemp(join(tmpdir(), 'voice-'));
  const file = join(folder, `note.${extension}`);
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=300:duration=${seconds}`, '-ac', '2', file]);
  return new Uint8Array(await readFile(file));
}

const wavSeconds = (wav: Uint8Array) => (wav.length - 44) / (24_000 * 2);
const posted = (bytes: Uint8Array) => Readable.from([Buffer.from(bytes)]) as unknown as IncomingMessage;

describe('toWav', () => {
  it('turns a recording into the mono 24 kHz 16-bit WAV the transcriber takes', async () => {
    const wav = (await toWav(await recording(1)))!;
    const view = new DataView(wav.buffer, wav.byteOffset);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16);
  });

  it('keeps only the first minute of a long recording, so a long file cannot run up the bill', async () => {
    const wav = (await toWav(await recording(70)))!;
    expect(wavSeconds(wav)).toBeGreaterThan(59);
    expect(wavSeconds(wav)).toBeLessThan(61);
  });

  it('reads nothing but audio: a playlist pointing at a file on this server is refused', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'voice-'));
    const secret = join(folder, 'tone.wav');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1', secret]);
    const playlist = `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1.0,\nfile://${secret}\n#EXT-X-ENDLIST\n`;
    expect(await toWav(new TextEncoder().encode(playlist))).toBeNull();
    const concat = `ffconcat version 1.0\nfile '${secret}'\n`;
    expect(await toWav(new TextEncoder().encode(concat))).toBeNull();
  });

  it('reads only the containers a voice note comes in', async () => {
    expect(await toWav(await recording(1, 'avi'))).toBeNull();
  });

  it('reads what browsers and phones record', async () => {
    for (const extension of ['ogg', 'webm', 'm4a', 'mp3', 'wav']) {
      expect(await toWav(await recording(1, extension)), extension).not.toBeNull();
    }
  });

  it('answers null for something that is not audio', async () => {
    expect(await toWav(new TextEncoder().encode('hello'))).toBeNull();
  });
});

describe('VoiceClient', () => {
  it('posts the WAV with the model, the recording mode and the words to listen for', async () => {
    let sent: { url: string; auth: string | null; request: Record<string, unknown>; audio: File } | null = null;
    const client = new VoiceClient({
      apiKey: 'key',
      fetch: (async (url: string, init: RequestInit) => {
        const form = init.body as FormData;
        sent = {
          url,
          auth: new Headers(init.headers).get('authorization'),
          request: JSON.parse(await (form.get('request') as Blob).text()) as Record<string, unknown>,
          audio: form.get('audio') as File,
        };
        return new Response(JSON.stringify({ sessionId: 's', transcript: ' Tell me if the gate is open. ', audioDurationMs: 2000, turns: [] }));
      }) as unknown as typeof fetch,
    });
    const text = await client.transcribe(new Uint8Array([1, 2, 3]), ['gate', 'keke']);
    expect(text.trim()).toBe('Tell me if the gate is open.');
    expect(sent!.url).toBe('https://api.meta.ai/v1/asr/transcribe');
    expect(sent!.auth).toBe('Bearer key');
    expect(sent!.request).toMatchObject({ model: 'muse-voice-transcribe-1.0', mode: 'PUSH_TO_TALK', audioEncoding: 'WAV', keywords: ['gate', 'keke'] });
    expect(new Uint8Array(await sent!.audio.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('sends no keywords when it has none, since the API refuses an empty list', async () => {
    let request: Record<string, unknown> = {};
    const client = new VoiceClient({
      apiKey: 'key',
      fetch: (async (_url: string, init: RequestInit) => {
        request = JSON.parse(await ((init.body as FormData).get('request') as Blob).text()) as Record<string, unknown>;
        return new Response(JSON.stringify({ transcript: 'hello' }));
      }) as unknown as typeof fetch,
    });
    await client.transcribe(new Uint8Array([1]), []);
    expect(request).not.toHaveProperty('keywords');
  });

  it('fails loudly when the API refuses, without passing its words to the person', async () => {
    const client = new VoiceClient({ apiKey: 'key', fetch: (async () => new Response('{"error":"bad"}', { status: 400 })) as unknown as typeof fetch });
    await expect(client.transcribe(new Uint8Array([1]), [])).rejects.toThrow(/400/);
  });
});

describe('voiceKeywords', () => {
  it('listens for each thing setup outlined, once', () => {
    expect(voiceKeywords([{ word: 'door', name: 'door 1' }, { word: 'door', name: 'front door' }, { word: 'gate', name: 'gate' }])).toEqual(['door', 'door 1', 'front door', 'gate']);
  });
});

describe('VoiceNotes', () => {
  const transcriber = (text: string) => {
    const calls: Array<{ wav: Uint8Array; keywords: string[] }> = [];
    return { calls, transcribe: async (wav: Uint8Array, keywords: string[]) => (calls.push({ wav, keywords }), text) };
  };

  it('answers with what was said, for the words the camera has', async () => {
    const fake = transcriber('Tell me if the gate is open.');
    const reply = await new VoiceNotes(fake).read(posted(await recording(1)), ['gate']);
    expect(reply).toEqual({ status: 200, body: { text: 'Tell me if the gate is open.' } });
    expect(fake.calls[0]!.keywords).toEqual(['gate']);
  });

  it('refuses what is not a recording, and neither charges nor asks', async () => {
    const fake = transcriber('never');
    let charged = 0;
    const reply = await new VoiceNotes(fake).read(posted(new TextEncoder().encode('hello')), [], async () => void charged++);
    expect(reply.status).toBe(400);
    expect(charged).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it('refuses a file over the limit before reading it', async () => {
    const fake = transcriber('never');
    const reply = await new VoiceNotes(fake).read(posted(new Uint8Array(8_000_001)), []);
    expect(reply.status).toBe(413);
    expect(fake.calls).toEqual([]);
  });

  it('charges before asking, so a refused charge asks nothing', async () => {
    const fake = transcriber('never');
    await expect(new VoiceNotes(fake).read(posted(await recording(1)), [], async () => { throw new Error('Limit reached'); })).rejects.toThrow('Limit reached');
    expect(fake.calls).toEqual([]);
  });

  it('says so when nothing was heard', async () => {
    const reply = await new VoiceNotes(transcriber('  ')).read(posted(await recording(1)), []);
    expect(reply.status).toBe(422);
  });
});
