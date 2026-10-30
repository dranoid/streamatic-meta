import sharp from 'sharp';
import type { Picture } from '../sam/client.js';
import type { Box } from '../sam/outlines.js';
import type { Frame } from './zone-rule.js';

// The change check compares small grey copies; the full picture is kept for SAM and the alert.
const CHECK_WIDTH = 160;

export async function pictureFrame({ bytes, at, width, height }: { bytes: Uint8Array; at: number; width: number; height: number }): Promise<Frame> {
  const { data, info } = await sharp(bytes).resize(CHECK_WIDTH).greyscale().raw().toBuffer({ resolveWithObject: true });
  return {
    at,
    width,
    height,
    picture: { bytes, mimeType: 'image/jpeg' },
    gray: { width: info.width, height: info.height, data: new Uint8Array(data) },
  };
}

// A drawn box's part of the picture, for Spark Open to answer the box's question on.
export async function cropPicture(picture: Picture, box: Box): Promise<Picture> {
  const region = { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.right - box.left), height: Math.round(box.bottom - box.top) };
  return { ...picture, bytes: new Uint8Array(await sharp(picture.bytes).extract(region).jpeg().toBuffer()) };
}
