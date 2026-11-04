import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, BellRing, CircleAlert, Crosshair, Eye, EyeOff, LoaderCircle, Pause, Play, RotateCcw, Search, SkipForward, SquareDashed, Trash2, X } from 'lucide-react';
import { BoxDrawer, type DrawnBox } from '@/components/box-drawer';
import { Outlines, PictureBusy, PictureFrame, ZONE_COLOURS, type DrawnPath } from '@/components/picture-frame';
import { DemoGuide, type GuideFinding } from '@/components/demo-guide';
import { LanguageChoice, type AlertLanguage } from '@/components/language-choice';
import { NeedsKeys } from '@/components/needs-keys';
import { TelegramAlerts, useTelegramLink } from '@/components/telegram-alerts';
import { PageHeader } from '@/components/layout/page-header';
import { Timeline } from '@/components/timeline';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { Link } from '@/components/ui/link';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { api, clipPictureUrl, clipVideoUrl, type Clip, type DemoAlert, type DemoClip, type DemoRule, type DemoZone, type Follow, type FollowJob, type Thing } from '@/lib/api';
import { useAbilities } from '@/lib/abilities';
import { cn } from '@/lib/cn';
import { navigate } from '@/lib/router';
import { RULE_FINISHED, progressOf, rulesChosenInSetup, saveProgress, useRefreshRulesBeingAdded } from '@/lib/setup-progress';
import { sentence } from '@/lib/time';

const POLL_MS = 1_000;
const ALERTS_WHILE_READING_MS = 1_500;
const FOLLOW_COLOUR = '#e8c547';
// Gold first, then colours that stay apart on a picture by day or on infrared; red is kept for alerts.
const FOLLOW_COLOURS = [FOLLOW_COLOUR, '#34d399', '#f472b6', '#22d3ee', '#fb923c', '#a78bfa', '#a3e635', '#94a3b8'];
const MOST_TRACKED_AT_ONCE = 4;
// One per selected rule, red first, so that one rule alone stays alert red. All hold up on the timeline in both themes and under white words on the banner.
const ALERT_COLOURS = ['#ef4444', '#3b82f6', '#16a34a', '#c026d3', '#ea580c', '#8b5cf6', '#0d9488', '#64748b'];
const RULE_ZONE_COLOUR = '#538ee7';
// How long an alert stays over the picture once it has reached the person.
const ALERT_BANNER_MS = 6_000;
// Going to an alert starts a little before the moment it is about, so the moment itself is seen.
const LEAD_IN_MS = 3_000;
// A longer step than this between readings of the clock is a jump, not the clip playing through a moment.
const LONGEST_PLAYED_STEP_MS = 2_000;
const REFRESH_LINKED_MS = 15_000;
const SMALLEST_BOX = 8;

// A rule keeps its colour while it stays selected, whichever others come and go, so the eye need not learn them again.
function ruleColourSlots(held: Map<string, number>, selected: string[]): Map<string, number> {
  if (selected.length === 1) return new Map([[selected[0]!, 0]]);
  const slots = new Map([...held].filter(([rule]) => selected.includes(rule)));
  for (const rule of selected) {
    if (slots.has(rule)) continue;
    let free = 0;
    while ([...slots.values()].includes(free)) free += 1;
    slots.set(rule, free);
  }
  return slots;
}

