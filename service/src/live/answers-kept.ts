import type { BoxJudge } from '../rules/zone-rule.js';
import type { Picture } from '../sam/client.js';
import type { Box } from '../sam/outlines.js';
import type { Outliner } from '../setup/camera-setup.js';

// A recording's pictures are the same objects on every pass, so each model answer about them is kept and reused;
// without this, a loop running for days repeats the same paid calls hundreds of times. A failed call is not kept.
export function keepAnswers({ sam, judge, crop }: { sam: Outliner; judge: BoxJudge; crop: (picture: Picture, box: Box) => Promise<Picture> }) {
  const ids = new WeakMap<Uint8Array, number>();
  let nextId = 0;
  const idOf = (bytes: Uint8Array) => ids.get(bytes) ?? ids.set(bytes, nextId++).get(bytes)!;
  const outlines = new Map<string, ReturnType<Outliner['outlineAll']>>();
  const crops = new Map<string, Promise<Picture>>();
  const answers = new Map<string, ReturnType<BoxJudge['judge']>>();

  return {
    sam: { outlineAll: (picture: Picture, words: string[]) => remember(outlines, `${idOf(picture.bytes)}\n${words.join('\n')}`, () => sam.outlineAll(picture, words)) },
    crop: (picture: Picture, box: Box) => remember(crops, `${idOf(picture.bytes)}\n${JSON.stringify(box)}`, () => crop(picture, box)),
    judge: {
      judge: (question: string, pictures: Parameters<BoxJudge['judge']>[1]) =>
        remember(answers, `${question}\n${pictures.map((p) => idOf(p.picture.bytes)).join(',')}`, () => judge.judge(question, pictures)),
    },
  };
}

function remember<T>(kept: Map<string, Promise<T>>, key: string, ask: () => Promise<T>): Promise<T> {
  if (!kept.has(key)) {
    const answer = ask();
    kept.set(key, answer);
    answer.catch(() => kept.delete(key));
  }
  return kept.get(key)!;
}
