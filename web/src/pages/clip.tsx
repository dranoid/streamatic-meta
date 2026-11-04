import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, CircleAlert, Crosshair, LoaderCircle, Pause, Play, Search, SkipForward, SquareDashed, X } from 'lucide-react';
import { BoxDrawer, type DrawnBox } from '@/components/box-drawer';
import { Outlines, PictureBusy, PictureFrame, ZONE_COLOURS, type DrawnPath } from '@/components/picture-frame';
import { DemoGuide } from '@/components/demo-guide';
import { LanguageChoice, type AlertLanguage } from '@/components/language-choice';
import { NeedsKeys } from '@/components/needs-keys';
import { TelegramAlerts, useTelegramLink } from '@/components/telegram-alerts';
import { PageHeader } from '@/components/layout/page-header';
import { Timeline } from '@/components/timeline';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { api, clipPictureUrl, clipVideoUrl, type Clip, type DemoAlert, type DemoClip, type DemoRule, type DemoZone, type Follow, type FollowJob, type Thing } from '@/lib/api';
import { useAbilities } from '@/lib/abilities';
import { cn } from '@/lib/cn';
import { RULE_FINISHED, rulesChosenInSetup, useRefreshRulesBeingAdded } from '@/lib/setup-progress';
import { sentence } from '@/lib/time';

const POLL_MS = 1_000;
const FOLLOW_COLOUR = '#e8c547';
const ALERT_COLOUR = '#ef4444';
const RULE_ZONE_COLOUR = '#538ee7';
// How long an alert stays over the picture once it has reached the person.
const ALERT_BANNER_MS = 6_000;
// Going to an alert starts a little before the moment it is about, so the moment itself is seen.
const LEAD_IN_MS = 3_000;
// A longer step than this between readings of the clock is a jump, not the clip playing through a moment.
const LONGEST_PLAYED_STEP_MS = 2_000;
const REFRESH_LINKED_MS = 15_000;
const SMALLEST_BOX = 8;

function duration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export function ClipPage({ id, isPublic = false, trackSeconds = null }: { id: string; isPublic?: boolean; trackSeconds?: number | null }) {
  const clips = useQuery({ queryKey: ['clips'], queryFn: api.clips });
  const follows = useQuery({ queryKey: ['follows', id], queryFn: () => api.follows(id) });
  const demo = useQuery({ queryKey: ['demo-clip', id], queryFn: () => api.demoClip(id), enabled: isPublic });
  const clip = clips.data?.find((c) => c.id === id);

  if (clips.isPending) return <Skeleton className='h-[32rem] rounded-xl' />;
  if (!clip) return <Notice tone='error'>This clip could not be found.</Notice>;
  return (
    <>
      <PageHeader
        trail={[{ href: '/clips', label: isPublic ? 'Clips' : 'Search' }]}
        icon={<Search />}
        title={clip.name}
        description={isPublic ? 'Select a rule, or describe a new one to the guide, and play the clip. Pause on any frame to search it.' : 'Pause on a frame where it appears, then search for it.'}
      />
      <ClipWatch clip={clip} follows={follows.data ?? []} demo={demo.data ?? null} trackSeconds={trackSeconds} />
    </>
  );
}

