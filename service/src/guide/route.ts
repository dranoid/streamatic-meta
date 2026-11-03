import type { Camera } from '../cameras/camera-folder.js';
import type { CameraZone } from '../cameras/camera-zones.js';

export interface ElsewhereCamera {
  camera: string;
  name: string;
  zones: string[];
}

const words = (text: string) => new Set(text.toLowerCase().replace(/['’]s\b/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean));

// A zone is asked for when all the words of its name are there, or of either word setup knew it by.
function askedFor(zones: CameraZone[], asked: Set<string>): CameraZone[] {
  const said = (name: string) => [...words(name)].every((w) => asked.has(w));
  return zones.filter((z) => said(z.name) || said(z.word) || said(z.item));
}

// The cameras at this one's place that outlined more of what the person asked about than it did, the most first.
// This is code over the zones setup found, so a plan from the model cannot send anyone to a camera that never outlined the thing.
export function camerasThatOutlined(sentence: string, here: Camera, cameras: Camera[]): ElsewhereCamera[] {
  if (here.group === null) return [];
  const asked = words(sentence);
  const found = askedFor(here.zones, asked).length;
  return cameras
    .filter((c) => c.id !== here.id && c.group === here.group)
    .map((c) => ({ camera: c.id, name: c.name, zones: askedFor(c.zones, asked).map((z) => z.name) }))
    .filter((c) => c.zones.length > found)
    .sort((a, b) => b.zones.length - a.zones.length);
}
