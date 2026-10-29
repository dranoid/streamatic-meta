import { useState, type ReactNode } from 'react';
import { ImageOff } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface DrawnPath {
  key: string;
  d: string;
  colour: string;
  style: 'fill' | 'dashed' | 'selected';
  title?: string;
  onSelect?: () => void;
}

// A camera picture with outlines drawn in the picture's own pixels, so they stay on the thing at any size.
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
        <svg
          ref={onPicture}
          viewBox={`0 0 ${size.w} ${size.h}`}
          preserveAspectRatio='xMidYMid meet'
          className={cn('absolute inset-0 h-full w-full', drawing && 'cursor-crosshair touch-none')}
          aria-hidden={paths.every((p) => !p.onSelect)}
        >
          {paths.map((p) => (
            <path
              key={p.key}
              d={p.d}
              fillRule='evenodd'
              fill={p.style === 'dashed' ? 'none' : p.colour}
              fillOpacity={p.style === 'selected' ? 0.5 : 0.22}
              stroke={p.style === 'selected' ? '#ffffff' : p.colour}
              strokeWidth={p.style === 'selected' ? stroke * 2 : stroke}
              strokeDasharray={p.style === 'dashed' ? `${stroke * 4} ${stroke * 3}` : undefined}
              strokeLinejoin='round'
              className={cn(p.onSelect && !drawing && 'cursor-pointer transition-[fill-opacity] hover:fill-opacity-50')}
              style={drawing ? { pointerEvents: 'none' } : undefined}
              onClick={p.onSelect}
              role={p.onSelect ? 'button' : undefined}
              aria-label={p.onSelect ? p.title : undefined}
            >
              {p.title && <title>{p.title}</title>}
            </path>
          ))}
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
        </svg>
      )}
      {children}
    </div>
  );
}

// Distinct on a dark picture by day and on infrared; red is kept for alerts.
export const ZONE_COLOURS = ['#538ee7', '#e8c547', '#34d399', '#f472b6', '#fb923c', '#a78bfa', '#22d3ee', '#a3e635', '#fbcb97', '#5f8787', '#2dd4bf', '#94a3b8'];

export function OverlayChip({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn('absolute rounded bg-black/65 px-2 py-0.5 text-xs text-white', className)}>{children}</span>;
}
