import sharp from 'sharp';
import type { Picture } from '../sam/client.js';
import type { Box } from '../sam/outlines.js';

// How much of what surrounds a thing goes with it, as a share of its size.
const AROUND = 0.5;

export async function cropPicture(picture: Picture, box: Box): Promise<Picture> {
  const region = { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.right - box.left), height: Math.round(box.bottom - box.top) };
  return { ...picture, bytes: new Uint8Array(await sharp(picture.bytes).extract(region).jpeg().toBuffer()) };
}

// The thing with some of what surrounds it, which a model needs to tell what it is.
export async function cropAround(picture: Picture, box: Box): Promise<Picture> {
  const image = sharp(picture.bytes);
  const { width = 0, height = 0 } = await image.metadata();
  const marginX = Math.round((box.right - box.left) * AROUND);
  const marginY = Math.round((box.bottom - box.top) * AROUND);
  const near = { left: Math.max(0, box.left - marginX), top: Math.max(0, box.top - marginY), right: Math.min(width, box.right + marginX), bottom: Math.min(height, box.bottom + marginY) };
  return cropPicture(picture, near);
}
