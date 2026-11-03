import type { MediaSize } from '../sam/client.js';
import type { Box } from '../sam/outlines.js';

// A backend rule watches the whole picture, so a zone's place goes in the sentence, written from SAM's box.
export function placeInPicture(box: Box, size: MediaSize): string {
  const across = (box.left + box.right) / 2 / size.width;
  if (across < 1 / 3) return 'on the left side of the picture';
  if (across > 2 / 3) return 'on the right side of the picture';
  return 'in the middle of the picture';
}

export function sentenceWithPlaces(sentence: string, zones: Array<{ name: string; box: Box }>, size: MediaSize): string {
  const trimmed = sentence.trim();
  const ended = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  const places = zones.map(({ name, box }) => `The ${name} is ${placeInPicture(box, size)}.`);
  return [ended, ...places].join(' ');
}