function ClipWatch({ clip, follows, demo, trackSeconds }: { clip: Clip; follows: Follow[]; demo: DemoClip | null; trackSeconds: number | null }) {
  const queryClient = useQueryClient();
  const { models } = useAbilities();
  const video = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [shownId, setShownId] = useState<string | null>(null);
  const [choosingAt, setChoosingAt] = useState<number | null>(null);
  const shown = follows.find((f) => f.id === shownId) ?? null;
  // Each ticked rule with the moment on the clip it was ticked at.
  const [ticks, setTicks] = useState<Record<string, number>>({});
  const [showZones, setShowZones] = useState(false);
  const [language, setLanguage] = useState<AlertLanguage>('english');
  const [guideZones, setGuideZones] = useState<DemoZone[] | null>(null);
  const tickList = useMemo(() => Object.entries(ticks).map(([rule, armedMs]) => ({ rule, armedMs })), [ticks]);
  const alertsFound = useQuery({
    queryKey: ['demo-alerts', clip.id, tickList],
    queryFn: () => api.demoAlerts(clip.id, tickList),
    enabled: demo !== null && tickList.length > 0,
    placeholderData: (previous) => previous,
  });
  const alerts = useMemo(() => (tickList.length > 0 ? (alertsFound.data?.alerts ?? []) : []), [tickList, alertsFound.data]);

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
  const refreshDemo = useCallback(() => void queryClient.invalidateQueries({ queryKey: ['demo-clip', clip.id] }), [queryClient, clip.id]);
  const nowMs = time * 1000;
  const telegram = useTelegramLink(clip.id, language);
  const [telegramProblem, setTelegramProblem] = useState<string | null>(null);
  const lastPlayedMs = useRef(0);
  const sentToTelegram = useRef(new Set<string>());
  // An alert goes to the chat as the clip plays through it, as it would on a live camera; going to a moment sends nothing.
  useEffect(() => {
    const from = lastPlayedMs.current;
    lastPlayedMs.current = nowMs;
    if (nowMs < from) sentToTelegram.current.clear();
    if (!telegram.linked || !playing || nowMs < from || nowMs - from > LONGEST_PLAYED_STEP_MS) return;
    for (const alert of alerts) {
      const id = `${alert.rule}:${alert.key}`;
      if (alert.shownMs < from || alert.shownMs > nowMs || sentToTelegram.current.has(id)) continue;
      sentToTelegram.current.add(id);
      api.sendAlertToTelegram(clip.id, alert.rule, alert.key).catch((error: Error) => setTelegramProblem(error.message));
    }
  }, [nowMs, telegram.linked, playing, alerts, clip.id]);
  // A rule added from the chat joins this page's list.
  useEffect(() => {
    if (!telegram.linked) return;
    const refresh = setInterval(refreshDemo, REFRESH_LINKED_MS);
    return () => clearInterval(refresh);
  }, [telegram.linked, refreshDemo]);
  useRefreshRulesBeingAdded(clip.id, demo?.rules ?? [], refreshDemo);
  // The rules chosen in setup are selected on arriving here, each once, so that it can still be unselected.
  const selectedFromSetup = useRef(new Set<string>());
  useEffect(() => {
    if (!demo) return;
    const wanted = new Set(rulesChosenInSetup(clip.id));
    const ready = demo.rules.filter((r) => r.status === 'ready' && wanted.has(r.id) && !selectedFromSetup.current.has(r.id));
    if (ready.length === 0) return;
    for (const rule of ready) selectedFromSetup.current.add(rule.id);
    setTicks((all) => ({ ...all, ...Object.fromEntries(ready.map((r) => [r.id, 0])) }));
  }, [demo, clip.id]);
  const reached = alerts.filter((a) => a.shownMs <= nowMs).sort((a, b) => b.shownMs - a.shownMs);
  const banner = reached.find((a) => nowMs - a.shownMs < ALERT_BANNER_MS) ?? null;
  const nextAlert = alerts.filter((a) => a.shownMs > nowMs).sort((a, b) => a.atMs - b.atMs)[0] ?? null;
  const rulesById = new Map(demo?.rules.map((r) => [r.id, r]));
  const goToAlert = (alert: DemoAlert) => seek(Math.max(0, alert.atMs - LEAD_IN_MS) / 1000);
  const zoneOverlay = (z: DemoZone, prefix: string, colour: string): DrawnPath[] => z.paths.map((d, j) => ({ key: `${prefix}-${j}`, d, colour, style: 'fill', title: sentence(z.name), group: prefix }));
  const overlays: DrawnPath[] = [
    ...(showZones ? (demo?.zones ?? []).flatMap((z, i) => zoneOverlay(z, `zone-${i}`, ZONE_COLOURS[i % ZONE_COLOURS.length]!)) : []),
    ...(demo?.rules ?? []).filter((r) => ticks[r.id] !== undefined).flatMap((r) => r.zones.flatMap((z, i) => zoneOverlay(z, `${r.id}-${i}`, RULE_ZONE_COLOUR))),
    ...(guideZones ?? []).flatMap((z, i) => zoneOverlay(z, `guide-${i}`, FOLLOW_COLOUR)),
  ];
  const togglePlaying = () => (video.current?.paused ? void video.current.play() : video.current?.pause());

  return (
    <div className='grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]'>
      <div className='min-w-0 space-y-6'>
      <Card className='min-w-0'>
        <CardContent className='space-y-4'>
          <div className={cn('relative aspect-video overflow-hidden rounded-lg bg-black', choosingAt !== null && 'hidden', banner && 'ring-destructive ring-4')}>
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
            {overlays.length > 0 && <Outlines width={clip.width} height={clip.height} paths={overlays} stroke={Math.max(2, clip.width / 360)} passThrough onPathClick={togglePlaying} />}
            {banner && (
              <div role='status' className='bg-destructive absolute inset-x-3 top-3 flex items-start gap-2 rounded-md px-3 py-2 text-sm font-medium text-white shadow'>
                <BellRing className='mt-0.5 size-4 shrink-0' />
                <span>{inLanguage(banner, language) ?? ruleLabel(rulesById.get(banner.rule))}</span>
              </div>
            )}
            {here && (
              <svg viewBox={`0 0 ${clip.width} ${clip.height}`} preserveAspectRatio='xMidYMid meet' className='pointer-events-none absolute inset-0 h-full w-full' aria-hidden>
                <path d={here.path} fillRule='evenodd' fill={FOLLOW_COLOUR} fillOpacity={0.3} stroke={FOLLOW_COLOUR} strokeWidth={Math.max(2, clip.width / 360)} strokeLinejoin='round' />
              </svg>
            )}
          </div>

          {choosingAt !== null ? (
            <Choosing clip={clip} frame={choosingAt} trackSeconds={trackSeconds} onCancel={() => setChoosingAt(null)} onFollowed={followed} />
          ) : (
            <>
              <Timeline length={length * 1000} play={time * 1000} onSeek={(ms) => seek(ms / 1000)} label={(ms) => duration(ms / 1000)}>
                {(at) => (
                  <>
                    {alerts.length > 0 && (
                      <div className='relative h-4' role='img' aria-label={`${alerts.length} alerts on this clip`}>
                        {alerts.map((a) => (
                          <span
                            key={`${a.rule}-${a.key}`}
                            title={`${duration(a.atMs / 1000)}: ${ruleLabel(rulesById.get(a.rule))}`}
                            className='absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45'
                            style={{ left: `${at(a.atMs)}%`, background: ALERT_COLOUR, opacity: a.shownMs <= nowMs ? 1 : 0.5 }}
                          />
                        ))}
                      </div>
                    )}
                    {shown && (
                      <div className='bg-muted/60 relative h-2 overflow-hidden rounded-full' role='img' aria-label={`When the ${shown.name} was in view`}>
                        {shown.spans.map((s) => {
                          const from = at((s.from / clip.fps) * 1000);
                          return <span key={s.from} className='absolute inset-y-0 rounded-full' style={{ left: `${from}%`, width: `${Math.max(at(((s.to + 1) / clip.fps) * 1000) - from, 0.5)}%`, background: FOLLOW_COLOUR }} />;
                        })}
                      </div>
                    )}
                  </>
                )}
              </Timeline>
              <div className='flex flex-wrap items-center gap-2'>
                <Button
                  size='sm'
                  variant='outline'
                  aria-label={playing ? 'Pause' : 'Play'}
                  onClick={togglePlaying}
                >
                  {playing ? <Pause /> : <Play />}
                  {playing ? 'Pause' : 'Play'}
                </Button>
                <Button size='sm' disabled={!models} onClick={startChoosing}>
                  <Search />
                  Search this frame
                </Button>
                {nextAlert && (
                  <Button size='sm' variant='outline' onClick={() => goToAlert(nextAlert)}>
                    <SkipForward />
                    Go to the next alert
                  </Button>
                )}
                {demo && demo.zones.length > 0 && (
                  <Button size='sm' variant='outline' aria-pressed={showZones} onClick={() => setShowZones((v) => !v)}>
                    {showZones ? 'Hide what setup outlined' : 'Show what setup outlined'}
                  </Button>
                )}
              </div>
              {!models && <NeedsKeys />}
              {trackSeconds !== null && models && <p className='text-muted-foreground text-xs'>Pause the clip where an item appears and search this frame. Streamatic can then track the item from {trackSeconds} seconds before that frame to {trackSeconds} seconds after it.</p>}
            </>
          )}
        </CardContent>
      </Card>
      {demo && (
          <DemoGuide
            clip={demo}
            added={(rule) => ticks[rule] !== undefined}
            onShowZones={setGuideZones}
            onTyped={refreshDemo}
            onAdd={(rule) => {
              setTicks((all) => ({ ...all, [rule]: 0 }));
              seek(0);
              void video.current?.play();
            }}
          />
      )}
      </div>

      <aside className='min-w-0 space-y-4'>
        {demo && (
          <>
            <RulesCard
              rules={demo.rules}
              ticks={ticks}
              onToggle={(rule, on) =>
                setTicks((all) => {
                  const { [rule.id]: _gone, ...rest } = all;
                  // A typed rule runs from the clip's start; an offered one from the moment it is ticked, as a newly saved rule does.
                  return on ? { ...rest, [rule.id]: rule.kind === 'typed' ? 0 : nowMs } : rest;
                })
              }
            />
            <AlertsCard alerts={reached} rules={rulesById} ticking={tickList.length > 0} next={nextAlert} language={language} onLanguage={setLanguage} onGoTo={goToAlert} telegram={<TelegramAlerts telegram={telegram} problem={telegramProblem} />} />
          </>
        )}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Found in this clip</CardTitle>
              <CardDescription>Select one to see it in the clip.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {follows.length === 0 ? (
              <p className='text-muted-foreground text-sm'>Nothing has been searched for in this clip yet.</p>
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

const ruleLabel = (rule: DemoRule | undefined) => (!rule ? 'Alert' : rule.kind === 'typed' ? rule.text : rule.name);

function RulesCard({ rules, ticks, onToggle }: { rules: DemoRule[]; ticks: Record<string, number>; onToggle: (rule: DemoRule, on: boolean) => void }) {
  const usable = rules.filter((r) => r.status === 'ready');
  const notReady = rules.filter((r) => r.status !== 'ready');
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Rules</CardTitle>
          <CardDescription>Select a rule and play the clip. A rule applies from the moment it is selected, as a newly saved rule does.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <ul className='space-y-2'>
          {usable.map((rule) => (
            <li key={rule.id}>
              <label className='hover:bg-accent flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm transition-colors'>
                <input type='checkbox' className='accent-primary mt-0.5 size-4' checked={ticks[rule.id] !== undefined} onChange={(e) => onToggle(rule, e.target.checked)} />
                <span className='min-w-0'>
                  <span className='font-medium'>{rule.kind === 'typed' ? rule.text : rule.name}</span>
                  {rule.kind === 'typed' && <span className='text-muted-foreground block text-xs'>Your rule. It runs from the start of the clip.</span>}
                  {rule.readsAs && <span className='text-muted-foreground mt-0.5 block text-xs'>Reads as: {rule.readsAs}</span>}
                </span>
              </label>
            </li>
          ))}
          {notReady.map((rule) => (
            <li key={rule.id} className='flex items-start gap-2.5 rounded-lg border border-dashed p-3 text-sm'>
              {RULE_FINISHED.has(rule.status) ? <CircleAlert className='text-muted-foreground mt-0.5 size-4 shrink-0' /> : <LoaderCircle className='text-primary mt-0.5 size-4 shrink-0 animate-spin' />}
              <span className='min-w-0'>
                <span className='font-medium'>{rule.text}</span>
                <span className='text-muted-foreground mt-0.5 block text-xs'>{RULE_FINISHED.has(rule.status) ? (rule.reason ?? 'This rule could not be added.') : 'Streamatic is running this rule over the clip. It will be selected when it is ready.'}</span>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// An alert's words in the language chosen; an alert not written in it stays in English.
const inLanguage = (alert: DemoAlert, language: AlertLanguage) => (language === 'english' ? null : (alert.captions[language] ?? null));

function AlertsCard({ alerts, rules, ticking, next, language, onLanguage, onGoTo, telegram }: { alerts: DemoAlert[]; rules: Map<string, DemoRule>; ticking: boolean; next: DemoAlert | null; language: AlertLanguage; onLanguage: (language: AlertLanguage) => void; onGoTo: (alert: DemoAlert) => void; telegram: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <div className='space-y-3'>
          <div>
            <CardTitle>Alerts</CardTitle>
            <CardDescription>What Streamatic’s rules really raised on this clip. Here each appears 3 seconds after its moment. A live camera takes longer, since its pictures must first be uploaded and read.</CardDescription>
          </div>
          <LanguageChoice value={language} onChange={onLanguage} />
          {telegram}
        </div>
      </CardHeader>
      <CardContent>
        {alerts.length === 0 && (
          <p className='text-muted-foreground text-sm'>{!ticking ? 'Select a rule to see its alerts.' : next ? `No alerts yet. The next alert appears at ${duration(next.shownMs / 1000)}.` : 'This rule raises no further alerts from this point. Select it earlier in the clip, or select another rule.'}</p>
        )}
        <ul className='space-y-3'>
          {alerts.map((a) => (
            <li key={`${a.rule}-${a.key}`}>
              <button type='button' onClick={() => onGoTo(a)} className='hover:bg-accent w-full rounded-lg border p-2 text-left transition-colors'>
                {a.picture && <img src={a.picture} alt={a.caption ?? 'The picture this alert carries'} className='mb-2 aspect-video w-full rounded object-cover' loading='lazy' />}
                <span className='block text-sm font-medium'>{ruleLabel(rules.get(a.rule))}</span>
                {inLanguage(a, language) ? (
                  <span lang={language === 'yoruba' ? 'yo' : 'pcm'} className='mt-1 block text-sm'>
                    {inLanguage(a, language)}
                  </span>
                ) : (
                  a.caption && <span className='text-muted-foreground mt-1 line-clamp-2 text-xs'>{a.caption}</span>
                )}
                <span className='text-muted-foreground mt-1 block text-xs'>
                  Happened at {duration(a.atMs / 1000)}.
                </span>
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// The follow mode, on one paused frame: everything found is outlined, and the person selects what to follow.
function Choosing({ clip, frame, trackSeconds, onCancel, onFollowed }: { clip: Clip; frame: number; trackSeconds: number | null; onCancel: () => void; onFollowed: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [things, setThings] = useState<Thing[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [word, setWord] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<FollowJob | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [box, setBox] = useState<DrawnBox | null>(null);

  const name = useQuery({ queryKey: ['name-frame', clip.id, frame], queryFn: () => api.outline(clip.id, frame, {}), retry: false, staleTime: Infinity });
  useEffect(() => {
    if (name.data) setThings(name.data.things);
  }, [name.data]);

  const search = useMutation({
    mutationFn: (w: string) => api.outline(clip.id, frame, { word: w }),
    onSuccess: (result, w) => {
      setThings(result.things);
      setNote(result.found === 0 ? `No item was found for “${w}”. Enter another name, or select the item on the picture.` : null);
      if (result.found) setWord('');
    },
  });
  const outliningBox = useMutation({
    mutationFn: (drawn: DrawnBox) => api.outline(clip.id, frame, { box: drawn }),
    onSuccess: (result) => {
      setThings(result.things);
      setSelected(result.selected ?? null);
      if (result.selected) {
        setDrawing(false);
        setBox(null);
        setNote(null);
      } else {
        setNote('No item could be outlined in this box. Fit the box closely around one item and try again.');
      }
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
  const selectedThing = things.find((t) => t.id === selected) ?? null;
  const busyLabel = running
    ? `Tracking the ${selectedThing?.name ?? job?.name ?? 'item'}`
    : name.isPending
      ? 'Finding the items in this frame'
      : search.isPending
        ? 'Searching this frame'
        : outliningBox.isPending
          ? 'Outlining the item in the box'
          : null;
  const words = [...new Set(things.map((t) => t.name))];
  const paths: DrawnPath[] = things.map((t) => ({
    key: t.id,
    d: t.path,
    colour: ZONE_COLOURS[words.indexOf(t.name) % ZONE_COLOURS.length]!,
    style: t.id === selected ? 'selected' : 'fill',
    title: sentence(t.name),
    onSelect: running ? undefined : () => setSelected(t.id),
  }));

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    if (word.trim()) search.mutate(word.trim());
  };
  const stopDrawing = () => {
    setDrawing(false);
    setBox(null);
    setNote(null);
  };
  // A box under this size would be refused, and is more likely a stray touch than a choice.
  const boxUsable = box !== null && box.right - box.left >= SMALLEST_BOX && box.bottom - box.top >= SMALLEST_BOX;

  const error = name.error ?? search.error ?? outliningBox.error ?? start.error;
  return (
    <div className='space-y-4'>
      <PictureFrame src={clipPictureUrl(clip.id, frame)} alt={`Frame ${frame} of ${clip.name}`} paths={drawing ? [] : paths}>
        {drawing && <BoxDrawer width={clip.width} height={clip.height} box={box} onChange={setBox} />}
        {busyLabel && <PictureBusy label={busyLabel} />}
      </PictureFrame>

      {running ? (
        <p className='text-muted-foreground text-xs'>
          {job?.framesSeen ? `Found on ${job.framesSeen.toLocaleString('en-GB')} frames so far. ` : ''}
          {trackSeconds === null ? 'This usually takes under a minute.' : `Tracking covers ${trackSeconds} seconds either side of this frame, and usually takes about a minute.`}
        </p>
      ) : drawing ? (
        <>
          <p className='text-muted-foreground text-sm'>
            {box
              ? 'Drag the box to move it, or drag a corner or side to resize it. Fit it closely around one item. Streamatic outlines that one item only, and does not search for everything inside the box.'
              : 'Drag on the picture to draw a box around one item.'}
          </p>
          {note && <Notice>{note}</Notice>}
          {error && <Notice tone='error'>{error.message}</Notice>}
          <div className='flex flex-wrap items-center gap-2'>
            <Button size='sm' disabled={!boxUsable || busyLabel !== null} onClick={() => box && outliningBox.mutate(box)}>
              <SquareDashed />
              Outline this item
            </Button>
            <Button size='sm' variant='outline' disabled={!box || busyLabel !== null} onClick={() => setBox(null)}>
              Clear box
            </Button>
            <Button size='sm' variant='outline' disabled={busyLabel !== null} onClick={stopDrawing}>
              <X />
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          {!name.isPending && (
            <p className='text-muted-foreground text-sm'>
              {things.length === 0 ? 'No items were outlined on this frame.' : 'Streamatic outlined these items on this frame. Select an outline to track it.'} If an item is not outlined, enter its name or draw a box around it.
            </p>
          )}
          <form onSubmit={onSearch} className='flex flex-wrap items-end gap-2'>
            <Label className='min-w-48 flex-1 flex-col items-start gap-1.5'>
              Item name
              <Input value={word} maxLength={60} onChange={(e) => setWord(e.target.value)} placeholder='For example, red car or backpack' />
            </Label>
            <Button type='submit' variant='outline' disabled={!word.trim() || search.isPending}>
              {search.isPending ? <LoaderCircle className='animate-spin' /> : <Search />}
              Search
            </Button>
          </form>
          {note && <Notice>{note}</Notice>}
          {job?.state === 'failed' && <Notice tone='error'>This could not be tracked. Please try again.</Notice>}
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
              {!selectedThing ? 'Select an item to track' : trackSeconds === null ? `Track the ${selectedThing.name} through the clip` : `Track the ${selectedThing.name}`}
            </Button>
            <Button
              size='sm'
              variant='outline'
              onClick={() => {
                setDrawing(true);
                setNote(null);
              }}
            >
              <SquareDashed />
              Draw a box
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
