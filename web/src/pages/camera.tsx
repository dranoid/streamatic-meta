import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cctv, Check, Clock, Compass, Eye, EyeOff, History, Loader2, MousePointerClick, Pencil, Plus, ScanSearch, Sparkles, SquareDashed, Trash2, Wand2, X } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { OverlayChip, PictureFrame, ZONE_COLOURS, type DrawnPath } from '@/components/picture-frame';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { api, nowUrl, pictureUrl, storedUrl, type Box, type Camera, type CameraZone, type GuidePlan, type NewRule, type NewZone, type PlanAttempt, type SavedRule, type Trial } from '@/lib/api';
import { cn } from '@/lib/cn';
import { dateAndTime, sentence, shortDate } from '@/lib/time';

// One SAM outline the person selected, as setup knows it: the zone is the one that holds this piece.
type Pick = { word: string; label: string; objectId: string };

interface Draft {
  sentence: string;
  picks: Pick[];
  box: { label: string; box: Box } | null;
  boxName: string;
  question: string;
  limitHours: boolean;
  from: number;
  to: number;
}

type GuideRun = { plan: GuidePlan; attempts: PlanAttempt[] };

const EMPTY_DRAFT: Draft = { sentence: '', picks: [], box: null, boxName: '', question: '', limitHours: false, from: 21, to: 6 };
const MIN_BOX = 12;
const MAX_ZONES_PER_RULE = 4;
const NOW = 'now';

const title = (label: string) => label[0]!.toUpperCase() + label.slice(1);
const pad = (h: number) => `${String(h).padStart(2, '0')}:00`;
const colourAt = (i: number) => ZONE_COLOURS[i % ZONE_COLOURS.length]!;
const holds = (zone: CameraZone, pick: Pick) => zone.word === pick.word && !!zone.outlines[pick.label]?.some((o) => o.objectId === pick.objectId);

export function CameraPage({ id }: { id: string }) {
  // A camera playing its recording moves on every second or two, so its page follows while it is open.
  const cameras = useQuery({ queryKey: ['cameras'], queryFn: api.cameras, refetchInterval: (q) => (q.state.data?.some((c) => c.playing) ? 2_000 : false) });
  const camera = cameras.data?.find((c) => c.id === id);

  if (cameras.isPending) return <Skeleton className='h-[32rem] rounded-xl' />;
  if (cameras.isError) return <Notice tone='error'>The camera could not be loaded. Please reload the page.</Notice>;
  if (!camera) return <Notice tone='error'>There is no camera with this address.</Notice>;
  return <CameraView key={camera.id} camera={camera} />;
}

