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
