import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { LabelledPicture, CameraSetup } from '../setup/camera-setup.js';
import { cameraZones, type CameraZone, type ZoneName } from './camera-zones.js';

export interface Camera {
  id: string;
  name: string;
  // A short description of the site, given to Spark so its rules fit it.
  site: string;
  baseWords: string[];
  // Picture file per label, in the order setup shows them: day, dusk, night.
  pictures: Record<string, string>;
  setup: CameraSetup | null;
  // Setup's outlines as the things they are, each under the name people use for it; empty before setup.
  zones: CameraZone[];
  // The folder of a recording the app plays on a loop as this camera's pictures; null for a camera with only its setup pictures.
  episode: string | null;
  // The camera in Streamatic's backend, with the hours of stored pictures a rule may be tried on; alerts outside them are not copied.
  backend: { deviceId: string; recorded: { from: string; to: string } | null } | null;
  // Cameras at one place share this, so the guide can offer another of them; null for a camera on its own.
  group: string | null;
  // Sentences run through the page three times that raised a real alert each time, offered ahead of setup's own suggestions.
  tested: string[];
}

// One folder per camera under <root>/cameras: camera.json, its pictures, setup.json once setup has run, zone-names.json,
// and episode/ when it has a recording to play.
export class CameraFolder {
  constructor(private readonly root: string) {}

  async list(): Promise<Camera[]> {
    const ids = await readdir(join(this.root, 'cameras')).catch(() => [] as string[]);
    const cameras = await Promise.all(ids.sort().map((id) => this.get(id)));
    return cameras.filter((c): c is Camera => c !== null);
  }

  async get(id: string): Promise<Camera | null> {
    if (basename(id) !== id || id.startsWith('.')) return null;
    const dir = join(this.root, 'cameras', id);
    const config = await readFile(join(dir, 'camera.json'), 'utf8').catch(() => null);
    if (config === null) return null;
    const saved = await readFile(join(dir, 'setup.json'), 'utf8').catch(() => null);
    const { name, site, baseWords, pictures, backend = null, group = null, tested = [] } = JSON.parse(config) as Pick<Camera, 'name' | 'site' | 'baseWords' | 'pictures'> & { backend?: Camera['backend']; group?: string; tested?: string[] };
    const folder = async (name: string) => ((await stat(join(dir, name)).catch(() => null))?.isDirectory() ? join(dir, name) : null);
    const episode = await folder('episode');
    const setup = saved === null ? null : (JSON.parse(saved) as CameraSetup);
    return { id, name, site, baseWords, pictures, setup, zones: setup ? cameraZones(setup, await this.zoneNames(id)) : [], episode, backend, group, tested };
  }

  async zoneNames(id: string): Promise<ZoneName[]> {
    const names = await readFile(join(this.root, 'cameras', id, 'zone-names.json'), 'utf8').catch(() => null);
    return names === null ? [] : (JSON.parse(names) as ZoneName[]);
  }

  async saveZoneNames(id: string, names: ZoneName[]): Promise<void> {
    await writeFile(join(this.root, 'cameras', id, 'zone-names.json'), JSON.stringify(names));
  }

  async picture(id: string, file: string): Promise<Uint8Array | null> {
    if (basename(file) !== file || (await this.get(id)) === null) return null;
    return readFile(join(this.root, 'cameras', id, file)).catch(() => null);
  }

  async labelledPictures(camera: Camera): Promise<LabelledPicture[]> {
    return Promise.all(
      Object.entries(camera.pictures).map(async ([label, file]) => ({
        label,
        picture: { bytes: await readFile(join(this.root, 'cameras', camera.id, file)), mimeType: 'image/jpeg' as const },
      })),
    );
  }

  async saveSetup(id: string, setup: CameraSetup): Promise<void> {
    await writeFile(join(this.root, 'cameras', id, 'setup.json'), JSON.stringify(setup));
  }
}