function CameraView({ camera }: { camera: Camera }) {
  const queryClient = useQueryClient();
  const labels = Object.keys(camera.pictures);
  const zones = camera.zones;
  const playingAt = camera.playing?.at ?? null;
  const [label, setLabel] = useState(labels[0]!);
  // Zones no rule watches start hidden once any zone is active, so the picture shows what is being watched.
  const [hidden, setHidden] = useState<Set<number>>(() =>
    zones.some((z) => z.rules.length > 0) ? new Set(zones.flatMap((z, i) => (z.rules.length ? [] : [i]))) : new Set(),
  );
  const [composing, setComposing] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [drawingFrom, setDrawingFrom] = useState<{ x: number; y: number } | null>(null);
  const [liveBox, setLiveBox] = useState<Box | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);

  const rules = useQuery({ queryKey: ['rules', camera.id], queryFn: () => api.rules(camera.id) });
  const setup = useMutation({
    mutationFn: () => api.runSetup(camera.id),
    onSuccess: () => {
      setDraft(EMPTY_DRAFT);
      return queryClient.invalidateQueries({ queryKey: ['cameras'] });
    },
  });
  const ticked = new Set(draft.picks.map((p) => zones.findIndex((z) => holds(z, p))));

  const [guide, setGuide] = useState<GuideRun | null>(null);
  const [guideNote, setGuideNote] = useState<string | null>(null);

  const startRule = (next: Draft) => {
    setComposing(true);
    setDrawing(false);
    setDraft(next);
  };
  // The guide opens the rule builder with only the sentence; each step then fills in its part where it can be seen.
  const startGuide = (run: GuideRun) => {
    setGuide(run);
    setGuideNote(null);
    startRule({ ...EMPTY_DRAFT, sentence: run.plan.sentence });
  };
  const toggle = (i: number, pick: Pick) =>
    setDraft((d) => {
      if (d.picks.some((p) => holds(zones[i]!, p))) return { ...d, picks: d.picks.filter((p) => !holds(zones[i]!, p)) };
      if (d.picks.length + (d.box ? 1 : 0) >= MAX_ZONES_PER_RULE) return d;
      return { ...d, picks: [...d.picks, pick] };
    });

  // "Now" is the picture the recording is playing; zones are selected on setup's pictures, so none are drawn on it.
  const now = label === NOW;
  const paths: DrawnPath[] = now ? [] : zones.flatMap((z, i) =>
    composing || !hidden.has(i)
      ? (z.outlines[label] ?? []).map((o) => ({
          key: `${i}-${o.objectId}`,
          d: o.path,
          colour: colourAt(i),
          style: ticked.has(i) ? ('selected' as const) : ('fill' as const),
          title: z.name,
          onSelect: () => {
            const pick = { word: z.word, label, objectId: o.objectId };
            if (!composing) startRule({ ...EMPTY_DRAFT, picks: [pick] });
            else toggle(i, pick);
          },
        }))
      : [],
  );
  const drawnBox = liveBox ?? (draft.box?.label === label ? draft.box.box : null);

  const toPicture = (event: ReactPointerEvent) => {
    const el = svg.current;
    const matrix = el?.getScreenCTM();
    if (!el || !matrix) return null;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const { width, height } = el.viewBox.baseVal;
    return { x: Math.min(Math.max(p.x, 0), width), y: Math.min(Math.max(p.y, 0), height) };
  };
  const boxFrom = (a: { x: number; y: number }, b: { x: number; y: number }): Box => ({
    left: Math.round(Math.min(a.x, b.x)),
    top: Math.round(Math.min(a.y, b.y)),
    right: Math.round(Math.max(a.x, b.x)),
    bottom: Math.round(Math.max(a.y, b.y)),
  });

  // A suggestion names SAM's word; when the word outlines two things, such as two doors, the person selects which one.
  const applySuggestion = (text: string, words: string[]) => {
    const wanted = words.map((w) => w.toLowerCase());
    const matching = zones.filter((z) => wanted.includes(z.word));
    const only = matching.length === 1 ? matching[0]! : null;
    const where = only ? (only.outlines[label] ? label : Object.keys(only.outlines)[0]!) : undefined;
    startRule({ ...EMPTY_DRAFT, sentence: text, picks: only && where ? [{ word: only.word, label: where, objectId: only.outlines[where]![0]!.objectId }] : [] });
    if (where) setLabel(where);
  };

  return (
    <>
      <PageHeader
        trail={[{ href: '/cameras', label: 'Cameras' }]}
        icon={<Cctv />}
        title={camera.name}
        badges={
          camera.setup ? (
            <>
              <Badge variant='success'>{zones.length} zones found</Badge>
              <Badge variant='outline'>{zones.filter((z) => z.rules.length > 0).length} active</Badge>
              {camera.playing && <PlayingBadge />}
            </>
          ) : (
            <Badge variant='muted'>Not set up</Badge>
          )
        }
        description={sentence(camera.site)}
        actions={
          <>
            {camera.setup && (
              <Button variant='outline' size='sm' onClick={() => setup.mutate()} disabled={setup.isPending}>
                {setup.isPending ? <Loader2 className='animate-spin' /> : <Wand2 />}
                Run setup again
              </Button>
            )}
            {camera.setup && !composing && (
              <Button size='sm' onClick={() => startRule(EMPTY_DRAFT)}>
                <Plus />
                New rule
              </Button>
            )}
          </>
        }
      />

      <div className='grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]'>
        <div className='min-w-0 space-y-6'>
          <Card>
            <CardHeader className='flex-wrap items-center'>
              <div>
                <CardTitle>What the camera sees</CardTitle>
                <CardDescription>
                  {zones.length
                    ? 'Each zone is outlined under the word it answers to. Select an outline to build a rule on it.'
                    : 'The three pictures setup works from: by day, at dusk and at night.'}
                </CardDescription>
              </div>
              <Segmented
                label='Picture'
                value={label}
                onChange={setLabel}
                options={[...(camera.playing ? [{ value: NOW, label: 'Now' }] : []), ...labels.map((l) => ({ value: l, label: title(l) }))]}
              />
            </CardHeader>
            <CardContent className='space-y-5'>
              <div
                onPointerDown={(e) => {
                  if (!drawing || now) return;
                  const p = toPicture(e);
                  if (!p) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDrawingFrom(p);
                  setLiveBox(null);
                }}
                onPointerMove={(e) => {
                  if (!drawingFrom) return;
                  const p = toPicture(e);
                  if (p) setLiveBox(boxFrom(drawingFrom, p));
                }}
                onPointerUp={(e) => {
                  if (!drawingFrom) return;
                  const p = toPicture(e);
                  const b = p ? boxFrom(drawingFrom, p) : null;
                  setDrawingFrom(null);
                  setLiveBox(null);
                  if (b && b.right - b.left >= MIN_BOX && b.bottom - b.top >= MIN_BOX) {
                    setDraft((d) => ({ ...d, box: { label, box: b } }));
                    setDrawing(false);
                  }
                }}
              >
                <PictureFrame
                  src={now ? (playingAt === null ? null : nowUrl(camera.id, playingAt)) : pictureUrl(camera.id, camera.pictures[label]!)}
                  alt={now ? `${camera.name}, the recording playing now` : `${camera.name}, ${label} picture`}
                  paths={drawing ? [] : paths}
                  box={now ? null : drawnBox}
                  drawing={drawing && !now}
                  onPicture={(el) => (svg.current = el)}
                  className={cn(composing && 'ring-primary/60 ring-2')}
                >
                  {now && playingAt !== null && <OverlayChip className='bottom-2 left-2'>Recorded {dateAndTime(playingAt)}</OverlayChip>}
                  {composing && !now && (
                    <OverlayChip className='bottom-2 left-2 flex items-center gap-1.5'>
                      {drawing ? <SquareDashed className='size-3.5' /> : <MousePointerClick className='size-3.5' />}
                      {drawing ? 'Drag across the picture to draw the box' : 'Select the outlines this rule watches'}
                    </OverlayChip>
                  )}
                  {setup.isPending && <SetupRunning />}
                </PictureFrame>
              </div>

              {zones.length > 0 && (
                <ZoneList
                  camera={camera}
                  hidden={hidden}
                  onToggle={(i) =>
                    setHidden((h) => {
                      const next = new Set(h);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                />
              )}
            </CardContent>
          </Card>

          {camera.setup ? (
            <SetupReport camera={camera} />
          ) : (
            <Card>
              <CardContent className='flex flex-col items-start gap-4 sm:flex-row sm:items-center'>
                <div className='bg-gold/20 text-foreground flex size-10 shrink-0 items-center justify-center rounded-lg'>
                  <Sparkles className='size-5' />
                </div>
                <div className='flex-1'>
                  <p className='font-semibold'>Set up this camera</p>
                  <p className='text-muted-foreground mt-0.5 text-sm'>
                    Streamatic lists what it sees in the {labels.length} pictures, outlines each thing, and suggests rules for what was outlined. It takes
                    one to two minutes.
                  </p>
                </div>
                <Button onClick={() => setup.mutate()} disabled={setup.isPending}>
                  {setup.isPending ? <Loader2 className='animate-spin' /> : <Wand2 />}
                  {setup.isPending ? 'Setting up' : 'Run setup'}
                </Button>
              </CardContent>
            </Card>
          )}
          {setup.isError && <Notice tone='error'>{setup.error.message}</Notice>}
        </div>

        <div className='min-w-0 space-y-6'>
          {composing ? (
            <RuleBuilder
              camera={camera}
              draft={draft}
              setDraft={setDraft}
              drawing={drawing}
              setDrawing={setDrawing}
              label={label}
              guide={guide}
              onDone={(saved) => {
                if (guide && saved) {
                  setGuideNote(
                    saved.checked
                      ? `Saved and checked: “${saved.rule.sentence}” is on this camera with the zones and hours you confirmed.`
                      : `“${saved.rule.sentence}” was saved, but it does not match what you confirmed. Check it in the rules below.`,
                  );
                }
                setGuide(null);
                setComposing(false);
                setDrawing(false);
                setDraft(EMPTY_DRAFT);
              }}
            />
          ) : (
            camera.setup && <GuideCard camera={camera} note={guideNote} onPlanned={startGuide} onBuildYourself={(text) => startRule({ ...EMPTY_DRAFT, sentence: text })} />
          )}
          {!composing &&
            camera.setup &&
            camera.setup.rules.length > 0 && (
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle className='flex items-center gap-2'>
                      <Sparkles className='text-gold size-4' />
                      Suggested rules
                    </CardTitle>
                    <CardDescription>Suggested only on zones that were outlined.</CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  <ul className='divide-y'>
                    {camera.setup.rules.map((r) => (
                      <li key={r.sentence} className='flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0'>
                        <span className='text-sm'>{r.sentence}</span>
                        <Button variant='outline' size='sm' onClick={() => applySuggestion(r.sentence, r.zones)}>
                          Use
                        </Button>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          <SavedRules camera={camera} rules={rules.data} loading={rules.isPending} />
        </div>
      </div>
    </>
  );
}

function PlayingBadge() {
  return (
    <Badge variant='gold' title='This camera plays a recording on a loop, and its rules run on it as they would on the camera.'>
      <span className='bg-gold size-1.5 animate-pulse rounded-full' />
      Recording on a loop
    </Badge>
  );
}

function ZoneList({ camera, hidden, onToggle }: { camera: Camera; hidden: Set<number>; onToggle: (i: number) => void }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [checking, setChecking] = useState<{ index: number; name: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: ({ zone, name }: { zone: CameraZone; name: string }) => {
      const [where, pieces] = Object.entries(zone.outlines)[0]!;
      return api.renameZone(camera.id, { word: zone.word, label: where, objectId: pieces[0]!.objectId, name });
    },
    onSuccess: async (result, { name }) => {
      setChecking(null);
      setEditing(null);
      setDone(renamedNote(name, result.rules, result.events));
      await Promise.all(['cameras', 'rules', 'events'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    },
  });
  const zones = camera.zones.map((zone, index) => ({ zone, index }));
  const active = zones.filter(({ zone }) => zone.rules.length > 0);
  const other = zones.filter(({ zone }) => zone.rules.length === 0);

  const row = ({ zone, index }: { zone: CameraZone; index: number }) => {
    const off = hidden.has(index);
    return (
      <li key={index} className='flex min-h-9 min-w-0 items-center gap-2'>
        {editing === index ? (
          <form
            className='flex min-w-0 flex-1 items-center gap-1.5'
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = name.trim();
              if (!trimmed) return;
              rename.reset();
              setChecking({ index, name: trimmed });
            }}
          >
            <Input autoFocus aria-label={`New name for ${zone.name}`} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} className='h-8 min-w-0' />
            <Button type='submit' size='sm' disabled={!name.trim()}>
              Next
            </Button>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              onClick={() => {
                setEditing(null);
                setChecking(null);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <span className='size-2.5 shrink-0 rounded-[3px]' style={{ background: colourAt(index) }} />
            <span className='min-w-0 flex-1 truncate text-sm'>
              <span className='font-medium'>{zone.name}</span>
              {zone.name !== zone.word && <span className='text-muted-foreground'> · outlined as {zone.word}</span>}
              {zone.rules.length > 0 && (
                <span className='text-muted-foreground'>
                  {' '}
                  · {zone.rules.length} {zone.rules.length === 1 ? 'rule' : 'rules'}
                </span>
              )}
            </span>
            <Button
              variant='ghost'
              size='icon'
              className='text-muted-foreground size-7'
              aria-label={`Rename ${zone.name}`}
              title='Rename'
              onClick={() => {
                setEditing(index);
                setName(zone.name);
                setChecking(null);
                setDone(null);
              }}
            >
              <Pencil />
            </Button>
            <Button
              variant='ghost'
              size='icon'
              className='text-muted-foreground size-7'
              aria-pressed={!off}
              aria-label={off ? `Show ${zone.name}` : `Hide ${zone.name}`}
              title={off ? 'Show' : 'Hide'}
              onClick={() => onToggle(index)}
            >
              {off ? <EyeOff /> : <Eye />}
            </Button>
          </>
        )}
      </li>
    );
  };

  return (
    <div className='space-y-5'>
      <ZoneGroup title='Active zones' note={active.length ? 'Watched by a rule.' : 'None yet. A zone becomes active when a rule watches it.'}>
        {active.map(row)}
      </ZoneGroup>
      {checking && (
        <RenameCheck
          camera={camera}
          zone={camera.zones[checking.index]!}
          index={checking.index}
          name={checking.name}
          saving={rename.isPending}
          onConfirm={() => rename.mutate({ zone: camera.zones[checking.index]!, name: checking.name })}
          onBack={() => setChecking(null)}
        />
      )}
      {rename.isError && <Notice tone='error'>{rename.error.message}</Notice>}
      {done && <Notice>{done}</Notice>}
      {other.length > 0 && (
        <ZoneGroup title='Other zones' note='Found by setup. Nothing watches them until a rule does.' columns={2}>
          {other.map(row)}
        </ZoneGroup>
      )}
    </div>
  );
}

function ZoneGroup({ title, note, columns = 1, children }: { title: string; note: string; columns?: 1 | 2; children: ReactNode }) {
  return (
    <section className='space-y-1.5'>
      <div className='flex flex-wrap items-baseline gap-x-2'>
        <h3 className='text-sm font-semibold'>{title}</h3>
        <p className='text-muted-foreground text-xs'>{note}</p>
      </div>
      <ul className={cn('grid gap-x-4 gap-y-0.5', columns === 2 && 'sm:grid-cols-2')}>{children}</ul>
    </section>
  );
}

// Before a name is saved, the person sees the zone on every picture and confirms it is the same thing at every time of day.
function RenameCheck({
  camera,
  zone,
  index,
  name,
  saving,
  onConfirm,
  onBack,
}: {
  camera: Camera;
  zone: CameraZone;
  index: number;
  name: string;
  saving: boolean;
  onConfirm: () => void;
  onBack: () => void;
}) {
  return (
    <div className='border-primary/40 space-y-3 rounded-lg border p-4' role='region' aria-label={`Check “${name}” on every picture`}>
      <div>
        <p className='font-medium'>
          Is this “{name}” on every picture?
        </p>
        <p className='text-muted-foreground mt-0.5 text-xs'>The outlined area in each picture is what will be called “{name}”.</p>
      </div>
      <div className='grid gap-3 sm:grid-cols-3'>
        {Object.entries(camera.pictures).map(([label, file]) => {
          const pieces = zone.outlines[label] ?? [];
          return (
            <figure key={label} className='space-y-1.5'>
              <PictureFrame
                src={pictureUrl(camera.id, file)}
                alt={`${camera.name}, ${label} picture, with ${zone.name} outlined`}
                paths={pieces.map((o) => ({ key: o.objectId, d: o.path, colour: colourAt(index), style: 'selected' as const }))}
              />
              <figcaption className='text-muted-foreground text-xs'>
                {title(label)}
                {pieces.length === 0 && ': not outlined on this picture'}
              </figcaption>
            </figure>
          );
        })}
      </div>
      <div className='flex gap-2'>
        <Button size='sm' onClick={onConfirm} disabled={saving}>
          {saving && <Loader2 className='animate-spin' />}
          Confirm
        </Button>
        <Button size='sm' variant='outline' onClick={onBack} disabled={saving}>
          Back
        </Button>
      </div>
    </div>
  );
}

function renamedNote(name: string, rules: number, events: number): string {
  const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  if (rules === 0 && events === 0) return `Renamed to “${name}”.`;
  return `Renamed to “${name}”. ${count(rules, 'rule')} and ${count(events, 'event')} now use the new name.`;
}

function SetupRunning() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className='absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/65 text-center text-sm text-white' role='status'>
      <Loader2 className='size-6 animate-spin' />
      <p className='font-medium'>Setting up the camera</p>
      <p className='max-w-xs text-xs text-white/70'>
        {seconds < 15 ? 'Listing what the camera sees.' : 'Outlining each thing on every picture.'} {seconds} s
      </p>
    </div>
  );
}

function SetupReport({ camera }: { camera: Camera }) {
  const setup = camera.setup!;
  const renamed = setup.zones.filter((z) => z.item !== z.name);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className='flex items-center gap-2'>
            <ScanSearch className='text-primary size-4' />
            Setup
          </CardTitle>
          <CardDescription>What Streamatic listed, and what it could outline.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className='grid gap-4 sm:grid-cols-3'>
        <Stat label='Outlined' value={camera.zones.length} note='zones a rule can use' />
        <Stat label='Found under another word' value={renamed.length} note={renamed.map((z) => `${z.item} → ${z.name}`).join(', ') || 'none'} />
        <Stat
          label='Seen but not outlined'
          value={setup.notOutlined.length}
          note={setup.notOutlined.map((m) => `${m.item} (tried ${m.triedWords.join(', ')})`).join('; ') || 'none'}
        />
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div className='bg-muted/40 rounded-lg border p-3'>
      <p className='text-muted-foreground text-xs'>{label}</p>
      <p className='mt-1 text-2xl font-semibold tabular-nums'>{value}</p>
      <p className='text-muted-foreground mt-1 text-xs leading-relaxed'>{note}</p>
    </div>
  );
}

function RuleBuilder({
  camera,
  draft,
  setDraft,
  drawing,
  setDrawing,
  label,
  guide,
  onDone,
}: {
  camera: Camera;
  draft: Draft;
  setDraft: (update: (d: Draft) => Draft) => void;
  drawing: boolean;
  setDrawing: (drawing: boolean) => void;
  // The picture showing, so the guide selects zones where they can be seen.
  label: string;
  guide: GuideRun | null;
  onDone: (saved?: { rule: SavedRule; checked: boolean }) => void;
}) {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  // The last trial on stored pictures, with the rule as Spark Open read it and the draft it was run on.
  const [trial, setTrial] = useState<{ id: number; rule: Omit<SavedRule, 'id'>; input: string } | null>(null);
  const save = useMutation({
    mutationFn: (rule: NewRule) => api.addRule(rule),
    onSuccess: async (saved, input) => {
      await Promise.all(['rules', 'cameras'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      // The rule is read back from the server and compared with what was sent, so saving is never ticked on trust.
      const back = (await api.rules(camera.id)).find((r) => r.id === saved.id);
      const checked =
        !!back &&
        back.sentence === input.sentence &&
        JSON.stringify(back.activeHours) === JSON.stringify(input.activeHours) &&
        back.zones.length === input.zones.length;
      onDone({ rule: saved, checked });
    },
  });
  const startTrial = useMutation({
    mutationFn: (rule: NewRule) => api.startTrial(rule),
    onSuccess: ({ id, rule }, input) => setTrial({ id, rule, input: JSON.stringify(input) }),
  });
  const trialRun = useQuery({
    queryKey: ['trial', trial?.id],
    queryFn: () => api.trial(trial!.id),
    enabled: trial !== null,
    refetchInterval: (q) => (q.state.data?.state === 'done' || q.state.data?.state === 'failed' ? false : 1_500),
  });
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const picked = draft.picks.flatMap((pick) => {
    const index = camera.zones.findIndex((z) => holds(z, pick));
    return index < 0 ? [] : [{ pick, zone: camera.zones[index]!, index }];
  });
  const count = picked.length + (draft.box ? 1 : 0);
  const rule: NewRule = {
    camera: camera.id,
    sentence: draft.sentence.trim(),
    zones: [
      ...picked.map(({ pick }) => ({ kind: 'outline' as const, ...pick })),
      ...(draft.box ? [{ kind: 'box' as const, name: draft.boxName.trim(), box: draft.box.box, question: draft.question.trim() }] : []),
    ],
    activeHours: draft.limitHours ? { from: draft.from, to: draft.to } : null,
  };
  const tried = trial !== null && trial.input === JSON.stringify(rule) && trialRun.data?.state === 'done' ? trial.rule : null;
  const trialBusy =
    startTrial.isPending || (trial !== null && trial.input === JSON.stringify(rule) && trialRun.data?.state !== 'done' && trialRun.data?.state !== 'failed');

  const ready = () => {
    if (!draft.sentence.trim()) return setProblem('Write the rule.'), false;
    if (count === 0) return setProblem('Select an outline on the picture, or draw a box.'), false;
    if (draft.box && !draft.boxName.trim()) return setProblem('Name the box.'), false;
    if (draft.box && !draft.question.trim()) return setProblem('Write the question to answer about the box.'), false;
    setProblem(null);
    return true;
  };
  const submit = () => {
    if (!ready()) return;
    // A rule just tried is saved as Spark Open read it for the trial, so what was shown is what runs.
    const asTried = tried && {
      settledBy: tried.settledBy,
      zones: rule.zones.map((z) => (z.kind === 'box' ? { ...z, question: tried.zones.find((t) => t.kind === 'box')?.question ?? z.question } : z)),
    };
    save.mutate({ ...rule, ...asTried });
  };

  // The guide's steps. A step is ticked only while the page still shows what the person confirmed, so changing
  // a zone or the hours later takes the tick off that step and every step after it.
  const [confirmed, setConfirmed] = useState<Record<string, string>>({});
  const [acted, setActed] = useState<Record<string, string>>({});
  const plan = guide?.plan ?? null;
  const named = (name: string) => camera.zones.find((z) => z.name.toLowerCase() === name.trim().toLowerCase());
  const shownOn = (zone: CameraZone) => (zone.outlines[label] ? label : Object.keys(zone.outlines)[0]!);
  const pickedNames = new Set(picked.map(({ zone }) => zone.name.toLowerCase()));
  const zonesPlaced =
    plan !== null &&
    pickedNames.size === plan.zones.length &&
    plan.zones.every((n) => pickedNames.has(n.trim().toLowerCase())) &&
    (plan.box ? !!draft.box && !!draft.boxName.trim() && !!draft.question.trim() : !draft.box);
  const steps: GuideStep[] = !plan
    ? []
    : [
        {
          key: 'plan',
          title: 'Check the plan',
          detail: <PlanSummary plan={plan} attempts={guide!.attempts} zones={plan.zones.flatMap((n) => named(n) ?? [])} />,
          ready: true,
          snapshot: JSON.stringify(plan),
          confirm: 'The plan is right',
        },
        {
          key: 'zones',
          title: plan.box && plan.box.over === null ? 'Place the zones and draw the box' : 'Place the zones',
          detail: (
            <div className='space-y-1'>
              <p>
                {plan.box && plan.box.over === null
                  ? `Draw the box over the ${plan.box.name} on the picture.`
                  : 'Selected on the picture. Select an outline to add or remove it.'}
              </p>
              <AlertsOn zones={picked.map(({ zone }) => zone)} question={draft.box ? draft.question : null} />
            </div>
          ),
          ready: zonesPlaced,
          waiting: plan.box && plan.box.over === null ? 'Waiting for the box' : 'Waiting for the zones',
          snapshot: JSON.stringify([draft.picks, draft.box, draft.boxName, draft.question]),
          actKey: 'once',
          act: () => {
            const over = plan.box?.over ? named(plan.box.over) : undefined;
            const pieces = over ? over.outlines[shownOn(over)]! : [];
            setDraft((d) => ({
              ...d,
              picks: plan.zones.flatMap((n) => {
                const z = named(n);
                return z ? [{ word: z.word, label: shownOn(z), objectId: z.outlines[shownOn(z)]![0]!.objectId }] : [];
              }),
              box: over
                ? {
                    label: shownOn(over),
                    box: {
                      left: Math.min(...pieces.map((o) => o.box.left)),
                      top: Math.min(...pieces.map((o) => o.box.top)),
                      right: Math.max(...pieces.map((o) => o.box.right)),
                      bottom: Math.max(...pieces.map((o) => o.box.bottom)),
                    },
                  }
                : null,
              boxName: plan.box?.name ?? '',
              question: plan.box?.question ?? '',
            }));
            if (plan.box && plan.box.over === null) setDrawing(true);
          },
          confirm: 'These are the right places',
        },
        {
          key: 'hours',
          title: 'Set the hours',
          detail: draft.limitHours ? `${pad(draft.from)} to ${pad(draft.to)}.` : 'All day.',
          ready: true,
          snapshot: JSON.stringify([draft.limitHours, draft.from, draft.to]),
          actKey: 'once',
          act: () => set(plan.hours ? { limitHours: true, from: plan.hours.from, to: plan.hours.to } : { limitHours: false }),
          confirm: 'These hours are right',
        },
        ...(camera.stored
          ? [
              {
                key: 'trial',
                title: 'Try it on stored pictures (optional)',
                detail:
                  confirmed.trial === SKIPPED
                    ? 'Skipped.'
                    : tried
                      ? 'The result is below. To change the rule, change the zones or the hours, then try it again.'
                      : 'Shows when the rule would have alerted on the pictures this camera took in the past days. Nothing is saved or sent.',
                ready: tried !== null,
                waiting: trialBusy ? 'Waiting for the trial' : undefined,
                snapshot: JSON.stringify(rule),
                confirm: 'Keep this rule',
                // A trial spends model calls, so it runs only when the person asks for it.
                optional: { start: 'Try it on stored pictures', onStart: () => startTrial.mutate(rule), busy: trialBusy, skip: 'Skip this step' },
              },
            ]
          : []),
        {
          key: 'save',
          title: 'Save the rule',
          detail: 'The saved rule is read back and compared with what you confirmed.',
          ready: true,
          snapshot: JSON.stringify(rule),
          confirm: 'Save the rule',
          onConfirm: submit,
        },
      ];
  // A step can be confirmed only once the guide has done it on the page, so a quick confirmation never skips it.
  const shown = (s: GuideStep) => s.ready && (!s.act || acted[s.key] === s.actKey);
  const ticked = (s: GuideStep) => (s.optional && confirmed[s.key] === SKIPPED) || (shown(s) && confirmed[s.key] === s.snapshot);
  const current = steps.findIndex((s) => !ticked(s));
  const step = steps[current];
  const due = step?.act && acted[step.key] !== step.actKey ? `${step.key}:${step.actKey}` : null;
  // The guide does each step a moment after it comes up, so the person sees it happen on the page.
  useEffect(() => {
    if (!due || !step?.act) return;
    const timer = setTimeout(() => {
      setActed((a) => ({ ...a, [step.key]: step.actKey! }));
      step.act!();
    }, GUIDE_PAUSE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [due]);

  return (
    <Card className='border-primary/40'>
      <CardHeader>
        <div>
          <CardTitle>{guide ? 'New rule, with the guide' : 'New rule'}</CardTitle>
          <CardDescription>
            {guide ? 'Each step is ticked only when the page shows it done and you confirm it.' : 'Plain English, on one or more zones of this camera.'}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className='space-y-5'>
        {guide && (
          <ol className='space-y-2' aria-label='Guide steps'>
            {steps.map((s, i) => {
              const done = ticked(s);
              const now = i === current;
              return (
                <li key={s.key} className={cn('rounded-lg border p-3', now && 'border-primary/50 bg-primary/5', i > current && 'opacity-50')}>
                  <div className='flex items-center gap-2'>
                    {done ? (
                      <span className='bg-primary text-primary-foreground flex size-5 items-center justify-center rounded-full'>
                        <Check className='size-3.5' />
                      </span>
                    ) : (
                      <span className='flex size-5 items-center justify-center rounded-full border text-xs tabular-nums'>{i + 1}</span>
                    )}
                    <span className='text-sm font-medium'>{s.title}</span>
                  </div>
                  {(now || done) && <div className='text-muted-foreground mt-1.5 pl-7 text-xs leading-relaxed'>{s.detail}</div>}
                  {now && (
                    <div className='mt-2 flex flex-wrap items-center gap-2 pl-7'>
                      {s.optional && !shown(s) ? (
                        <Button type='button' size='sm' disabled={s.optional.busy} onClick={s.optional.onStart}>
                          {s.optional.busy && <Loader2 className='animate-spin' />}
                          {s.optional.start}
                        </Button>
                      ) : (
                        <Button
                          type='button'
                          size='sm'
                          disabled={!shown(s) || save.isPending}
                          onClick={() => (s.onConfirm ? s.onConfirm() : setConfirmed((c) => ({ ...c, [s.key]: s.snapshot })))}
                        >
                          {s.key === 'save' && save.isPending && <Loader2 className='animate-spin' />}
                          {s.confirm}
                        </Button>
                      )}
                      {s.optional && (
                        <Button type='button' size='sm' variant='outline' onClick={() => setConfirmed((c) => ({ ...c, [s.key]: SKIPPED }))}>
                          {s.optional.skip}
                        </Button>
                      )}
                      {!shown(s) && (!s.optional || s.optional.busy) && (
                        <span className='text-muted-foreground text-xs'>{s.ready || !s.waiting ? 'The guide is doing this step' : s.waiting}</span>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        <form
          className='space-y-5'
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className='space-y-2'>
            <Label htmlFor='sentence'>Rule</Label>
            <Textarea
              id='sentence'
              rows={2}
              maxLength={300}
              value={draft.sentence}
              onChange={(e) => set({ sentence: e.target.value })}
              placeholder='Alert me if the gate is left open after 10 pm.'
            />
          </div>

          <div className='space-y-2'>
            <span className='text-sm font-medium'>Zones</span>
            {count === 0 ? (
              <p className='bg-muted/40 text-muted-foreground rounded-md border border-dashed px-3 py-2.5 text-sm'>Select an outline on the picture, or draw a box.</p>
            ) : (
              <ul className='divide-y rounded-md border'>
                {picked.map(({ pick, zone, index }) => (
                  <li key={`${pick.word}-${pick.label}-${pick.objectId}`} className='flex items-center gap-2 px-3 py-2 text-sm'>
                    <span className='size-2.5 shrink-0 rounded-[3px]' style={{ background: colourAt(index) }} />
                    <span className='min-w-0 flex-1 truncate font-medium'>{zone.name}</span>
                    <Button
                      variant='ghost'
                      size='icon'
                      className='text-muted-foreground size-7'
                      aria-label={`Remove ${zone.name} from the rule`}
                      onClick={() => set({ picks: draft.picks.filter((p) => p !== pick) })}
                    >
                      <X />
                    </Button>
                  </li>
                ))}
                {draft.box && (
                  <li className='space-y-2 px-3 py-2.5 text-sm'>
                    <div className='flex items-center gap-2'>
                      <SquareDashed className='text-muted-foreground size-3.5 shrink-0' />
                      <span className='flex-1'>
                        Box on the {draft.box.label} picture{' '}
                        <span className='text-muted-foreground tabular-nums'>
                          ({draft.box.box.right - draft.box.box.left} × {draft.box.box.bottom - draft.box.box.top} px)
                        </span>
                      </span>
                      <Button variant='ghost' size='icon' className='text-muted-foreground size-7' aria-label='Remove the box from the rule' onClick={() => set({ box: null })}>
                        <X />
                      </Button>
                    </div>
                    <div className='space-y-1.5'>
                      <Label htmlFor='box-name'>Box name</Label>
                      <Input id='box-name' maxLength={60} value={draft.boxName} onChange={(e) => set({ boxName: e.target.value })} placeholder='Doorway' />
                    </div>
                    <div className='space-y-1.5'>
                      <Label htmlFor='question'>Question about the box</Label>
                      <Input id='question' maxLength={300} value={draft.question} onChange={(e) => set({ question: e.target.value })} placeholder='Is the gate open?' />
                    </div>
                  </li>
                )}
              </ul>
            )}
            {!draft.box && (
              <Button type='button' size='sm' variant={drawing ? 'default' : 'outline'} onClick={() => setDrawing(!drawing)}>
                <SquareDashed />
                {drawing ? 'Stop drawing' : 'Draw a box'}
              </Button>
            )}
            <p className='text-muted-foreground text-xs leading-relaxed'>
              Streamatic looks again only when something changes inside a zone. With several zones, the rule alerts only when all of them change in the
              same check; select an outline again to remove it. A drawn box alerts when the answer to its question is yes.
            </p>
          </div>

          <div className='space-y-3'>
            <Label>
              <input type='checkbox' className='accent-primary size-4' checked={draft.limitHours} onChange={(e) => set({ limitHours: e.target.checked })} />
              Only between certain hours
            </Label>
            {draft.limitHours && (
              <div className='flex items-center gap-2'>
                <Clock className='text-muted-foreground size-4' />
                <Select aria-label='From' value={draft.from} onChange={(e) => set({ from: Number(e.target.value) })}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {pad(h)}
                    </option>
                  ))}
                </Select>
                <span className='text-muted-foreground text-sm'>to</span>
                <Select aria-label='To' value={draft.to} onChange={(e) => set({ to: Number(e.target.value) })}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {pad(h)}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>

          {camera.stored && trial && (
            <TrialResult
              camera={camera}
              run={trialRun.data}
              rule={trial.rule}
              stale={trial.input !== JSON.stringify(rule)}
              failed={trialRun.isError}
            />
          )}

          {(problem || save.isError || startTrial.isError) && <Notice tone='error'>{problem ?? save.error?.message ?? startTrial.error?.message}</Notice>}

          <div className='flex flex-wrap gap-2'>
            {!guide && (
              <Button type='submit' disabled={save.isPending}>
                {save.isPending && <Loader2 className='animate-spin' />}
                Save rule
              </Button>
            )}
            {camera.stored && (
              <Button
                type='button'
                variant='outline'
                disabled={startTrial.isPending || trialRun.data?.state === 'running'}
                onClick={() => ready() && startTrial.mutate(rule)}
              >
                {startTrial.isPending || trialRun.data?.state === 'running' ? <Loader2 className='animate-spin' /> : <History />}
                Try on stored pictures
              </Button>
            )}
            <Button variant='outline' onClick={() => onDone()}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

interface GuideStep {
  key: string;
  title: string;
  detail: ReactNode;
  // Whether the page shows the step done; the person's confirmation is asked for only then.
  ready: boolean;
  waiting?: string;
  // What the page shows for this step; a confirmation holds only while this stays the same.
  snapshot: string;
  // What the guide does on the page when the step comes up, again whenever actKey changes.
  act?: () => void;
  actKey?: string;
  confirm: string;
  onConfirm?: () => void;
  // A step the person may run or skip; the guide never runs it on its own.
  optional?: { start: string; onStart: () => void; busy: boolean; skip: string };
}

// How long the guide waits before doing a step, so it can be seen happening.
const GUIDE_PAUSE_MS = 700;
// What an optional step's confirmation holds once the person skips it.
const SKIPPED = 'skipped';

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const end = (s: string) => (/[.?!”]$/.test(s) ? s : `${s}.`);

// Written from the rule's own parts, so the person reads what will set it off before confirming it.
function AlertsOn({ zones, question }: { zones: CameraZone[]; question: string | null }) {
  const asked = question?.trim();
  const parts = [
    ...zones.map((z) => `the ${z.name} itself changes: it moves, opens or is no longer there`),
    ...(question !== null ? [asked ? `Streamatic answers yes to “${capital(asked)}”` : 'Streamatic answers yes to the box’s question'] : []),
  ];
  if (parts.length === 0) return null;
  if (parts.length === 1) return <p className='text-foreground font-medium'>Alerts when {end(parts[0]!)}</p>;
  return (
    <div className='text-foreground'>
      <p className='font-medium'>Alerts only when all of these happen in the same check:</p>
      <ul className='list-disc space-y-0.5 pl-4'>
        {parts.map((p) => (
          <li key={p}>{end(capital(p))}</li>
        ))}
      </ul>
    </div>
  );
}

function PlanSummary({ plan, attempts, zones }: { plan: GuidePlan; attempts: PlanAttempt[]; zones: CameraZone[] }) {
  const refused = attempts.filter((a) => a.problems.length > 0);
  return (
    <div className='space-y-1'>
      <p>Watches for: {plan.about}</p>
      <p>Zones: {plan.zones.length ? plan.zones.join(', ') : 'none'}</p>
      {plan.box && (
        <p>
          Box “{plan.box.name}”{plan.box.over ? ` over ${plan.box.over}` : ', for you to draw'}: {plan.box.question}
        </p>
      )}
      <p>Hours: {plan.hours ? `${pad(plan.hours.from)} to ${pad(plan.hours.to)}` : 'all day'}</p>
      <AlertsOn zones={zones} question={plan.box ? plan.box.question : null} />
      <p>
        {refused.length === 0
          ? 'Checked against this camera’s zones: passed.'
          : `Checked against this camera’s zones: refused ${refused.length === 1 ? 'once' : `${refused.length} times`}, corrected, then passed.`}
      </p>
      {refused.length > 0 && (
        <ul className='list-disc space-y-0.5 pl-4'>
          {refused.map((a, i) => (
            <li key={i}>{a.problems.join(' ')}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GuideCard({
  camera,
  note,
  onPlanned,
  onBuildYourself,
}: {
  camera: Camera;
  note: string | null;
  onPlanned: (run: GuideRun) => void;
  onBuildYourself: (sentence: string) => void;
}) {
  const [text, setText] = useState('');
  const planning = useMutation({
    mutationFn: (sentence: string) => api.planRule(camera.id, sentence),
    onSuccess: (result) => result.status === 'ready' && onPlanned({ plan: result.plan, attempts: result.attempts }),
  });
  const refused = planning.data?.status === 'needs-person' ? planning.data : null;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className='flex items-center gap-2'>
            <Compass className='text-primary size-4' />
            Guide
          </CardTitle>
          <CardDescription>Say what to watch. The guide plans the rule, does each step on this page, and waits for you to confirm it.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className='space-y-3'>
        <form
          className='space-y-3'
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) planning.mutate(text.trim());
          }}
        >
          <Label htmlFor='guide-request'>What should this camera watch?</Label>
          <Textarea
            id='guide-request'
            rows={2}
            maxLength={300}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='Tell me if anyone is in the yard after 11 pm.'
          />
          <Button type='submit' disabled={planning.isPending || !text.trim()}>
            {planning.isPending ? <Loader2 className='animate-spin' /> : <Compass />}
            {planning.isPending ? 'Planning' : 'Plan the rule'}
          </Button>
        </form>
        {note && <Notice>{note}</Notice>}
        {planning.isError && <Notice tone='error'>{planning.error.message}</Notice>}
        {refused && (
          <div className='space-y-2'>
            <Notice tone='error'>
              The guide could not plan this rule on this camera after {refused.attempts.length} tries. {refused.problems.join(' ')}
            </Notice>
            <Button variant='outline' size='sm' onClick={() => onBuildYourself(text.trim())}>
              Build it yourself
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// The most alerts a trial shows as pictures; the rest are counted.
const TRIAL_PICTURES = 9;

function TrialResult({
  camera,
  run,
  rule,
  stale,
  failed,
}: {
  camera: Camera;
  run: Trial | undefined;
  rule: Omit<SavedRule, 'id'>;
  stale: boolean;
  failed: boolean;
}) {
  const stored = camera.stored!;
  const span = `${stored.pictures} pictures from ${shortDate(stored.from)} to ${shortDate(stored.to)}`;
  if (failed || run?.state === 'failed') return <Notice tone='error'>The rule could not be tried on the stored pictures. Please try again.</Notice>;
  if (!run || run.state === 'running') {
    const share = run ? run.checked / Math.max(1, run.pictures) : 0;
    return (
      <div className='bg-muted/40 space-y-2 rounded-lg border p-3'>
        <p className='text-sm font-medium'>Trying the rule on {span}</p>
        <div className='bg-muted h-1.5 overflow-hidden rounded-full'>
          <div className='bg-primary h-full transition-[width]' style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
        <p className='text-muted-foreground text-xs tabular-nums'>
          {run?.checked ?? 0} of {stored.pictures} checked. Nothing is saved or sent.
        </p>
      </div>
    );
  }
  const n = run.alerts.length;
  const box = rule.zones.find((z) => z.kind === 'box');
  return (
    <div className={cn('space-y-3 rounded-lg border p-3', stale && 'opacity-60')}>
      <div className='space-y-1'>
        <p className='text-sm font-medium'>{n === 0 ? 'Would not have alerted' : n === 1 ? 'Would have alerted once' : `Would have alerted ${n} times`}</p>
        <p className='text-muted-foreground text-xs leading-relaxed'>
          On the {span}; {run.checks} {run.checks === 1 ? 'change was' : 'changes were'} checked by the models.
        </p>
        <div className='flex flex-wrap gap-1.5 pt-1'>
          <Badge variant='muted'>{SETTLED_BY_LABEL[rule.settledBy]}</Badge>
          {box && <Badge variant='outline'>Asks: {box.question}</Badge>}
        </div>
      </div>
      {stale && <Notice>The rule has changed since it was tried. Try it again to see the new result.</Notice>}
      {n > 0 && (
        <ul className='grid grid-cols-2 gap-2 sm:grid-cols-3'>
          {run.alerts.slice(0, TRIAL_PICTURES).map((a) => (
            <li key={a.at} className='space-y-1'>
              <PictureFrame
                src={a.pictureAt === null ? null : storedUrl(camera.id, a.pictureAt)}
                alt={`${camera.name} at ${dateAndTime(a.at)}`}
                paths={a.outlines.map((d, i) => ({ key: `${a.at}-${i}`, d, colour: ZONE_COLOURS[0]!, style: 'fill' as const }))}
              />
              <p className='text-muted-foreground text-xs tabular-nums'>{dateAndTime(a.at)}</p>
            </li>
          ))}
        </ul>
      )}
      {n > TRIAL_PICTURES && <p className='text-muted-foreground text-xs'>And {n - TRIAL_PICTURES} more.</p>}
    </div>
  );
}

const SETTLED_BY_LABEL: Record<SavedRule['settledBy'], string> = {
  'one-picture': 'Decided on one picture',
  change: 'Decided on a change',
  'brief-change': 'Decided on a brief change',
};

function SavedRules({ camera, rules, loading }: { camera: Camera; rules: SavedRule[] | undefined; loading: boolean }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: number) => api.removeRule(id),
    onSuccess: () => Promise.all(['rules', 'cameras'].map((key) => queryClient.invalidateQueries({ queryKey: [key] }))),
  });

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Rules on this camera</CardTitle>
          <CardDescription>Each one watches its zones and alerts on Telegram.</CardDescription>
        </div>
        {rules && <Badge variant='muted'>{rules.length}</Badge>}
      </CardHeader>
      <CardContent>
        {loading && <Skeleton className='h-16' />}
        {rules?.length === 0 && <p className='text-muted-foreground text-sm'>No rules yet. Use a suggestion, or select an outline on the picture.</p>}
        <ul className='divide-y'>
          {rules?.map((r) => {
            const names = r.zones.map((z) => z.name);
            return (
              <li key={r.id} className='flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0'>
                <div className='min-w-0 space-y-1.5'>
                  <p className='text-sm'>{r.sentence}</p>
                  {r.zones.map(
                    (z) =>
                      z.kind === 'box' && (
                        <p key={z.name} className='text-muted-foreground text-xs'>
                          Asks about {z.name}: {z.question}
                        </p>
                      ),
                  )}
                  <div className='flex flex-wrap gap-1.5'>
                    {r.zones.map((z) => (
                      <Badge key={z.name} variant='outline'>
                        {z.kind === 'box' && <SquareDashed />}
                        {z.name}
                      </Badge>
                    ))}
                    {r.zones.length > 1 && <Badge variant='muted'>All must change</Badge>}
                    <Badge variant='muted'>{SETTLED_BY_LABEL[r.settledBy]}</Badge>
                    {r.activeHours && (
                      <Badge variant='muted'>
                        {pad(r.activeHours.from)} to {pad(r.activeHours.to)}
                      </Badge>
                    )}
                  </div>
                </div>
                <Button
                  variant='ghost'
                  size='icon'
                  className='text-muted-foreground hover:text-destructive size-8'
                  aria-label={`Remove the rule: ${r.sentence}`}
                  disabled={remove.isPending}
                  onClick={() => {
                    if (confirm(`Remove the rule “${r.sentence}”? ${camera.name} stops watching ${names.join(' and ')} for it.`)) remove.mutate(r.id);
                  }}
                >
                  <Trash2 />
                </Button>
              </li>
            );
          })}
        </ul>
        {remove.isError && <Notice tone='error' className='mt-3'>{remove.error.message}</Notice>}
      </CardContent>
    </Card>
  );
}
