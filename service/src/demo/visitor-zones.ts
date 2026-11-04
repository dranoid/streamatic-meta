import type { Camera } from '../cameras/camera-folder.js';
import { cameraZones } from '../cameras/camera-zones.js';
import type { DemoStore, ZoneEdit } from './store.js';

// The page is shared, so a rename or a delete changes the camera only as this visitor sees it.
export function withZoneEdits(camera: Camera, edits: ZoneEdit[]): Camera {
  if (edits.length === 0) return camera;
  const edited = new Map(edits.map((e) => [e.zone, e.name]));
  return {
    ...camera,
    zones: camera.zones.flatMap((zone) => {
      if (!edited.has(zone.name)) return [zone];
      const name = edited.get(zone.name)!;
      return name === null ? [] : [{ ...zone, name }];
    }),
  };
}

// The camera with what setup found when this visitor ran it, if they have, and their changes to that.
export function asVisitorSees(camera: Camera, store: Pick<DemoStore, 'liveSetup' | 'zoneEdits'>, visitor: string): Camera {
  const live = store.liveSetup(visitor, camera.id);
  return withZoneEdits(live ? { ...camera, setup: live, zones: cameraZones(live, []) } : camera, store.zoneEdits(visitor, camera.id));
}

// The name setup gave a zone now shown under this one.
export const nameFromSetup = (shown: string, edits: ZoneEdit[]) => edits.find((e) => e.name === shown)?.zone ?? shown;
