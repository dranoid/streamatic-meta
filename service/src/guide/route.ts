import type { Camera } from '../cameras/camera-folder.js';
import type { CameraZone } from '../cameras/camera-zones.js';

export interface ElsewhereCamera {
  camera: string;
  name: string;
  zones: string[];
  // How many of the sentence's words those zones account for: six benches answer a sentence about a bench no better than one, and "front door" answers better than "door".
  matched: number;
}

const words =(text: string) => new Set(text.toLowerCase().replace(/['’]s\b/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean));

// A zone is asked for when all the words of its name are there, or of either word setup knew it by.
function askedFor(zones: CameraZone[], asked: Set<string>): CameraZone[] {
  const said = (name: string) => [...words(name)].every((w) => asked.has(w));
  return zones.filter((z) => said(z.name) || said(z.word) || said(z.item));
}

// A number only tells zones of one word apart ("bench 1"), so it says nothing about what was asked.
const wordsMatched = (zones: CameraZone[], asked: Set<string>) =>
  new Set(zones.flatMap((z) => [z.name, z.word, z.item].flatMap((text) => [...words(text)])).filter((w) => asked.has(w) && !/^\d+$/.test(w))).size;

function found(camera: Camera, asked: Set<string>): ElsewhereCamera {
  const zones = askedFor(camera.zones, asked);
  return { camera: camera.id, name: camera.name, zones: zones.map((z) => z.name), matched: wordsMatched(zones, asked) };
}

// With no camera chosen: every camera that outlined anything asked about, the most first. Code again, so the model cannot pick a camera.
export function camerasForSentence(sentence: string, cameras: Camera[]): ElsewhereCamera[] {
  const asked = words(sentence);
  return cameras
    .map((c) => found(c, asked))
    .filter((c) => c.zones.length > 0)
    .sort((a, b) => b.matched - a.matched);
}

// The cameras at this one's place that outlined more of what the person asked about than it did, the most first.
// This is code over the zones setup found, so a plan from the model cannot send anyone to a camera that never outlined the thing.
export function camerasThatOutlined(sentence: string, here: Camera, cameras: Camera[]): ElsewhereCamera[] {
  if (here.group === null) return [];
  const asked = words(sentence);
  const matchedHere = wordsMatched(askedFor(here.zones, asked), asked);
  return cameras
    .filter((c) => c.id !== here.id && c.group === here.group)
    .map((c) => found(c, asked))
    .filter((c) => c.matched > matchedHere)
    .sort((a, b) => b.matched - a.matched);
}
