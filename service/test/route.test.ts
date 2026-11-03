import { describe, expect, it } from 'vitest';
import type { Camera } from '../src/cameras/camera-folder.js';
import type { CameraZone } from '../src/cameras/camera-zones.js';
import { camerasThatOutlined } from '../src/guide/route.js';

const zone = (word: string, name = word, item = word): CameraZone => ({ word, name, item, outlines: { day: [{ word, objectId: '0', box: { left: 0, top: 0, right: 1, bottom: 1 }, path: 'M0 0Z' }] } });
const camera = (id: string, group: string | null, zones: CameraZone[]): Camera => ({ id, name: `${id} camera`, site: 's', baseWords: [], pictures: {}, setup: null, zones, episode: null, backend: null, group });

const here = camera('here', 'site', [zone('gate'), zone('wall')]);
const shops = camera('shops', 'site', [zone('shop'), zone('road')]);
const roads = camera('roads', 'site', [zone('road')]);
const elsewhere = camera('elsewhere', 'other', [zone('shop')]);

describe('camerasThatOutlined', () => {
  it('offers the camera where the thing was outlined, when this one did not', () => {
    expect(camerasThatOutlined('the shop', here, [here, shops, roads])).toEqual([{ camera: 'shops', name: 'shops camera', zones: ['shop'] }]);
  });

  it('offers nothing when this camera outlined it too', () => {
    expect(camerasThatOutlined('the gate', here, [here, camera('gates', 'site', [zone('gate')])])).toEqual([]);
  });

  it('offers nothing when no camera outlined it', () => {
    expect(camerasThatOutlined('the drain', here, [here, shops, roads])).toEqual([]);
  });

  it('never offers a camera outside this one’s group', () => {
    expect(camerasThatOutlined('the shop', here, [here, elsewhere])).toEqual([]);
    expect(camerasThatOutlined('the shop', camera('alone', null, []), [camera('alone', null, []), camera('other', null, [zone('shop')])])).toEqual([]);
  });

  it('knows a thing under the word first listed for it, not only the word that outlined it', () => {
    const kekes = camera('kekes', 'site', [zone('auto rickshaw', 'auto rickshaw', 'keke')]);
    expect(camerasThatOutlined('a keke', here, [here, kekes])).toEqual([{ camera: 'kekes', name: 'kekes camera', zones: ['auto rickshaw'] }]);
  });

  it('matches a zone’s own name and all the words of a longer name', () => {
    const conditioned = camera('cool', 'site', [zone('air conditioner'), zone('door', 'loading bay')]);
    expect(camerasThatOutlined('the loading bay', here, [here, conditioned])).toEqual([{ camera: 'cool', name: 'cool camera', zones: ['loading bay'] }]);
    expect(camerasThatOutlined('the air', here, [here, conditioned])).toEqual([]);
  });

  it('offers a camera only when it outlined more of what was asked than this one, the most first', () => {
    expect(camerasThatOutlined('the gate by the shop', here, [here, shops])).toEqual([]);
    const both = camera('both', 'site', [zone('gate'), zone('shop')]);
    expect(camerasThatOutlined('the gate by the shop', here, [here, shops, both])).toEqual([{ camera: 'both', name: 'both camera', zones: ['gate', 'shop'] }]);
    expect(camerasThatOutlined('the road by the shop', here, [here, roads, shops]).map((c) => c.camera)).toEqual(['shops', 'roads']);
  });

  it('offers nothing when the plan says nothing about what the alert is for', () => {
    expect(camerasThatOutlined('', here, [here, shops])).toEqual([]);
  });
});
