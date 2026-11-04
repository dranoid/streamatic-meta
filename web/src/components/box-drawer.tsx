import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react';

export interface DrawnBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type Edge = 'left' | 'right' | 'top' | 'bottom';
const HANDLES: Array<{ edges: Edge[]; cursor: string }> = [
  { edges: ['left', 'top'], cursor: 'nwse-resize' },
  { edges: ['right', 'top'], cursor: 'nesw-resize' },
  { edges: ['left', 'bottom'], cursor: 'nesw-resize' },
  { edges: ['right', 'bottom'], cursor: 'nwse-resize' },
  { edges: ['top'], cursor: 'ns-resize' },
  { edges: ['bottom'], cursor: 'ns-resize' },
  { edges: ['left'], cursor: 'ew-resize' },
  { edges: ['right'], cursor: 'ew-resize' },
];
const HANDLE_PX = 6;
// A finger needs more room than the handle shows.
const REACH_PX = 16;

type Drag =
  | { kind: 'new'; from: { x: number; y: number } }
  | { kind: 'move'; grabbed: { x: number; y: number }; start: DrawnBox }
  | { kind: 'resize'; edges: Edge[]; start: DrawnBox };

const within = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const handleAt = (box: DrawnBox, edges: Edge[]) => ({
  x: edges.includes('left') ? box.left : edges.includes('right') ? box.right : (box.left + box.right) / 2,
  y: edges.includes('top') ? box.top : edges.includes('bottom') ? box.bottom : (box.top + box.bottom) / 2,
});

// A box drawn over a picture, in the picture's own pixels: drag to draw, inside it to move, and a corner or side to resize.
export function BoxDrawer({ width, height, box, onChange }: { width: number; height: number; box: DrawnBox | null; onChange: (box: DrawnBox | null) => void }) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  // How many picture pixels one screen pixel covers, so the handles keep their size at any width.
  const [unit, setUnit] = useState(1);

  useLayoutEffect(() => {
    const element = svg.current;
    if (!element) return;
    const measure = () => {
      const scale = element.getScreenCTM()?.a;
      if (scale) setUnit(1 / scale);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const pointOf = (event: PointerEvent): { x: number; y: number } | null => {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return null;
    const at = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: within(Math.round(at.x), 0, width), y: within(Math.round(at.y), 0, height) };
  };

  const onDown = (event: PointerEvent) => {
    const at = pointOf(event);
    if (!at) return;
    svg.current?.setPointerCapture(event.pointerId);
    const reach = REACH_PX * unit;
    const handle = box && HANDLES.find(({ edges }) => {
      const spot = handleAt(box, edges);
      return Math.abs(spot.x - at.x) <= reach && Math.abs(spot.y - at.y) <= reach;
    });
    if (box && handle) drag.current = { kind: 'resize', edges: handle.edges, start: box };
    else if (box && at.x > box.left && at.x < box.right && at.y > box.top && at.y < box.bottom) drag.current = { kind: 'move', grabbed: at, start: box };
    else {
      drag.current = { kind: 'new', from: at };
      onChange(null);
    }
  };

  const onMove = (event: PointerEvent) => {
    const at = pointOf(event);
    const now = drag.current;
    if (!at || !now) return;
    if (now.kind === 'new') {
      onChange({ left: Math.min(now.from.x, at.x), top: Math.min(now.from.y, at.y), right: Math.max(now.from.x, at.x), bottom: Math.max(now.from.y, at.y) });
    } else if (now.kind === 'move') {
      const w = now.start.right - now.start.left;
      const h = now.start.bottom - now.start.top;
      const left = within(now.start.left + at.x - now.grabbed.x, 0, width - w);
      const top = within(now.start.top + at.y - now.grabbed.y, 0, height - h);
      onChange({ left, top, right: left + w, bottom: top + h });
    } else {
      const { start, edges } = now;
      const x = edges.includes('left') ? at.x : start.left;
      const xx = edges.includes('right') ? at.x : start.right;
      const y = edges.includes('top') ? at.y : start.top;
      const yy = edges.includes('bottom') ? at.y : start.bottom;
      onChange({ left: Math.min(x, xx), right: Math.max(x, xx), top: Math.min(y, yy), bottom: Math.max(y, yy) });
    }
  };

  const onUp = () => {
    drag.current = null;
  };

  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio='xMidYMid meet'
      role='application'
      aria-label='Draw a box around one item'
      className='absolute inset-0 z-10 h-full w-full cursor-crosshair touch-none'
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {box && (
        <>
          <path d={`M0 0H${width}V${height}H0Z M${box.left} ${box.top}H${box.right}V${box.bottom}H${box.left}Z`} fillRule='evenodd' fill='#000000' fillOpacity={0.5} pointerEvents='none' />
          <rect x={box.left} y={box.top} width={box.right - box.left} height={box.bottom - box.top} fill='none' stroke='#000000' strokeOpacity={0.7} strokeWidth={4} vectorEffect='non-scaling-stroke' pointerEvents='none' />
          <rect x={box.left} y={box.top} width={box.right - box.left} height={box.bottom - box.top} fill='transparent' stroke='#ffffff' strokeWidth={2} vectorEffect='non-scaling-stroke' className='cursor-move' />
          {HANDLES.map(({ edges, cursor }) => {
            const spot = handleAt(box, edges);
            return <circle key={edges.join('-')} cx={spot.x} cy={spot.y} r={HANDLE_PX * unit} fill='#ffffff' stroke='#538ee7' strokeWidth={2} vectorEffect='non-scaling-stroke' style={{ cursor }} />;
          })}
        </>
      )}
    </svg>
  );
}
