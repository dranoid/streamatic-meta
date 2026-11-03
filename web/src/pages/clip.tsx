import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Crosshair, LoaderCircle, Pause, Play, Search, X } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { PictureFrame, ZONE_COLOURS, type DrawnPath } from '@/components/picture-frame';
import { Timeline } from '@/components/timeline';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { api, clipPictureUrl, clipVideoUrl, type Clip, type Follow, type FollowJob, type Thing } from '@/lib/api';
import { cn } from '@/lib/cn';
import { sentence } from '@/lib/time';

const POLL_MS = 1_000;
const FOLLOW_COLOUR = '#e8c547';

function duration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export function ClipPage({ id }: { id: string }) {
  const clips = useQuery({ queryKey: ['clips'], queryFn: api.clips });
  const follows = useQuery({ queryKey: ['follows', id], queryFn: () => api.follows(id) });
  const clip = clips.data?.find((c) => c.id === id);

  if (clips.isPending) return <Skeleton className='h-[32rem] rounded-xl' />;
  if (!clip) return <Notice tone='error'>This clip could not be found.</Notice>;
  return (
    <>
      <PageHeader trail={[{ href: '/clips', label: 'Follow' }]} icon={<Crosshair />} title={clip.name} description='Pause on the frame you want, then select what to follow.' />
      <ClipWatch clip={clip} follows={follows.data ?? []} />
    </>
  );
}

