import sharp from 'sharp';

export interface DrawnOutline {
  path: string;
  colour: string;
  dashed?: boolean;
}

export async function drawOutlines(jpeg: Uint8Array, outlines: DrawnOutline[]): Promise<Uint8Array> {
  const { width, height } = await sharp(jpeg).metadata();
  const stroke = Math.max(2, Math.round((width ?? 0) / 320));
  const paths = outlines
    .map(({ path, colour, dashed }) =>
      dashed
        ? `<path d="${path}" fill="none" stroke="${colour}" stroke-width="${stroke}" stroke-dasharray="${stroke * 4} ${stroke * 3}"/>`
        : `<path d="${path}" fill="${colour}" fill-opacity="0.35" fill-rule="evenodd" stroke="${colour}" stroke-width="${stroke}"/>`,
    )
    .join('');
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${paths}</svg>`);
  return new Uint8Array(await sharp(jpeg).composite([{ input: overlay }]).jpeg({ quality: 88 }).toBuffer());
}
