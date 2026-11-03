import { z } from 'zod';
import type { Picture } from '../sam/client.js';
import type { SparkClient } from './client.js';

const MAX_ITEMS = 10;

export class SparkFollowPlanner {
  constructor(private readonly spark: SparkClient) {}

  // What in this one picture could be followed through a video, in words the outlining model answers to.
  async listThings(picture: Picture): Promise<string[]> {
    const { items } = await this.spark.json(
      `This picture is one frame of a video from a fixed security camera.
List the separate things in it that someone might want to follow through the video: people, vehicles, and objects that can be carried or moved.
Use the most ordinary short name for each kind, one or two words, singular. Name each kind once, however many there are. Leave out walls, floors, the sky, plants, fixed furniture and text drawn on the picture by the camera.
List at most ${MAX_ITEMS} kinds. Reply with JSON only: {"items": ["..."]}`,
      [{ label: 'frame', picture }],
      z.object({ items: z.array(z.string()) }),
    );
    return items.slice(0, MAX_ITEMS);
  }

  // A short name for something selected by a click, from a crop around it.
  async nameThing(crop: Picture): Promise<string> {
    const { name } = await this.spark.json(
      `This crop comes from a frame of a fixed security camera's video. Something at its centre was selected.
Name that one thing in the most ordinary short name, one or two words, singular, such as "bag" or "white van". Do not describe what it is doing.
Reply with JSON only: {"name": "..."}`,
      [{ label: 'crop', picture: crop }],
      z.object({ name: z.string().trim().min(1).max(40) }),
    );
    return name.toLowerCase();
  }
}