function ClipWatch({ clip, follows }: { clip: Clip; follows: Follow[] }) {
  const video = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [shownId, setShownId] = useState<string | null>(null);
  const [choosingAt, setChoosingAt] = useState<number | null>(null);
  const shown = follows.find((f) => f.id === shownId) ?? null;

  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function tick() {
      if (video.current) setTime(video.current.currentTime);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const seek = (seconds: number) => {
    if (!video.current) return;
    video.current.currentTime = seconds;
    setTime(seconds);
  };
  const length = clip.frames / clip.fps;
  const currentFrame = Math.min(clip.frames - 1, Math.floor(time * clip.fps + 0.001));
  const framesOfShown = useMemo(() => new Map(shown?.frames.map((f) => [f.frame, f])), [shown]);
  const here = framesOfShown.get(currentFrame);

  const startChoosing = () => {
    video.current?.pause();
    setChoosingAt(currentFrame);
  };
  const followed = useCallback((id: string) => {
    setChoosingAt(null);
    setShownId(id);
  }, []);

  return (
    <div className='grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]'>
      <Card className='min-w-0'>
        <CardContent className='space-y-4'>
          <div className={cn('relative aspect-video overflow-hidden rounded-lg bg-black', choosingAt !== null && 'hidden')}>
            <video
              ref={video}
              src={clipVideoUrl(clip.id)}
              playsInline
              muted
              preload='auto'
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
              onClick={(e) => (e.currentTarget.paused ? void e.currentTarget.play() : e.currentTarget.pause())}
              className='absolute inset-0 h-full w-full object-contain'
              aria-label={clip.name}
            />
            {here && (
              <svg viewBox={`0 0 ${clip.width} ${clip.height}`} preserveAspectRatio='xMidYMid meet' className='pointer-events-none absolute inset-0 h-full w-full' aria-hidden>
                <path d={here.path} fillRule='evenodd' fill={FOLLOW_COLOUR} fillOpacity={0.3} stroke={FOLLOW_COLOUR} strokeWidth={Math.max(2, clip.width / 360)} strokeLinejoin='round' />
              </svg>
            )}
          </div>

          {choosingAt !== null ? (
            <Choosing clip={clip} frame={choosingAt} onCancel={() => setChoosingAt(null)} onFollowed={followed} />
          ) : (
            <>
              <Timeline length={length * 1000} play={time * 1000} onSeek={(ms) => seek(ms / 1000)} label={(ms) => duration(ms / 1000)}>
                {(at) =>
                  shown && (
                    <div className='bg-muted/60 relative h-2 overflow-hidden rounded-full' role='img' aria-label={`When the ${shown.name} was in view`}>
                      {shown.spans.map((s) => {
                        const from = at((s.from / clip.fps) * 1000);
                        return <span key={s.from} className='absolute inset-y-0 rounded-full' style={{ left: `${from}%`, width: `${Math.max(at(((s.to + 1) / clip.fps) * 1000) - from, 0.5)}%`, background: FOLLOW_COLOUR }} />;
                      })}
                    </div>
                  )
                }
              </Timeline>
              <div className='flex flex-wrap items-center gap-2'>
                <Button
                  size='sm'
                  variant='outline'
                  aria-label={playing ? 'Pause' : 'Play'}
                  onClick={() => (video.current?.paused ? void video.current.play() : video.current?.pause())}
                >
                  {playing ? <Pause /> : <Play />}
                  {playing ? 'Pause' : 'Play'}
                </Button>
                <Button size='sm' onClick={startChoosing}>
                  <Crosshair />
                  Follow something
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <aside className='min-w-0'>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Followed in this clip</CardTitle>
              <CardDescription>Select one to see it in the clip.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {follows.length === 0 ? (
              <p className='text-muted-foreground text-sm'>Nothing has been followed in this clip yet.</p>
            ) : (
              <ul className='space-y-2'>
                {follows.map((f) => (
                  <li key={f.id}>
                    <button
                      type='button'
                      aria-pressed={f.id === shownId}
                      onClick={() => {
                        setChoosingAt(null);
                        setShownId(f.id);
                        if (f.spans[0]) seek(f.spans[0].from / clip.fps);
                      }}
                      className={cn('hover:bg-accent w-full rounded-lg border p-3 text-left text-sm transition-colors', f.id === shownId && 'border-primary')}
                    >
                      <span className='font-medium'>{sentence(f.name)}</span>
                      <span className='text-muted-foreground mt-1 block text-xs'>
                        {f.spans.length === 0
                          ? 'Not found in this clip'
                          : `In view ${f.spans.map((s) => `${duration(s.from / clip.fps)}–${duration((s.to + 1) / clip.fps)}`).join(', ')}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

// The follow mode, on one paused frame: everything found is outlined, and the person selects what to follow.
function Choosing({ clip, frame, onCancel, onFollowed }: { clip: Clip; frame: number; onCancel: () => void; onFollowed: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [things, setThings] = useState<Thing[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [word, setWord] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<FollowJob | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);

  const name = useQuery({ queryKey: ['name-frame', clip.id, frame], queryFn: () => api.outline(clip.id, frame, {}), retry: false, staleTime: Infinity });
  useEffect(() => {
    if (name.data) setThings(name.data.things);
  }, [name.data]);

  const search = useMutation({
    mutationFn: (w: string) => api.outline(clip.id, frame, { word: w }),
    onSuccess: (result, w) => {
      setThings(result.things);
      setNote(result.found === 0 ? `Nothing was found under “${w}”. Try another word, or select it on the picture.` : null);
      if (result.found) setWord('');
    },
  });
  const click = useMutation({
    mutationFn: (point: { x: number; y: number }) => api.outline(clip.id, frame, { point }),
    onSuccess: (result) => {
      setThings(result.things);
      setSelected(result.selected ?? null);
      setNote(result.selected ? null : 'Nothing could be outlined there. Select another place, or search for it.');
    },
  });
  const start = useMutation({
    mutationFn: (thing: string) => api.startFollow(clip.id, frame, thing),
    onSuccess: ({ id }) => setJobId(id),
  });

  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    const poll = async () => {
      const latest = await api.followJob(clip.id, jobId).catch(() => null);
      if (stopped) return;
      if (latest) setJob(latest);
      if (latest?.state === 'done') {
        await queryClient.invalidateQueries({ queryKey: ['follows', clip.id] });
        onFollowed(jobId);
        return;
      }
      if (latest?.state !== 'failed') setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
    };
  }, [jobId, clip.id, queryClient, onFollowed]);

  const running = (jobId !== null && job?.state !== 'failed') || start.isPending;
  const words = [...new Set(things.map((t) => t.name))];
  const selectedThing = things.find((t) => t.id === selected) ?? null;
  const paths: DrawnPath[] = things.map((t) => ({
    key: t.id,
    d: t.path,
    colour: ZONE_COLOURS[words.indexOf(t.name) % ZONE_COLOURS.length]!,
    style: t.id === selected ? 'selected' : 'fill',
    title: sentence(t.name),
    onSelect: running ? undefined : () => setSelected(t.id),
  }));

  // A click off every outline asks for an outline of what is there, so something no word found can still be followed.
  const onPictureClick = (event: MouseEvent<HTMLDivElement>) => {
    if (running || click.isPending || (event.target as Element).tagName === 'path' || !svg.current) return;
    const matrix = svg.current.getScreenCTM();
    if (!matrix) return;
    const at = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const x = Math.floor(at.x);
    const y = Math.floor(at.y);
    if (x < 0 || y < 0 || x >= clip.width || y >= clip.height) return;
    click.mutate({ x, y });
  };
  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    if (word.trim()) search.mutate(word.trim());
  };

  const error = name.error ?? search.error ?? click.error ?? start.error;
  return (
    <div className='space-y-4'>
      <div onClick={onPictureClick} className={cn(!running && 'cursor-crosshair')}>
        <PictureFrame
          src={clipPictureUrl(clip.id, frame)}
          alt={`Frame ${frame} of ${clip.name}`}
          paths={paths}
          onPicture={(el) => {
            svg.current = el;
          }}
        />
      </div>

      {running ? (
        <div role='status' className='space-y-2'>
          <p className='flex items-center gap-2 text-sm font-medium'>
            <LoaderCircle className='size-4 animate-spin' />
            Following the {selectedThing?.name ?? job?.name} through the clip
          </p>
          <div className='bg-muted h-2 overflow-hidden rounded-full'>
            <div className='bg-primary h-full w-1/3 animate-pulse rounded-full' />
          </div>
          <p className='text-muted-foreground text-xs'>
            {job?.framesSeen ? `Found on ${job.framesSeen.toLocaleString('en-GB')} frames so far. ` : ''}
            This usually takes under a minute.
          </p>
        </div>
      ) : (
        <>
          {name.isPending ? (
            <p role='status' className='text-muted-foreground flex items-center gap-2 text-sm'>
              <LoaderCircle className='size-4 animate-spin' />
              Finding what is in this picture
            </p>
          ) : (
            <p className='text-muted-foreground text-sm'>
              {things.length === 0 ? 'Nothing was outlined on this frame.' : 'Select an outline to follow.'} If what you want is not outlined, search for it or select it on the picture.
            </p>
          )}
          <form onSubmit={onSearch} className='flex flex-wrap items-end gap-2'>
            <Label className='min-w-48 flex-1 flex-col items-start gap-1.5'>
              Search for something else
              <Input value={word} maxLength={60} onChange={(e) => setWord(e.target.value)} placeholder='For example, red car' />
            </Label>
            <Button type='submit' variant='outline' disabled={!word.trim() || search.isPending}>
              {search.isPending ? <LoaderCircle className='animate-spin' /> : <Search />}
              Search
            </Button>
          </form>
          {click.isPending && (
            <p role='status' className='text-muted-foreground flex items-center gap-2 text-sm'>
              <LoaderCircle className='size-4 animate-spin' />
              Outlining what you selected
            </p>
          )}
          {note && <Notice>{note}</Notice>}
          {job?.state === 'failed' && <Notice tone='error'>This could not be followed. Please try again.</Notice>}
          {error && <Notice tone='error'>{error.message}</Notice>}
          <div className='flex flex-wrap items-center gap-2'>
            <Button
              size='sm'
              disabled={!selectedThing}
              onClick={() => {
                setJob(null);
                setJobId(null);
                if (selectedThing) start.mutate(selectedThing.id);
              }}
            >
              <Crosshair />
              {selectedThing ? `Follow the ${selectedThing.name}` : 'Select something to follow'}
            </Button>
            <Button size='sm' variant='outline' onClick={onCancel}>
              <X />
              Cancel
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
