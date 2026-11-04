import sharp from 'sharp';

// Outlines on a picture, light enough to see what is under them. `space` is the size the paths were drawn for, when that is not the picture's own.
// Each kind of mark is one layer, since a zone can hold several outlines of one place and their fills would otherwise stack to solid.
export async function drawOutlines(jpeg: Uint8Array, paths: string[], space?: { width: number; height: number }): Promise<Uint8Array> {
  const { width = 0, height = 0 } = await sharp(jpeg).metadata();
  const across = space?.width ?? width;
  const stroke = Math.max(2, Math.round(across / 320));
  const shapes = paths.map((d) => `<path d="${d}" fill-rule="evenodd"/>`).join('');
  const drawn = `<g opacity="0.12" fill="#ff3b30">${shapes}</g><g opacity="0.7" fill="none" stroke="#ff3b30" stroke-width="${stroke}">${shapes}</g>`;
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${across} ${space?.height ?? height}" preserveAspectRatio="none">${drawn}</svg>`);
  return new Uint8Array(await sharp(jpeg).composite([{ input: overlay }]).jpeg({ quality: 88 }).toBuffer());
}