function duration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export function ClipPage({ id, isPublic = false, trackSeconds = null }: { id: string; isPublic?: boolean; trackSeconds?: number | null }) {
  const clips = useQuery({ queryKey: ['clips'], queryFn: api.clips });
  const follows = useQuery({ queryKey: ['follows', id], queryFn: () => api.follows(id) });
  const demo = useQuery({ queryKey: ['demo-clip', id], queryFn: () => api.demoClip(id), enabled: isPublic });
  const clip = clips.data?.find((c) => c.id === id);
  // Everything on a clip waits on its camera being set up, and the person is brought back to what they were doing.
  const [cameFor] = useState(() => location.pathname + location.search);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const needsSetup = isPublic && demo.data?.setUpLive === false;
  useEffect(() => {
    if (needsSetup) navigate(`/setup/${encodeURIComponent(id)}?next=${encodeURIComponent(cameFor)}`, { replace: true });
  }, [needsSetup, id, cameFor]);
  // A sentence sent here by the page that chose this camera. It leaves the address at once, so reloading does not spend on it again.
  const [ask] = useState(() => new URLSearchParams(location.search).get('ask'));
  // An alert selected on the events page: its rule, and the moment to open at.
  const [opened] = useState(() => {
    const query = new URLSearchParams(location.search);
    const rule = query.get('rule');
    const at = Number(query.get('at'));
    return rule && Number.isFinite(at) ? { rule, atMs: at } : null;
  });
  useEffect(() => {
    if (location.search) history.replaceState(null, '', location.pathname);
  }, []);

  if (clips.isPending || (isPublic && (demo.isPending || needsSetup))) return <Skeleton className='h-[32rem] rounded-xl' />;
  if (!clip) return <Notice tone='error'>This clip could not be found.</Notice>;
  return (
    <>
      <PageHeader
        trail={[{ href: '/clips', label: isPublic ? 'Clips' : 'Search' }]}
        icon={<Search />}
        title={clip.name}
        description={isPublic ? 'Describe a rule, or select one, and play the clip. Pause on any frame to search it.' : 'Pause on a frame where it appears, then search for it.'}
        actions={
          isPublic && (
            <Button size='sm' variant='outline' onClick={() => setConfirmingReset(true)}>
              <RotateCcw />
              Reset this camera
            </Button>
          )
        }
      />
      {confirmingReset && <ResetThisCamera id={clip.id} onCancel={() => setConfirmingReset(false)} />}
      <ClipWatch key={clip.id} clip={clip} follows={follows.data ?? []} demo={demo.data ?? null} trackSeconds={trackSeconds} ask={ask} opened={opened} />
    </>
  );
}

