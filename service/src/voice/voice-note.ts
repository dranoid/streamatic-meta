import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const TRANSCRIBE_URL = 'https://api.meta.ai/v1/asr/transcribe';
const MODEL = 'muse-voice-transcribe-1.0';
const SAMPLE_RATE = 24_000;
// A rule is a sentence, and the API bills by the second, so a longer file is cut rather than paid for.
const MAX_SECONDS = 60;
const MAX_BYTES = 8_000_000;
const CONVERT_TIMEOUT_MS = 30_000;
// An upload is someone else's file: left to guess, ffmpeg would follow a playlist or a concat list to other files on this server.
const AUDIO_FORMATS = 'matroska,webm,ogg,mov,mp4,m4a,mp3,wav,aac,flac';

// Null when the bytes are not a recording ffmpeg can read.
export async function toWav(audio: Uint8Array): Promise<Uint8Array | null> {
  const folder = await mkdtemp(join(tmpdir(), 'voice-note-'));
  const from = join(folder, 'note');
  const to = join(folder, 'note.wav');
  try {
    await writeFile(from, audio);
    await run(
      'ffmpeg',
      ['-v', 'error', '-format_whitelist', AUDIO_FORMATS, '-protocol_whitelist', 'file', '-i', from, '-vn', '-t', String(MAX_SECONDS), '-ac', '1', '-ar', String(SAMPLE_RATE), '-sample_fmt', 's16', '-f', 'wav', '-bitexact', to],
      { timeout: CONVERT_TIMEOUT_MS },
    );
    return new Uint8Array(await readFile(to));
  } catch {
    return null;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

export interface Transcriber {
  transcribe(wav: Uint8Array, keywords: string[]): Promise<string>;
}

export class VoiceClient implements Transcriber {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: { apiKey: string; fetch?: typeof fetch }) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
  }

  async transcribe(wav: Uint8Array, keywords: string[]): Promise<string> {
    const form = new FormData();
    const request = { model: MODEL, mode: 'PUSH_TO_TALK', audioEncoding: 'WAV', languageBias: ['English'], ...(keywords.length > 0 ? { keywords } : {}) };
    form.append('request', new Blob([JSON.stringify(request)], { type: 'application/json' }));
    form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'note.wav');
    const reply = await this.#fetch(TRANSCRIBE_URL, { method: 'POST', headers: { Authorization: `Bearer ${this.#apiKey}` }, body: form });
    if (!reply.ok) throw new Error(`Voice transcription failed with status ${reply.status}.`);
    const { transcript } = (await reply.json()) as { transcript?: string };
    return transcript ?? '';
  }
}

// What setup outlined on the camera: the words a person is likely to say, some of which the model would otherwise mishear.
export function voiceKeywords(zones: Array<{ word: string; name: string }>): string[] {
  return [...new Set(zones.flatMap((z) => [z.word, z.name]))].sort();
}

export type VoiceNoteReply = { status: number; body: { text: string } | { error: string } };

export class VoiceNotes {
  constructor(private readonly transcriber: Transcriber) {}

  // Reads a posted recording; beforeAsking charges for it, once it is known to be a recording, and may throw to refuse.
  async read(request: IncomingMessage, keywords: string[], beforeAsking?: () => Promise<void>): Promise<VoiceNoteReply> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BYTES) return { status: 413, body: { error: 'That voice note is too large. Please choose one under 8 MB.' } };
      chunks.push(chunk);
    }
    const wav = await toWav(Buffer.concat(chunks));
    if (!wav) return { status: 400, body: { error: 'That file could not be read as a voice note. Please record again or choose an audio file.' } };
    await beforeAsking?.();
    const text = (await this.transcriber.transcribe(wav, keywords)).trim();
    if (!text) return { status: 422, body: { error: 'No speech was heard in that voice note. Please record it again.' } };
    return { status: 200, body: { text } };
  }
}
