import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeClip } from '../alerts/clip.js';
import { CLIP_PICTURES_PER_SECOND } from '../alerts/send-alert.js';
import type { Frame, ZoneAlert } from '../rules/zone-rule.js';
import type { EventStore } from './store.js';

// Keeps an alert as an event: its picture (or clip) and the pictures around it for the clip player, with SAM's outlines.
export async function keepAlert({
  alert,
  around,
  camera,
  reference,
  store,
  mediaDir,
}: {
  alert: ZoneAlert;
  around: Frame[];
  camera: string;
  reference: string;
  store: EventStore;
  mediaDir: string;
}): Promise<number> {
  const picture = alert.picture ? `${alert.at}.jpg` : null;
  const clip = alert.picture ? null : `${alert.at}.mp4`;
  if (alert.picture) await writeFile(join(mediaDir, picture!), alert.picture.picture.bytes);
  else await writeFile(join(mediaDir, clip!), await makeClip(alert.clip.map((f) => f.picture.bytes), CLIP_PICTURES_PER_SECOND));
  const paths = (outlines: ZoneAlert['outlines']) => outlines.map((o) => o.path).join(' ') || null;
  // An event is filed under the rule's first zone, so a question about that zone counts it.
  const eventId = store.add({ camera, zone: alert.zones[0]!, rule: alert.rule, at: alert.at, picture, clip, outline: paths(alert.outlines), reference });
  for (const f of around) await writeFile(join(mediaDir, `${alert.at}_${f.at}.jpg`), f.picture.bytes);
  store.addFrames(
    eventId,
    around.map((f) => ({ at: f.at, file: `${alert.at}_${f.at}.jpg`, outline: paths(alert.judged.find((j) => j.at === f.at)?.outlines ?? []) })),
  );
  return eventId;
}
