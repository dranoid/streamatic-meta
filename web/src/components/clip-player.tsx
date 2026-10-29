import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { BellRing, Pause, Play, RotateCcw, ScanSearch, SkipForward } from 'lucide-react';
import { OverlayChip, PictureFrame, type DrawnPath } from '@/components/picture-frame';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { mediaUrl, type EventFrame, type StoredEvent } from '@/lib/api';
import { cn } from '@/lib/cn';
import { clockTime } from '@/lib/time';

// The alert stays on the tile this long after the play clock passes it.
const RECENT_MS = 4000;
const KEY_STEP_MS = 1000;
// Play starts this far before the alert when jumping to it.
const LEAD_IN_MS = 2000;

type View = 'outlined' | 'plain';

// The frames around an alert on one clock: the alert's moment is marked, and SAM's outline shows on each picture it judged.
export function ClipPlayer({ event, frames: given }: { event: StoredEvent; frames: EventFrame[] }) {
  const frames = useMemo(
    () => (given.length > 0 ? given : event.picture ? [{ at: event.at, file: event.picture, outline: event.outline }] : []),
    [given, event],
  );
  const start = frames[0]?.at ?? event.at;
  const length = Math.max(0, (frames[frames.length - 1]?.at ?? event.at) - start);
  const alertPlay = event.at - start;
  const clock = usePlayClock(length);
  const [view, setView] = useState<View>('outlined');
  const [speed, setSpeed] = useState<'1' | '2'>('1');
  clock.speed.current = Number(speed);

  useEffect(() => {
    // Every frame is fetched up front, so playback never waits on a picture.
    for (const f of frames) new Image().src = mediaUrl(f.file);
  }, [frames]);

  const capture = start + clock.play;
  const frame = frameAt(frames, capture);
  const recent = clock.play >= alertPlay && clock.play - alertPlay < RECENT_MS;
  const judged = frames.filter((f) => f.outline !== null);

  const paths: DrawnPath[] =
    view === 'plain'
      ? []
      : [
          ...(event.reference ? [{ key: 'reference', d: event.reference, colour: '#ffffff', style: 'dashed' as const }] : []),
          ...(frame?.outline ? [{ key: 'now', d: frame.outline, colour: '#ef4444', style: 'fill' as const }] : []),
        ];

  if (frames.length === 0) {
    return event.clip ? (
      <video src={mediaUrl(event.clip)} controls playsInline className='aspect-video w-full rounded-lg bg-black' aria-label={`Clip of ${event.zone}`} />
    ) : null;
  }

  return (
    <div className='space-y-4'>
      <PictureFrame
        src={frame ? mediaUrl(frame.file) : null}
        alt={`${event.zone} on ${event.camera} at ${clockTime(capture)}`}
        paths={paths}
        className={cn('ring-2 ring-transparent transition-shadow', recent && 'ring-alert')}
      >
        {recent && (
          <div role='status' className='absolute top-2 right-2 left-2 ml-auto flex max-w-[85%] items-start gap-1.5 rounded bg-black/75 px-2 py-1 text-xs text-white sm:max-w-[60%]'>
            <BellRing className='text-alert mt-0.5 size-3.5 shrink-0' />
            <span className='line-clamp-2'>{event.rule}</span>
          </div>
        )}
        {frame?.outline && view === 'outlined' && (
          <OverlayChip className='bottom-2 left-2 flex items-center gap-1.5'>
            <ScanSearch className='size-3.5' />
            SAM 3.1 checked this picture
          </OverlayChip>
        )}
      </PictureFrame>

      <Timeline
        length={length}
        play={clock.play}
        onSeek={clock.seek}
        label={(p) => clockTime(start + p)}
        alert={{ play: alertPlay, label: event.rule }}
        judged={judged.map((f) => f.at - start)}
      />

      <div className='flex flex-wrap items-center gap-2'>
        <Button size='sm' onClick={clock.playing ? clock.pause : clock.start} aria-label={clock.playing ? 'Pause' : 'Play'}>
          {clock.playing ? <Pause /> : <Play />}
          {clock.playing ? 'Pause' : 'Play'}
        </Button>
        <Button size='sm' variant='outline' onClick={() => clock.seek(0)}>
          <RotateCcw />
          Restart
        </Button>
        <Button size='sm' variant='outline' onClick={() => clock.seek(Math.max(0, alertPlay - LEAD_IN_MS))}>
          <SkipForward />
          Go to the alert
        </Button>
        <div className='ml-auto flex flex-wrap items-center gap-2'>
          <Segmented
            label='View'
            className='h-8'
            value={view}
            onChange={setView}
            options={[
              { value: 'outlined', label: 'Outlined' },
              { value: 'plain', label: 'Plain' },
            ]}
          />
          <Segmented
            label='Speed'
            className='h-8'
            value={speed}
            onChange={setSpeed}
            options={[
              { value: '1', label: '1×' },
              { value: '2', label: '2×' },
            ]}
          />
        </div>
      </div>
      {view === 'outlined' && (
        <p className='text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs'>
          <span className='flex items-center gap-1.5'>
            <span className='inline-block h-0 w-4 border-t-2 border-dashed border-current' />
            The zone at setup
          </span>
          <span className='flex items-center gap-1.5'>
            <span className='bg-alert/40 border-alert inline-block size-3 rounded-[2px] border' />
            SAM 3.1’s outline on the pictures it judged
          </span>
        </p>
      )}
    </div>
  );
}

function Timeline({
  length,
  play,
  onSeek,
  label,
  alert,
  judged,
}: {
  length: number;
  play: number;
  onSeek: (play: number) => void;
  label: (play: number) => string;
  alert: { play: number; label: string };
  judged: number[];
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
      <div className='relative h-4'>
        {judged.map((p) => (
          <span
            key={p}
            title={`SAM 3.1 judged the picture at ${label(p)}`}
            className='bg-primary absolute top-1.5 h-2.5 w-0.5 -translate-x-1/2 rounded-full'
            style={{ left: `${at(p)}%` }}
          />
        ))}
        <button
          type='button'
          title={alert.label}
          aria-label={`Go to the alert: ${alert.label}`}
          onClick={() => onSeek(Math.max(0, alert.play - LEAD_IN_MS))}
          className='bg-alert ring-background absolute top-0.5 size-3 -translate-x-1/2 rotate-45 rounded-[2px] ring-2'
          style={{ left: `${at(alert.play)}%` }}
        />
      </div>
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

// The latest frame taken at or before the moment: each picture holds until the next.
function frameAt(frames: EventFrame[], at: number): EventFrame | null {
  let found: EventFrame | null = null;
  for (const f of frames) {
    if (f.at > at) break;
    found = f;
  }
  return found ?? frames[0] ?? null;
}

function usePlayClock(length: number) {
  const [play, setPlay] = useState(0);
  const [playing, setPlaying] = useState(false);
  const speed = useRef(1);
  const playRef = useRef(0);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const next = Math.min(length, playRef.current + (now - last) * speed.current);
      last = now;
      playRef.current = next;
      setPlay(next);
      if (next >= length) setPlaying(false);
      else frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, length]);

  const seek = (to: number) => {
    playRef.current = Math.min(Math.max(to, 0), length);
    setPlay(playRef.current);
  };
  return {
    play,
    playing,
    speed,
    seek,
    start: () => {
      if (playRef.current >= length) seek(0);
      setPlaying(true);
    },
    pause: () => setPlaying(false),
  };
}