function ResetThisCamera({ id, onCancel }: { id: string; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const added = progressOf(id).added;
  const reset = useMutation({
    mutationFn: async () => {
      await Promise.all(added.map((rule) => api.removeClipRule(id, rule).catch(() => null)));
      return api.resetDemoZones(id);
    },
    onSuccess: async () => {
      saveProgress(id, null);
      // Leaves first, so this clip does not ask for setup again on the way out.
      navigate('/setup');
      await queryClient.invalidateQueries();
    },
  });
  return (
    <Notice className='mb-4'>
      <p>
        Reset this camera? It returns to not set up, and your zone changes on it are removed.{added.length > 0 ? ` The ${added.length === 1 ? 'rule' : `${added.length} rules`} added in setup ${added.length === 1 ? 'is' : 'are'} removed.` : ''} Other cameras are not changed.
      </p>
      {reset.isError && <p className='text-destructive mt-1 text-xs'>{reset.error.message}</p>}
      <div className='mt-2 flex flex-wrap gap-2'>
        <Button size='sm' disabled={reset.isPending} onClick={() => reset.mutate()}>
          {reset.isPending && <LoaderCircle className='animate-spin' />}
          Reset this camera
        </Button>
        <Button size='sm' variant='outline' disabled={reset.isPending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Notice>
  );
}

function ClipWatch({ clip, follows, demo, trackSeconds, ask, opened }: { clip: Clip; follows: Follow[]; demo: DemoClip | null; trackSeconds: number | null; ask: string | null; opened: { rule: string; atMs: number } | null }) {
  const queryClient = useQueryClient();
  const { models } = useAbilities();
  const video = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const pictureCardRef = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [shownIds, setShownIds] = useState<string[]>([]);
  const [choosingAt, setChoosingAt] = useState<number | null>(null);
  // What the guide found, waiting on the picture to be selected and tracked.
  const [guided, setGuided] = useState<{ item: string; found: string[]; things: Thing[] } | null>(null);
  const [finding, setFinding] = useState<GuideFinding | null>(null);
  // The colour goes with the item, whichever others are showing with it.
  const colourOf = useCallback((id: string) => FOLLOW_COLOURS[Math.max(0, follows.findIndex((f) => f.id === id)) % FOLLOW_COLOURS.length]!, [follows]);
  const shown = useMemo(() => follows.filter((f) => shownIds.includes(f.id)), [follows, shownIds]);
  // Each ticked rule with the moment on the clip it was ticked at.
  const [ticks, setTicks] = useState<Record<string, number>>(() => (opened ? { [opened.rule]: 0 } : {}));
  const [showZones, setShowZones] = useState(false);
  const [showTracked, setShowTracked] = useState(true);
  const [showRuleOutlines, setShowRuleOutlines] = useState(true);
  const [language, setLanguage] = useState<AlertLanguage>('english');
  const [guideZones, setGuideZones] = useState<DemoZone[] | null>(null);
  const tickList = useMemo(() => Object.entries(ticks).map(([rule, armedMs]) => ({ rule, armedMs })), [ticks]);
  const colourSlots = useRef(new Map<string, number>());
  const colourOfRule = useMemo(() => {
    const slots = ruleColourSlots(colourSlots.current, tickList.map((t) => t.rule));
    colourSlots.current = slots;
    return (rule: string) => ALERT_COLOURS[(slots.get(rule) ?? 0) % ALERT_COLOURS.length]!;
  }, [tickList]);
  // How much of the clip a new rule has read so far, while one is running.
  const [readShare, setReadShare] = useState<number | null>(null);
  const alertsFound = useQuery({
    queryKey: ['demo-alerts', clip.id, tickList],
    queryFn: () => api.demoAlerts(clip.id, tickList),
    enabled: demo !== null && tickList.length > 0,
    placeholderData: (previous) => previous,
    refetchInterval: readShare !== null ? ALERTS_WHILE_READING_MS : false,
  });
  const alerts = useMemo(() => (tickList.length > 0 ? (alertsFound.data?.alerts ?? []) : []), [tickList, alertsFound.data]);
  // The rule's final alerts are in place once it stops reading.
  const wasReading = useRef(false);
  useEffect(() => {
    if (wasReading.current && readShare === null) void queryClient.invalidateQueries({ queryKey: ['demo-alerts', clip.id] });
    wasReading.current = readShare !== null;
  }, [readShare, queryClient, clip.id]);

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
  useEffect(() => {
    if (opened) seek(Math.max(0, opened.atMs - LEAD_IN_MS) / 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const length = clip.frames / clip.fps;
  const currentFrame = Math.min(clip.frames - 1, Math.floor(time * clip.fps + 0.001));
  const framesOfShown = useMemo(() => shown.map((f) => ({ id: f.id, frames: new Map(f.frames.map((at) => [at.frame, at])) })), [shown]);
  const here = framesOfShown.flatMap(({ id, frames }) => {
    const at = frames.get(currentFrame);
    return at ? [{ id, path: at.path }] : [];
  });

  const startChoosing = () => {
    video.current?.pause();
    setGuided(null);
    setChoosingAt(currentFrame);
  };
  const stopChoosing = () => {
    setChoosingAt(null);
    setGuided(null);
    setFinding(null);
  };
  const followed = (found: Follow[]) => {
    setChoosingAt(null);
    setShownIds(found.map((f) => f.id));
    if (!guided) return;
    // The guide was asked to find it, so it plays from where the item comes into view.
    const firstInView = Math.min(...found.flatMap((f) => f.spans.map((s) => s.from)));
    setGuided(null);
    setFinding({ stage: 'done', item: guided.item, follows: found, fps: clip.fps });
    if (Number.isFinite(firstInView)) {
      seek(firstInView / clip.fps);
      void video.current?.play();
    }
    playerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const findItem = async (item: string, words: string[]) => {
    video.current?.pause();
    const frame = Math.min(clip.frames - 1, Math.floor((video.current?.currentTime ?? 0) * clip.fps + 0.001));
    setFinding({ stage: 'searching', item });
    setChoosingAt(null);
    const search = await api.searchClip(clip.id, frame, { item, words });
    if (search.found.length === 0) {
      setFinding({ stage: 'none', item, looks: search.looks });
      return;
    }
    setGuided({ item, found: search.found, things: search.things });
    setChoosingAt(search.frame);
    setFinding(search.found.length === 1 ? { stage: 'tracking', item, framesDone: 0, framesTotal: 0, at: search.frame / clip.fps } : { stage: 'select', item, count: search.found.length, at: search.frame / clip.fps });
    requestAnimationFrame(() => pictureCardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };
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
      api.sendAlertToTelegram(clip.id, alert.rule, alert.key).then(
        () => setTelegramProblem(null),
        (error: Error) => setTelegramProblem(error.message),
      );
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
  const ruleOutlines: DrawnPath[] = [
    ...(demo?.rules ?? []).filter((r) => ticks[r.id] !== undefined).flatMap((r) => r.zones.flatMap((z, i) => zoneOverlay(z, `${r.id}-${i}`, RULE_ZONE_COLOUR))),
    ...(guideZones ?? []).flatMap((z, i) => zoneOverlay(z, `guide-${i}`, FOLLOW_COLOUR)),
  ];
  const overlays: DrawnPath[] = [
    ...(showZones ? (demo?.zones ?? []).flatMap((z, i) => zoneOverlay(z, `zone-${i}`, ZONE_COLOURS[i % ZONE_COLOURS.length]!)) : []),
    ...(showRuleOutlines ? ruleOutlines : []),
  ];
  const togglePlaying = () => (video.current?.paused ? void video.current.play() : video.current?.pause());

  return (
    <div className='grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]'>
      <div className='min-w-0 space-y-6'>
      <Card ref={pictureCardRef} className='min-w-0'>
        <CardContent className='space-y-4'>
          <div ref={playerRef} className={cn('relative aspect-video overflow-hidden rounded-lg bg-black', choosingAt !== null && 'hidden', banner && 'ring-4')} style={banner ? ({ '--tw-ring-color': colourOfRule(banner.rule) } as CSSProperties) : undefined}>
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
              <div role='status' className='absolute inset-x-3 top-3 flex items-start gap-2 rounded-md px-3 py-2 text-sm font-medium text-white shadow' style={{ background: colourOfRule(banner.rule) }}>
                <BellRing className='mt-0.5 size-4 shrink-0' />
                <span>{inLanguage(banner, language) ?? ruleLabel(rulesById.get(banner.rule))}</span>
              </div>
            )}
            {showTracked && here.length > 0 && (
              <svg viewBox={`0 0 ${clip.width} ${clip.height}`} preserveAspectRatio='xMidYMid meet' className='pointer-events-none absolute inset-0 h-full w-full' aria-hidden>
                {here.map(({ id, path }) => (
                  <path key={id} d={path} fillRule='evenodd' fill={colourOf(id)} fillOpacity={0.3} stroke={colourOf(id)} strokeWidth={Math.max(2, clip.width / 360)} strokeLinejoin='round' />
                ))}
              </svg>
            )}
          </div>

          {choosingAt !== null ? (
            <Choosing
              key={`${choosingAt}-${guided?.item ?? ''}`}
              clip={clip}
              frame={choosingAt}
              trackSeconds={trackSeconds}
              guided={guided}
              onCancel={stopChoosing}
              onFollowed={followed}
              onProgress={(framesDone, framesTotal) => guided && setFinding({ stage: 'tracking', item: guided.item, framesDone, framesTotal, at: choosingAt / clip.fps })}
            />
          ) : (
            <>
              <Timeline length={length * 1000} play={time * 1000} onSeek={(ms) => seek(ms / 1000)} label={(ms) => duration(ms / 1000)}>
                {(at) => (
                  <>
                    {readShare !== null && (
                      <div
                        className='bg-muted/60 relative h-1.5 overflow-hidden rounded-full'
                        role='progressbar'
                        aria-label='How much of the clip the new rule has read'
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(readShare * 100)}
                      >
                        <span className='bg-primary absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 motion-reduce:transition-none' style={{ width: `${readShare * 100}%` }} />
                      </div>
                    )}
                    {alerts.length > 0 && (
                      <div className='relative h-4' role='img' aria-label={`${alerts.length} ${alerts.length === 1 ? 'alert' : 'alerts'} on this clip`}>
                        {alerts.map((a) => (
                          <span
                            key={`${a.rule}-${a.key}`}
                            title={`${duration(a.atMs / 1000)}: ${ruleLabel(rulesById.get(a.rule))}`}
                            className='absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45'
                            style={{ left: `${at(a.atMs)}%`, background: colourOfRule(a.rule), opacity: a.shownMs <= nowMs ? 1 : 0.5 }}
                          />
                        ))}
                      </div>
                    )}
                    {shown.map((follow) => (
                      <div key={follow.id} className='bg-muted/60 relative h-2 overflow-hidden rounded-full' role='img' aria-label={`When the ${follow.name} was in view`}>
                        {follow.spans.map((s) => {
                          const from = at((s.from / clip.fps) * 1000);
                          return <span key={s.from} className='absolute inset-y-0 rounded-full' style={{ left: `${from}%`, width: `${Math.max(at(((s.to + 1) / clip.fps) * 1000) - from, 0.5)}%`, background: colourOf(follow.id) }} />;
                        })}
                      </div>
                    ))}
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
                {ruleOutlines.length > 0 && (
                  <Button size='sm' variant='outline' aria-pressed={showRuleOutlines} onClick={() => setShowRuleOutlines((v) => !v)}>
                    {showRuleOutlines ? <EyeOff /> : <Eye />}
                    {showRuleOutlines ? 'Hide the rule’s outline' : 'Show the rule’s outline'}
                  </Button>
                )}
                {shown.length > 0 && (
                  <Button size='sm' variant='outline' aria-pressed={showTracked} onClick={() => setShowTracked((v) => !v)}>
                    {showTracked ? <EyeOff /> : <Eye />}
                    {showTracked ? 'Hide the tracked outlines' : 'Show the tracked outlines'}
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
          cameraName={clip.name}
          ask={ask}
          onRuleRunning={(rule) => setTicks((all) => ({ ...all, [rule]: 0 }))}
          onRuleProgress={setReadShare}
          onRuleDropped={(rule) =>
            setTicks((all) => {
              const { [rule]: _gone, ...rest } = all;
              return rest;
            })
          }
          onPlayAlert={(firstAlert) => {
            seek(Math.max(0, firstAlert.atMs - LEAD_IN_MS) / 1000);
            void video.current?.play();
            playerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }}
          onShowZones={(zones) => {
            setGuideZones(zones);
            if (zones) playerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }}
          onTyped={refreshDemo}
          finding={finding}
          onFindItem={findItem}
          onStopFinding={stopChoosing}
          onMoment={(atMs) => {
            seek(Math.max(0, atMs - LEAD_IN_MS) / 1000);
            void video.current?.play();
            playerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
              colourOf={colourOfRule}
              onToggle={(rule, on) =>
                setTicks((all) => {
                  const { [rule.id]: _gone, ...rest } = all;
                  // A typed rule runs from the clip's start; an offered one from the moment it is ticked, as a newly saved rule does.
                  return on ? { ...rest, [rule.id]: rule.kind === 'typed' ? 0 : nowMs } : rest;
                })
              }
              clip={clip.id}
              onDeleted={(rule) => {
                setTicks(({ [rule]: _gone, ...rest }) => rest);
                setGuideZones(null);
                refreshDemo();
              }}
            />
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Alerts</CardTitle>
                  <CardDescription>Each alert appears on the picture 3 seconds after its moment. A live camera takes longer, since its pictures must first be uploaded and read.</CardDescription>
                </div>
              </CardHeader>
              <CardContent className='space-y-3'>
                <p className='text-sm' role='status'>
                  {tickList.length === 0 ? 'Select a rule to see its alerts.' : nextAlert ? `The next alert appears at ${duration(nextAlert.shownMs / 1000)}.` : 'This rule raises no further alerts from this point. Select it earlier in the clip, or select another rule.'}
                </p>
                <LanguageChoice value={language} onChange={setLanguage} />
                <TelegramAlerts telegram={telegram} problem={telegramProblem} />
                <Link href='/events' className='text-primary inline-flex items-center gap-1.5 text-sm font-medium hover:underline [&_svg]:size-4'>
                  See every alert on Events
                  <ArrowRight />
                </Link>
              </CardContent>
            </Card>
          </>
        )}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Found in this clip</CardTitle>
              <CardDescription>Select any of them to see them in the clip together.</CardDescription>
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
                      aria-pressed={shownIds.includes(f.id)}
                      onClick={() => {
                        setChoosingAt(null);
                        const on = !shownIds.includes(f.id);
                        setShownIds((all) => (on ? [...all, f.id] : all.filter((id) => id !== f.id)));
                        if (on && f.spans[0]) seek(f.spans[0].from / clip.fps);
                      }}
                      className={cn('hover:bg-accent w-full rounded-lg border p-3 text-left text-sm transition-colors', shownIds.includes(f.id) && 'border-primary')}
                    >
                      <span className='flex items-center gap-2 font-medium'>
                        <span className='size-2.5 shrink-0 rounded-full' style={{ background: colourOf(f.id) }} aria-hidden />
                        {sentence(f.name)}
                      </span>
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

// Only a visitor's own rule can be deleted, once it has finished; the rules the clip comes with are simply left unselected.
function DeleteRule({ clip, rule, onDeleted }: { clip: string; rule: DemoRule; onDeleted: (rule: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({ mutationFn: () => api.removeClipRule(clip, rule.id), onSuccess: () => onDeleted(rule.id) });
  if (rule.kind !== 'typed' || !RULE_FINISHED.has(rule.status)) return null;
  if (!confirming) {
    return (
      <Button size='sm' variant='ghost' className='text-muted-foreground mt-1 h-7 px-2 text-xs' onClick={() => setConfirming(true)}>
        <Trash2 />
        Delete
      </Button>
    );
  }
  return (
    <div className='mt-1 space-y-1.5 px-1'>
      <p className='text-xs'>Delete this rule? Its alerts are removed too.</p>
      {remove.isError && <p className='text-destructive text-xs'>{remove.error.message}</p>}
      <div className='flex flex-wrap gap-2'>
        <Button size='sm' className='h-7 text-xs' disabled={remove.isPending} onClick={() => remove.mutate()}>
          {remove.isPending && <LoaderCircle className='animate-spin' />}
          Delete
        </Button>
        <Button size='sm' variant='outline' className='h-7 text-xs' disabled={remove.isPending} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function RulesCard({ rules, ticks, colourOf, onToggle, clip, onDeleted }: { rules: DemoRule[]; ticks: Record<string, number>; colourOf: (rule: string) => string; onToggle: (rule: DemoRule, on: boolean) => void; clip: string; onDeleted: (rule: string) => void }) {
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
                {ticks[rule.id] !== undefined && <span className='mt-1 size-2.5 shrink-0 rotate-45' style={{ background: colourOf(rule.id) }} aria-hidden />}
                <span className='min-w-0'>
                  <span className='font-medium'>{rule.kind === 'typed' ? rule.text : rule.name}</span>
                  {rule.kind === 'typed' && <span className='text-muted-foreground block text-xs'>Your rule. It runs from the start of the clip.</span>}
                  {rule.readsAs && <span className='text-muted-foreground mt-0.5 block text-xs'>Reads as: {rule.readsAs}</span>}
                </span>
              </label>
              <DeleteRule clip={clip} rule={rule} onDeleted={onDeleted} />
            </li>
          ))}
          {notReady.map((rule) => (
            <li key={rule.id}>
            <div className='flex items-start gap-2.5 rounded-lg border border-dashed p-3 text-sm'>
              {RULE_FINISHED.has(rule.status) ? <CircleAlert className='text-muted-foreground mt-0.5 size-4 shrink-0' /> : <LoaderCircle className='text-primary mt-0.5 size-4 shrink-0 animate-spin' />}
              <span className='min-w-0'>
                <span className='font-medium'>{rule.text}</span>
                <span className='text-muted-foreground mt-0.5 block text-xs'>{RULE_FINISHED.has(rule.status) ? (rule.reason ?? 'This rule could not be added.') : 'Streamatic is running this rule over the clip. It will be selected when it is ready.'}</span>
              </span>
            </div>
              <DeleteRule clip={clip} rule={rule} onDeleted={onDeleted} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// An alert's words in the language chosen; an alert not written in it stays in English.
const inLanguage = (alert: DemoAlert, language: AlertLanguage) => (language === 'english' ? null : (alert.captions[language] ?? null));

// The follow mode, on one paused frame: everything found is outlined, and the person selects what to follow. Sent by the guide,
// it holds only what the guide found, without naming the frame, and one item is tracked without being asked.
function Choosing({
  clip,
  frame,
  trackSeconds,
  guided,
  onCancel,
  onFollowed,
  onProgress,
}: {
  clip: Clip;
  frame: number;
  trackSeconds: number | null;
  guided: { item: string; found: string[]; things: Thing[] } | null;
  onCancel: () => void;
  onFollowed: (follows: Follow[]) => void;
  onProgress: (framesDone: number, framesTotal: number) => void;
}) {
  const queryClient = useQueryClient();
  const [things, setThings] = useState<Thing[]>(() => guided?.things.filter((t) => guided.found.includes(t.id)) ?? []);
  const [selected, setSelected] = useState<string[]>([]);
  const [word, setWord] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<FollowJob | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [box, setBox] = useState<DrawnBox | null>(null);

  const name = useQuery({ queryKey: ['name-frame', clip.id, frame], queryFn: () => api.outline(clip.id, frame, {}), retry: false, staleTime: Infinity, enabled: guided === null });
  const naming = guided === null && name.isPending;
  useEffect(() => {
    if (name.data) setThings(name.data.things);
  }, [name.data]);
  const toggle = (id: string) => setSelected((all) => (all.includes(id) ? all.filter((other) => other !== id) : all.length < MOST_TRACKED_AT_ONCE ? [...all, id] : all));

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
      if (result.selected) {
        const drawn = result.selected;
        setSelected((all) => (all.includes(drawn) ? all : [...all, drawn].slice(-MOST_TRACKED_AT_ONCE)));
        setDrawing(false);
        setBox(null);
        setNote(null);
      } else {
        setNote('No item could be outlined in this box. Fit the box closely around one item and try again.');
      }
    },
  });
  const start = useMutation({
    mutationFn: (ids: string[]) => api.startFollow(clip.id, frame, ids),
    onSuccess: ({ id }) => setJobId(id),
  });
  const tracked = (ids: string[]) => {
    setSelected(ids);
    setJob(null);
    setJobId(null);
    start.mutate(ids);
  };

  // One item found by the guide needs no choosing.
  const startedByGuide = useRef(false);
  useEffect(() => {
    if (!guided || guided.found.length !== 1 || startedByGuide.current) return;
    startedByGuide.current = true;
    tracked(guided.found);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guided]);

  const latestCallbacks = useRef({ onFollowed, onProgress });
  latestCallbacks.current = { onFollowed, onProgress };
  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    const poll = async () => {
      const latest = await api.followJob(clip.id, jobId).catch(() => null);
      if (stopped) return;
      if (latest) setJob(latest);
      if (latest?.state === 'running') latestCallbacks.current.onProgress(latest.framesDone, latest.framesTotal);
      if (latest?.state === 'done') {
        await queryClient.invalidateQueries({ queryKey: ['follows', clip.id] });
        latestCallbacks.current.onFollowed(latest.follows);
        return;
      }
      if (latest?.state !== 'failed') setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
    };
  }, [jobId, clip.id, queryClient]);

  const running = (jobId !== null && job?.state !== 'failed') || start.isPending;
  const selectedThings = things.filter((t) => selected.includes(t.id));
  const trackingWhat = selectedThings.length === 1 ? `the ${selectedThings[0]!.name}` : `${selectedThings.length} items`;
  const framesDone = job?.state === 'running' ? job.framesDone : 0;
  const busyLabel = running
    ? framesDone === 0
      ? `Preparing to track ${trackingWhat}`
      : `Tracking ${trackingWhat}`
    : naming
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
    style: selected.includes(t.id) ? 'selected' : 'fill',
    title: sentence(t.name),
    onSelect: running ? undefined : () => toggle(t.id),
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
        {busyLabel && <PictureBusy label={busyLabel} progress={running && job?.state === 'running' && job.framesTotal > 0 ? { done: job.framesDone, total: job.framesTotal } : null} />}
      </PictureFrame>

      {running ? (
        <p className='text-muted-foreground text-xs'>
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
          {!naming && (
            <p className='text-muted-foreground text-sm'>
              {things.length === 0
                ? 'No items were outlined on this frame.'
                : guided
                  ? `Streamatic found ${guided.found.length} items for “${guided.item}” on this frame. Select up to ${MOST_TRACKED_AT_ONCE} of them to track.`
                  : `Streamatic outlined these items on this frame. Select up to ${MOST_TRACKED_AT_ONCE} outlines to track them together.`}{' '}
              If an item is not outlined, enter its name or draw a box around it.
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
              disabled={selectedThings.length === 0}
              onClick={() => tracked(selectedThings.map((t) => t.id))}
            >
              <Crosshair />
              {selectedThings.length === 0 ? 'Select an item to track' : `Track ${trackingWhat}${trackSeconds === null ? ' through the clip' : ''}`}
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
