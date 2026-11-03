import { useState, type ReactNode, type Ref } from 'react';
import { ImageOff, LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface DrawnPath {
  key: string;
  d: string;
  colour: string;
  style: 'fill' | 'dashed' | 'selected';
  // Shown beside the pointer. A path without one does not respond to hovering.
  title?: string;
  // Paths of one group light up together, as the pieces of one zone do.
  group?: string;
  onSelect?: () => void;
}

const OPACITY = { fill: 0.22, selected: 0.5 };
const OPACITY_HOVERED = { fill: 0.45, selected: 0.65 };

interface Hovered {
  group: string;
  title: string;
  x: number;
  y: number;
}

// Outlines in a picture's own pixels, so they stay on the thing at any size. The longest are drawn first, so a small zone
// lying on a large one can still be reached with the pointer.
export function Outlines({
  width,
  height,
  paths,
  stroke,
  svgRef,
  drawing = false,
  passThrough = false,
  onPathClick,
  children,
}: {
  width: number;
  height: number;
  paths: DrawnPath[];
  stroke: number;
  svgRef?: Ref<SVGSVGElement>;
  drawing?: boolean;
  // Over a player: the picture underneath keeps its own clicks, and only the outlines answer the pointer.
  passThrough?: boolean;
  onPathClick?: () => void;
  children?: ReactNode;
}) {
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const inOrder = [...paths].sort((a, b) => b.d.length - a.d.length);
  const left = hovered ? (hovered.x / width) * 100 : 0;
  const top = hovered ? (hovered.y / height) * 100 : 0;

  return (
    <>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio='xMidYMid meet'
        className={cn('absolute inset-0 h-full w-full', drawing && 'cursor-crosshair touch-none', passThrough && 'pointer-events-none')}
        aria-hidden={paths.every((p) => !p.onSelect)}
        onPointerLeave={() => setHovered(null)}
      >
        {inOrder.map((p) => {
          const group = p.group ?? p.key;
          const lit = hovered?.group === group;
          const level = p.style === 'selected' ? 'selected' : 'fill';
          return (
            <path
              key={p.key}
              d={p.d}
              fillRule='evenodd'
              fill={p.style === 'dashed' ? 'none' : p.colour}
              fillOpacity={(lit ? OPACITY_HOVERED : OPACITY)[level]}
              stroke={p.style === 'selected' ? '#ffffff' : p.colour}
              strokeWidth={p.style === 'selected' ? stroke * 2 : stroke}
              strokeDasharray={p.style === 'dashed' ? `${stroke * 4} ${stroke * 3}` : undefined}
              strokeLinejoin='round'
              className={cn('transition-[fill-opacity] duration-100', p.onSelect && !drawing && 'cursor-pointer')}
              style={{ pointerEvents: drawing ? 'none' : p.title || p.onSelect ? 'auto' : passThrough ? 'none' : undefined }}
              onClick={() => (p.onSelect ?? onPathClick)?.()}
              onPointerMove={(event) => {
                if (!p.title) return;
                const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
                if (!box) return;
                setHovered({ group, title: p.title, x: ((event.clientX - box.left) / box.width) * width, y: ((event.clientY - box.top) / box.height) * height });
              }}
              role={p.onSelect ? 'button' : undefined}
              aria-label={p.onSelect ? p.title : undefined}
            />
          );
        })}
        {children}
      </svg>
      {hovered && (
        <span
          role='tooltip'
          className='pointer-events-none absolute z-10 max-w-48 truncate rounded bg-black/85 px-2 py-1 text-xs font-medium text-white shadow'
          style={{ left: `${left}%`, top: `${top}%`, transform: `translate(${left > 70 ? 'calc(-100% - 10px)' : '10px'}, ${top < 12 ? '10px' : 'calc(-100% - 10px)'})` }}
        >
          {hovered.title}
        </span>
      )}
    </>
  );
}

export function PictureFrame({
  src,
  alt,
  paths = [],
  box,
  className,
  children,
  onPicture,
  drawing,
}: {
  src: string | null;
  alt: string;
  paths?: DrawnPath[];
  box?: { left: number; top: number; right: number; bottom: number } | null;
  className?: string;
  children?: ReactNode;
  onPicture?: (svg: SVGSVGElement | null) => void;
  drawing?: boolean;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const stroke = size ? Math.max(2, size.w / 360) : 2;

  return (
    <div className={cn('relative aspect-video overflow-hidden rounded-lg bg-black select-none', className)}>
      {src && !failed ? (
        <img
          src={src}
          alt={alt}
          draggable={false}
          className='absolute inset-0 h-full w-full object-contain'
          onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
        />
      ) : (
        <div className='absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-xs text-white/60'>
          <ImageOff className='size-5' />
          {failed ? 'The picture could not be loaded' : 'No picture'}
        </div>
      )}
      {size && (
        <Outlines width={size.w} height={size.h} paths={paths} stroke={stroke} drawing={drawing ?? false} {...(onPicture ? { svgRef: onPicture } : {})}>
          {box && (
            <rect
              x={box.left}
              y={box.top}
              width={box.right - box.left}
              height={box.bottom - box.top}
              fill='#ffffff'
              fillOpacity={0.14}
              stroke='#ffffff'
              strokeWidth={stroke * 2}
              strokeDasharray={`${stroke * 4} ${stroke * 3}`}
              style={{ pointerEvents: 'none' }}
            />
          )}
        </Outlines>
      )}
      {children}
    </div>
  );
}

// Covers the whole picture while it is being worked on, so it is plain that the picture itself is what is in progress.
export function PictureBusy({ label }: { label: string }) {
  return (
    <div role='status' className='absolute inset-0 z-20 flex items-center justify-center overflow-hidden bg-black/55 backdrop-blur-[1px]'>
      <div className='picture-scan absolute inset-y-0 w-1/3' />
      <p className='relative flex items-center gap-2 rounded-md bg-black/70 px-3 py-2 text-sm font-medium text-white'>
        <LoaderCircle className='size-4 animate-spin' />
        {label}
      </p>
    </div>
  );
}

// Distinct on a dark picture by day and on infrared; red is kept for alerts.
export const ZONE_COLOURS = ['#538ee7', '#e8c547', '#34d399', '#f472b6', '#fb923c', '#a78bfa', '#22d3ee', '#a3e635', '#fbcb97', '#5f8787', '#2dd4bf', '#94a3b8'];

export function OverlayChip({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn('absolute rounded bg-black/65 px-2 py-0.5 text-xs text-white', className)}>{children}</span>;
}
