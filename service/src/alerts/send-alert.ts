import type { ZoneAlert } from '../rules/zone-rule.js';
import { drawOutlines, type DrawnOutline } from './draw.js';

export interface AlertSender {
  sendPicture(jpeg: Uint8Array, caption: string): Promise<number>;
  sendPictures(jpegs: Uint8Array[], caption: string): Promise<number>;
  sendClip(mp4: Uint8Array, caption: string): Promise<number>;
}

// What the person chose to receive: the picture with the zone's outlines, the picture as the camera took it, or both.
export type AlertView = 'outlined' | 'plain' | 'both';

const OUTLINE_COLOUR = '#ff3b30';
const REFERENCE_COLOUR = '#ffffff';
export const CLIP_PICTURES_PER_SECOND = 2;

export async function sendZoneAlert({
  alert,
  sender,
  camera,
  timeZone,
  makeClip,
  reference,
  view = 'outlined',
}: {
  alert: ZoneAlert;
  sender: AlertSender;
  camera: string;
  timeZone: string;
  makeClip: (jpegs: Uint8Array[], picturesPerSecond: number) => Promise<Uint8Array>;
  // The zone's outline at setup, drawn dashed so the change against it is visible.
  reference?: string;
  view?: AlertView;
}): Promise<number> {
  const caption = alertCaption(alert, camera, timeZone);
  if (!alert.picture) {
    return sender.sendClip(await makeClip(alert.clip.map((f) => f.picture.bytes), CLIP_PICTURES_PER_SECOND), caption);
  }
  const plain = alert.picture.picture.bytes;
  if (view === 'plain') return sender.sendPicture(plain, caption);
  const outlines: DrawnOutline[] = [
    ...(reference ? [{ path: reference, colour: REFERENCE_COLOUR, dashed: true }] : []),
    ...(alert.outline ? [{ path: alert.outline.path, colour: OUTLINE_COLOUR }] : []),
  ];
  const outlined = await drawOutlines(plain, outlines);
  return view === 'both' ? sender.sendPictures([outlined, plain], caption) : sender.sendPicture(outlined, caption);
}

export function alertCaption(alert: ZoneAlert, camera: string, timeZone: string): string {
  return [
    `Streamatic alert: ${alert.zone}`,
    `Camera: ${camera}`,
    `Time: ${formatTime(alert.at, timeZone)}`,
    `Rule: ${alert.rule}`,
  ].join('\n');
}

function formatTime(at: number, timeZone: string): string {
  const time = new Date(at).toLocaleTimeString('en-GB', { timeZone, hour12: false });
  const date = new Date(at).toLocaleDateString('en-GB', { timeZone, day: 'numeric', month: 'long', year: 'numeric' });
  return `${time}, ${date}`;
}
