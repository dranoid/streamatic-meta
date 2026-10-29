import type { Picture } from '../sam/client.js';
import type { Outline } from '../sam/outlines.js';

export interface LabelledPicture {
  label: string;
  picture: Picture;
}

export interface Outliner {
  outlineAll(picture: Picture, words: string[]): Promise<Record<string, Outline[]>>;
}

export interface ZoneSummary {
  name: string;
  seenAt: string[];
}

export interface SuggestedRule {
  sentence: string;
  zones: string[];
}

export interface SetupPlanner {
  listItems(pictures: LabelledPicture[]): Promise<string[]>;
  alternatives(items: string[], pictures: LabelledPicture[]): Promise<Record<string, string[]>>;
  proposeRules(zones: ZoneSummary[], pictures: LabelledPicture[]): Promise<SuggestedRule[]>;
}

export interface Zone extends ZoneSummary {
  item: string;
  outlines: Record<string, Outline[]>;
}

export interface CameraSetup {
  zones: Zone[];
  notOutlined: Array<{ item: string; triedWords: string[] }>;
  rules: SuggestedRule[];
}

const MAX_ALTERNATIVES = 2;

export async function setUpCamera({
  pictures,
  baseWords,
  sam,
  spark,
}: {
  pictures: LabelledPicture[];
  baseWords: string[];
  sam: Outliner;
  spark: SetupPlanner;
}): Promise<CameraSetup> {
  const items = unique((await spark.listItems(pictures)).map(normalise));
  const words = unique([...items, ...baseWords.map(normalise)]);
  const found = await outlineEverywhere(sam, pictures, words);

  // Spark said it saw these, so a miss is worth a second word; a base word that SAM misses is just not there.
  const missed = items.filter((item) => !isSeen(found[item]!));
  const alternatives = missed.length > 0 ? await spark.alternatives(missed, pictures) : {};
  const tried = new Set(words);
  const retries = Object.fromEntries(
    missed.map((item) => [
      item,
      unique((alternatives[item] ?? []).map(normalise)).filter((w) => !tried.has(w)).slice(0, MAX_ALTERNATIVES),
    ]),
  );
  Object.assign(found, await outlineEverywhere(sam, pictures, unique(Object.values(retries).flat())));

  const zones: Zone[] = words.filter((w) => isSeen(found[w]!)).map((w) => zone(w, w, found[w]!));
  const notOutlined: CameraSetup['notOutlined'] = [];
  for (const item of missed) {
    const word = retries[item]!.find((w) => isSeen(found[w]!));
    if (word === undefined) {
      notOutlined.push({ item, triedWords: [item, ...retries[item]!] });
    } else if (!zones.some((z) => z.name === word)) {
      zones.push(zone(word, item, found[word]!));
    }
  }

  const names = new Set(zones.map((z) => z.name));
  const proposed = await spark.proposeRules(
    zones.map(({ name, seenAt }) => ({ name, seenAt })),
    pictures,
  );
  const rules = proposed.filter((rule) => rule.zones.length > 0 && rule.zones.every((z) => names.has(normalise(z))));
  return { zones, notOutlined, rules };
}

type Sightings = Record<string, Outline[]>;

async function outlineEverywhere(sam: Outliner, pictures: LabelledPicture[], words: string[]) {
  const found: Record<string, Sightings> = Object.fromEntries(words.map((w) => [w, {}]));
  if (words.length === 0) return found;
  for (const { label, picture } of pictures) {
    const outlines = await sam.outlineAll(picture, words);
    for (const word of words) found[word]![label] = outlines[word] ?? [];
  }
  return found;
}

function zone(name: string, item: string, sightings: Sightings): Zone {
  const seenAt = Object.entries(sightings)
    .filter(([, outlines]) => outlines.length > 0)
    .map(([label]) => label);
  return { name, item, seenAt, outlines: sightings };
}

function isSeen(sightings: Sightings): boolean {
  return Object.values(sightings).some((outlines) => outlines.length > 0);
}

function normalise(word: string): string {
  return word.trim().toLowerCase().replace(/\s+/g, ' ');
}

function unique(words: string[]): string[] {
  return [...new Set(words.filter((w) => w !== ''))];
}
