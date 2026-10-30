import { describe, expect, it } from 'vitest';
import { keepAnswers } from '../src/live/answers-kept.js';
import type { Picture } from '../src/sam/client.js';

const picture = (text: string): Picture => ({ bytes: new TextEncoder().encode(text), mimeType: 'image/jpeg' });

describe('keepAnswers', () => {
  it('asks SAM once per picture and words, and Spark once per question and pictures, across passes of a recording', async () => {
    const asked: string[] = [];
    const sam = { outlineAll: async (_p: Picture, words: string[]) => (asked.push(`sam ${words.join(',')}`), {}) };
    const judge = { judge: async (question: string) => (asked.push(`spark ${question}`), { answer: true, shownIn: 1 }) };
    const kept = keepAnswers({ sam, judge, crop: async (p) => ({ ...p, bytes: p.bytes.slice() }) });
    const door = picture('door at 21:24:06');
    const box = { left: 0, top: 0, right: 1, bottom: 1 };

    for (let pass = 0; pass < 2; pass++) {
      await kept.sam.outlineAll(door, ['door']);
      await kept.judge.judge('Is the door open?', [{ label: 'picture 1', picture: await kept.crop(door, box) }]);
    }
    await kept.sam.outlineAll(door, ['door', 'ceiling light']);

    expect(asked).toEqual(['sam door', 'spark Is the door open?', 'sam door,ceiling light']);
  });

  it('asks again on the next pass when a call failed', async () => {
    let calls = 0;
    const sam = { outlineAll: async () => (++calls === 1 ? Promise.reject(new Error('busy')) : {}) };
    const kept = keepAnswers({ sam, judge: { judge: async () => ({ answer: null, shownIn: null }) }, crop: async (p) => p });
    const door = picture('door');

    await expect(kept.sam.outlineAll(door, ['door'])).rejects.toThrow('busy');
    await kept.sam.outlineAll(door, ['door']);
    await kept.sam.outlineAll(door, ['door']);

    expect(calls).toBe(2);
  });
});
