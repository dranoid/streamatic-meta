import { describe, expect, it } from 'vitest';
import type { Camera } from '../src/cameras/camera-folder.js';
import type { CameraZone } from '../src/cameras/camera-zones.js';
import { camerasForSentence, camerasThatOutlined } from '../src/guide/route.js';

const zone = (word: string, name = word, item = word): CameraZone => ({ word, name, item, outlines: { day: [{ word, objectId: '0', box: { left: 0, top: 0, right: 1, bottom: 1 }, path: 'M0 0Z' }] } });
const camera = (id: string, group: string | null, zones: CameraZone[]): Camera => ({ id, name: `${id} camera`, site: 's', baseWords: [], pictures: {}, setup: null, zones, episode: null, backend: null, group, tested: [] });

const here = camera('here', 'site', [zone('gate'), zone('wall')]);
const shops = camera('shops', 'site', [zone('shop'), zone('road')]);
const roads = camera('roads', 'site', [zone('road')]);
const elsewhere = camera('elsewhere', 'other', [zone('shop')]);

describe('camerasForSentence', () => {
  it('takes every camera at any place that outlined what was asked about, the most first', () => {
    const both = camera('both', null, [zone('shop'), zone('road')]);
    expect(camerasForSentence('the road by the shop', [here, shops, roads, both, elsewhere]).map((c) => [c.camera, c.zones.length])).toEqual([['shops', 2], ['both', 2], ['roads', 1], ['elsewhere', 1]]);
  });

  it('ranks by how many of the sentence’s words the zones account for, so having more of one thing wins nothing', () => {
    const many = camera('many', null, [zone('bench', 'bench 1'), zone('bench', 'bench 2'), zone('bench', 'bench 3')]);
    const one = camera('one', null, [zone('bench')]);
    const both = camera('both', null, [zone('bench'), zone('car')]);
    expect(camerasForSentence('a car by the bench', [many, one, both]).map((c) => [c.camera, c.matched])).toEqual([['both', 2], ['many', 1], ['one', 1]]);
  });

  it('ranks a zone named by more of the sentence above one that shares a word with it', () => {
    const named = camera('named', null, [zone('door', 'front door')]);
    const plain = camera('plain', null, [zone('door', 'door 1'), zone('door', 'door 2')]);
    expect(camerasForSentence('the front door', [plain, named]).map((c) => [c.camera, c.matched])).toEqual([['named', 2], ['plain', 1]]);
  });

  it('does not count a zone’s number as a word of the sentence', () => {
    expect(camerasForSentence('the bench after 1 pm', [camera('numbered', null, [zone('bench', 'bench 1')])]).map((c) => c.matched)).toEqual([1]);
  });

  it('finds nothing when no camera outlined what was asked about', () => {
    expect(camerasForSentence('someone is running', [here, shops])).toEqual([]);
  });
});

describe('camerasThatOutlined', () => {
  it('offers the camera where the thing was outlined, when this one did not', () => {
    expect(camerasThatOutlined('the shop', here, [here, shops, roads])).toEqual([{ camera: 'shops', name: 'shops camera', zones: ['shop'], matched: 1 }]);
  });

  it('offers nothing when this camera outlined it too', () => {
    expect(camerasThatOutlined('the gate', here, [here, camera('gates', 'site', [zone('gate')])])).toEqual([]);
  });

  it('offers nothing for having more of the same thing', () => {
    expect(camerasThatOutlined('the gate', here, [here, camera('gates', 'site', [zone('gate', 'gate 1'), zone('gate', 'gate 2')])])).toEqual([]);
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
    expect(camerasThatOutlined('a keke', here, [here, kekes])).toEqual([{ camera: 'kekes', name: 'kekes camera', zones: ['auto rickshaw'], matched: 1 }]);
  });

  it('matches a zone’s own name and all the words of a longer name', () => {
    const conditioned = camera('cool', 'site', [zone('air conditioner'), zone('door', 'loading bay')]);
    expect(camerasThatOutlined('the loading bay', here, [here, conditioned])).toEqual([{ camera: 'cool', name: 'cool camera', zones: ['loading bay'], matched: 2 }]);
    expect(camerasThatOutlined('the air', here, [here, conditioned])).toEqual([]);
  });

  it('offers a camera only when it outlined more of what was asked than this one, the most first', () => {
    expect(camerasThatOutlined('the gate by the shop', here, [here, shops])).toEqual([]);
    const both = camera('both', 'site', [zone('gate'), zone('shop')]);
    expect(camerasThatOutlined('the gate by the shop', here, [here, shops, both])).toEqual([{ camera: 'both', name: 'both camera', zones: ['gate', 'shop'], matched: 2 }]);
    expect(camerasThatOutlined('the road by the shop', here, [here, roads, shops]).map((c) => c.camera)).toEqual(['shops', 'roads']);
  });

  it('offers nothing when the plan says nothing about what the alert is for', () => {
    expect(camerasThatOutlined('', here, [here, shops])).toEqual([]);
  });
});
