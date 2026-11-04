import { decodeMaskToSVGPath, frameIndexOf, parseImageStream, parseVideoStream, recordsOfKind, type ResponsesEvent } from '@meta-sam/parser';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Outline {
  word: string;
  objectId: string;
  box: Box;
  path: string;
  confidence?: number;
}

export interface Diagnostic {
  severity: 'warning' | 'error';
  code: string;
  message: string;
}

export async function outlinesFromText(
  word: string,
  text: string,
): Promise<{ outlines: Outline[]; diagnostics: Diagnostic[] }> {
  const result = await parseImageStream(completedResponse(text)).finalResult;
  const outlines = recordsOfKind(result.records, 'mask').map((record) => ({
    word,
    objectId: record.objectId,
    box: { ...record.bounds },
    // The parser traces the mask in its own raster; bounds place that raster in the picture.
    path: translatePath(decodeMaskToSVGPath(record.mask), record.bounds.left, record.bounds.top),
    ...(record.confidence === undefined ? {} : { confidence: record.confidence }),
  }));
  const diagnostics = result.diagnostics.map(({ severity, code, message }) => ({ severity, code, message }));
  return { outlines, diagnostics };
}

export interface FollowedFrame {
  frame: number;
  box: Box;
  path: string;
}

// SAM tracks forward from the prompted frame and then backward, so the reply is not in frame order.
export async function framesFromText(text: string): Promise<FollowedFrame[]> {
  const result = await parseVideoStream(completedResponse(text)).finalResult;
  return recordsOfKind(result.records, 'mask')
    .map((record) => ({
      frame: frameIndexOf(record) ?? 0,
      box: { ...record.bounds },
      path: translatePath(decodeMaskToSVGPath(record.mask), record.bounds.left, record.bounds.top),
    }))
    .sort((a, b) => a.frame - b.frame);
}

// The parser reads a stream of events; a non-streaming reply is the same text as one finished lane.
async function* completedResponse(text: string): AsyncIterable<ResponsesEvent> {
  yield { type: 'response.output_text.done', item_id: 'reply', output_index: 0, content_index: 0, text };
  yield { type: 'response.completed' };
}

function translatePath(path: string, dx: number, dy: number): string {
  return path.replace(/([ML])(-?[\d.]+) (-?[\d.]+)/g, (_, command, x, y) => `${command}${Number(x) + dx} ${Number(y) + dy}`);
}

const pointsOf = (path: string) => [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));

function areaOf(path: string): number {
  const points = pointsOf(path);
  const doubled = points.reduce((sum, p, i) => {
    const next = points[(i + 1) % points.length]!;
    return sum + p.x * next.y - next.x * p.y;
  }, 0);
  return Math.abs(doubled) / 2;
}

// Below this share of the largest piece, a piece of an outline is a stray dot, not part of the thing.
const SPECK_SHARE = 0.02;

export function withoutSpecks<T extends { box: Box; path: string }>(outline: T): T {
  const pieces = outline.path.split(/(?=M)/).filter((piece) => piece.trim() !== '');
  const largest = Math.max(...pieces.map(areaOf));
  const kept = pieces.filter((piece) => areaOf(piece) >= largest * SPECK_SHARE);
  if (kept.length === pieces.length) return outline;
  const points = kept.flatMap(pointsOf);
  return {
    ...outline,
    path: kept.join(''),
    box: {
      left: Math.floor(Math.min(...points.map((p) => p.x))),
      top: Math.floor(Math.min(...points.map((p) => p.y))),
      right: Math.ceil(Math.max(...points.map((p) => p.x))),
      bottom: Math.ceil(Math.max(...points.map((p) => p.y))),
    },
  };
}

export function boxOverlap(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) return 0;
  const shared = w * h;
  const area = (r: Box) => (r.right - r.left) * (r.bottom - r.top);
  return shared / (area(a) + area(b) - shared);
}
