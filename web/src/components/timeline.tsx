import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

const KEY_STEP_MS = 1000;

export type TimelineLabel = (play: number) => string;

// A playback bar. children draw what is marked along it, given a function from a moment to its place in percent.
export function Timeline({
  length,
  play,
  onSeek,
  label,
  children,
}: {
  length: number;
  play: number;
  onSeek: (play: number) => void;
  label: TimelineLabel;
  children?: (at: (ms: number) => number) => ReactNode;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const at = (ms: number) => (length > 0 ? (Math.min(Math.max(ms, 0), length) / length) * 100 : 0);

  const seekTo = (event: PointerEvent<HTMLDivElement>) => {
    const rect = bar.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    onSeek(Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1) * length);
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight') onSeek(play + KEY_STEP_MS);
    else if (event.key === 'ArrowLeft') onSeek(play - KEY_STEP_MS);
    else if (event.key === 'Home') onSeek(0);
    else if (event.key === 'End') onSeek(length);
    else return;
    event.preventDefault();
  };

  return (
    <div className='space-y-1.5'>
      {children?.(at)}
      <div
        ref={bar}
        role='slider'
        tabIndex={0}
        aria-label='Playback position'
        aria-valuemin={0}
        aria-valuemax={Math.round(length / 1000)}
        aria-valuenow={Math.round(play / 1000)}
        aria-valuetext={label(play)}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seekTo(e);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) seekTo(e);
        }}
        className='bg-muted focus-visible:ring-ring relative h-2 cursor-pointer touch-none rounded-full outline-none focus-visible:ring-2'
      >
        <div className='bg-primary/70 absolute inset-y-0 left-0 rounded-full' style={{ width: `${at(play)}%` }} />
        <div
          className='bg-primary ring-background absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2'
          style={{ left: `${at(play)}%` }}
        />
      </div>
      <div className='text-muted-foreground flex justify-between text-xs tabular-nums'>
        <span className='text-foreground'>{label(play)}</span>
        <span>{label(length)}</span>
      </div>
    </div>
  );
}
