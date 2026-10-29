import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cctv, Clock, Eye, EyeOff, Loader2, MousePointerClick, Plus, ScanSearch, Sparkles, SquareDashed, Trash2, Wand2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { OverlayChip, PictureFrame, ZONE_COLOURS, type DrawnPath } from '@/components/picture-frame';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { api, pictureUrl, type Box, type Camera, type NewZone, type SavedRule } from '@/lib/api';
import { cn } from '@/lib/cn';
import { sentence } from '@/lib/time';

type Choice = { kind: 'outline'; word: string; label: string; objectId: string } | { kind: 'box'; label: string; box: Box };

interface Draft {
  sentence: string;
  zoneKind: 'outline' | 'box';
  choice: Choice | null;
  name: string;
  question: string;
  limitHours: boolean;
  from: number;
  to: number;
}

const EMPTY_DRAFT: Draft = { sentence: '', zoneKind: 'outline', choice: null, name: '', question: '', limitHours: false, from: 21, to: 6 };
const MIN_BOX = 12;

const title = (label: string) => label[0]!.toUpperCase() + label.slice(1);
const pad = (h: number) => `${String(h).padStart(2, '0')}:00`;

export function CameraPage({ id }: { id: string }) {
  const cameras = useQuery({ queryKey: ['cameras'], queryFn: api.cameras });
  const camera = cameras.data?.find((c) => c.id === id);

  if (cameras.isPending) return <Skeleton className='h-[32rem] rounded-xl' />;
  if (cameras.isError) return <Notice tone='error'>The camera could not be loaded. Please reload the page.</Notice>;
  if (!camera) return <Notice tone='error'>There is no camera with this address.</Notice>;
  return <CameraView key={camera.id} camera={camera} />;
}

function CameraView({ camera }: { camera: Camera }) {
  const queryClient = useQueryClient();
  const labels = Object.keys(camera.pictures);
  const [label, setLabel] = useState(labels[0]!);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [composing, setComposing] = useState(false);
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
  const zones = camera.setup?.zones ?? [];
  const colourOf = (word: string) => ZONE_COLOURS[Math.max(0, zones.findIndex((z) => z.name === word)) % ZONE_COLOURS.length]!;
  const picking = composing && draft.zoneKind === 'outline';
  const drawing = composing && draft.zoneKind === 'box';

  const choose = (choice: Choice, name?: string) =>
    setDraft((d) => ({ ...d, choice, name: name !== undefined && (d.name === '' || d.choice?.kind === 'outline') ? name : d.name }));

  const paths: DrawnPath[] = zones
    .filter((z) => !hidden.has(z.name))
    .flatMap((z) =>
      (z.outlines[label] ?? []).map((o) => {
        const chosen = draft.choice?.kind === 'outline' && draft.choice.word === z.name && draft.choice.label === label && draft.choice.objectId === o.objectId;
        return {
          key: `${z.name}-${o.objectId}`,
          d: o.path,
          colour: colourOf(z.name),
          style: chosen ? ('selected' as const) : ('fill' as const),
          title: z.name,
          onSelect: () => {
            if (!composing) {
              setComposing(true);
              setDraft({ ...EMPTY_DRAFT, sentence: '' });
            }
            choose({ kind: 'outline', word: z.name, label, objectId: o.objectId }, z.name);
          },
        };
      }),
    );
  const drawnBox = liveBox ?? (draft.choice?.kind === 'box' && draft.choice.label === label ? draft.choice.box : null);

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

  const applySuggestion = (sentence: string, names: string[]) => {
    const zone = zones.find((z) => names.map((n) => n.toLowerCase()).includes(z.name));
    const where = zone ? (zone.outlines[label]?.length ? label : zone.seenAt[0]) : undefined;
    const outline = zone && where ? zone.outlines[where]?.[0] : undefined;
    setComposing(true);
    setDraft({
      ...EMPTY_DRAFT,
      sentence,
      choice: zone && where && outline ? { kind: 'outline', word: zone.name, label: where, objectId: outline.objectId } : null,
      name: zone?.name ?? '',
    });
    if (where) setLabel(where);
  };

  return (
    <>
      <PageHeader
        trail={[{ href: '/cameras', label: 'Cameras' }]}
        icon={<Cctv />}
        title={camera.name}
        badges={camera.setup ? <Badge variant='success'>{zones.length} zones outlined</Badge> : <Badge variant='muted'>Not set up</Badge>}
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
              <Button
                size='sm'
                onClick={() => {
                  setComposing(true);
                  setDraft(EMPTY_DRAFT);
                }}
              >
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
                    ? 'Every outline is SAM 3.1’s, under the word shown. Select one to build a rule on it.'
                    : 'The three pictures setup works from: by day, at dusk and at night.'}
                </CardDescription>
              </div>
              <Segmented label='Picture' value={label} onChange={setLabel} options={labels.map((l) => ({ value: l, label: title(l) }))} />
            </CardHeader>
            <CardContent className='space-y-4'>
              <div
                onPointerDown={(e) => {
                  if (!drawing) return;
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
                  if (b && b.right - b.left >= MIN_BOX && b.bottom - b.top >= MIN_BOX) choose({ kind: 'box', label, box: b });
                }}
              >
                <PictureFrame
                  src={pictureUrl(camera.id, camera.pictures[label]!)}
                  alt={`${camera.name}, ${label} picture`}
                  paths={drawing ? [] : paths}
                  box={drawnBox}
                  drawing={drawing}
                  onPicture={(el) => (svg.current = el)}
                  className={cn((picking || drawing) && 'ring-primary/60 ring-2')}
                >
                  {(picking || drawing) && (
                    <OverlayChip className='bottom-2 left-2 flex items-center gap-1.5'>
                      {picking ? <MousePointerClick className='size-3.5' /> : <SquareDashed className='size-3.5' />}
                      {picking ? 'Select an outline for the rule' : 'Drag across the picture to draw the zone'}
                    </OverlayChip>
                  )}
                  {setup.isPending && <SetupRunning />}
                </PictureFrame>
              </div>

              {zones.length > 0 && (
                <div className='flex flex-wrap gap-1.5' role='group' aria-label='Zones'>
                  {zones.map((z) => {
                    const here = z.outlines[label]?.length ?? 0;
                    const off = hidden.has(z.name);
                    return (
                      <button
                        key={z.name}
                        type='button'
                        aria-pressed={!off}
                        title={off ? `Show ${z.name}` : `Hide ${z.name}`}
                        onClick={() =>
                          setHidden((h) => {
                            const next = new Set(h);
                            if (off) next.delete(z.name);
                            else next.add(z.name);
                            return next;
                          })
                        }
                        className={cn(
                          'bg-background hover:bg-accent inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors dark:bg-input/30',
                          (off || here === 0) && 'opacity-50',
                        )}
                      >
                        <span className='size-2.5 rounded-[3px]' style={{ background: colourOf(z.name) }} />
                        {z.name}
                        <span className='text-muted-foreground tabular-nums'>{here}</span>
                        {off ? <EyeOff className='text-muted-foreground size-3' /> : <Eye className='text-muted-foreground size-3' />}
                      </button>
                    );
                  })}
                </div>
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
                    Muse Spark Open lists what it sees in the {labels.length} pictures, SAM 3.1 outlines each thing, and Muse Spark Open suggests rules for
                    what was outlined. It takes one to two minutes.
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
              colourOf={colourOf}
              onDone={() => {
                setComposing(false);
                setDraft(EMPTY_DRAFT);
              }}
            />
          ) : (
            camera.setup &&
            camera.setup.rules.length > 0 && (
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle className='flex items-center gap-2'>
                      <Sparkles className='text-gold size-4' />
                      Suggested rules
                    </CardTitle>
                    <CardDescription>From Muse Spark Open, only on zones SAM 3.1 outlined.</CardDescription>
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
            )
          )}
          <SavedRules camera={camera} rules={rules.data} loading={rules.isPending} />
        </div>
      </div>
    </>
  );
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
        {seconds < 15 ? 'Muse Spark Open is listing what it sees.' : 'SAM 3.1 is outlining each thing on every picture.'} {seconds} s
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
          <CardDescription>What Muse Spark Open listed, and what SAM 3.1 could outline.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className='grid gap-4 sm:grid-cols-3'>
        <Stat label='Outlined' value={setup.zones.length} note='zones a rule can use' />
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
  colourOf,
  onDone,
}: {
  camera: Camera;
  draft: Draft;
  setDraft: (update: (d: Draft) => Draft) => void;
  colourOf: (word: string) => string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (zone: NewZone) =>
      api.addRule({ camera: camera.id, sentence: draft.sentence.trim(), zone, activeHours: draft.limitHours ? { from: draft.from, to: draft.to } : null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['rules'] });
      onDone();
    },
  });
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const submit = () => {
    const c = draft.choice;
    if (!draft.sentence.trim()) return setProblem('Write the rule.');
    if (!c) return setProblem(draft.zoneKind === 'outline' ? 'Select an outline on the picture.' : 'Draw the zone on the picture.');
    if (!draft.name.trim()) return setProblem('Name the zone.');
    if (c.kind === 'box' && !draft.question.trim()) return setProblem('Write the question Muse Spark Open answers about the box.');
    setProblem(null);
    save.mutate(
      c.kind === 'outline'
        ? { kind: 'outline', name: draft.name.trim(), word: c.word, label: c.label, objectId: c.objectId }
        : { kind: 'box', name: draft.name.trim(), box: c.box, question: draft.question.trim() },
    );
  };

  return (
    <Card className='border-primary/40'>
      <CardHeader>
        <div>
          <CardTitle>New rule</CardTitle>
          <CardDescription>Plain English, on a zone of this camera.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
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
            <span className='text-sm font-medium'>Zone</span>
            <Segmented
              label='Kind of zone'
              className='w-full [&>button]:flex-1'
              value={draft.zoneKind}
              onChange={(zoneKind) => set({ zoneKind, choice: null })}
              options={[
                { value: 'outline', label: 'SAM outline' },
                { value: 'box', label: 'Drawn box' },
              ]}
            />
            <div className='bg-muted/40 rounded-md border border-dashed px-3 py-2.5 text-sm'>
              {draft.choice?.kind === 'outline' ? (
                <span className='flex items-center gap-2'>
                  <span className='size-2.5 rounded-[3px]' style={{ background: colourOf(draft.choice.word) }} />
                  <span>
                    <span className='font-medium'>{draft.choice.word}</span>
                    <span className='text-muted-foreground'>, on the {draft.choice.label} picture</span>
                  </span>
                </span>
              ) : draft.choice?.kind === 'box' ? (
                <span>
                  Box on the {draft.choice.label} picture{' '}
                  <span className='text-muted-foreground tabular-nums'>
                    ({draft.choice.box.right - draft.choice.box.left} × {draft.choice.box.bottom - draft.choice.box.top} px)
                  </span>
                </span>
              ) : (
                <span className='text-muted-foreground'>
                  {draft.zoneKind === 'outline' ? 'Select an outline on the picture.' : 'Drag across the picture to draw the zone.'}
                </span>
              )}
            </div>
            <p className='text-muted-foreground text-xs leading-relaxed'>
              {draft.zoneKind === 'outline'
                ? 'SAM 3.1 looks again only when something changes inside the outline, and compares its new outline with this one.'
                : 'Muse Spark Open answers the question about the box whenever something changes inside it.'}
            </p>
          </div>

          <div className='space-y-2'>
            <Label htmlFor='zone-name'>Zone name</Label>
            <Input id='zone-name' maxLength={60} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder='Front door' />
          </div>

          {draft.zoneKind === 'box' && (
            <div className='space-y-2'>
              <Label htmlFor='question'>Question about the box</Label>
              <Input id='question' maxLength={300} value={draft.question} onChange={(e) => set({ question: e.target.value })} placeholder='Is the gate open?' />
            </div>
          )}

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

          {(problem || save.isError) && <Notice tone='error'>{problem ?? save.error?.message}</Notice>}

          <div className='flex gap-2'>
            <Button type='submit' disabled={save.isPending}>
              {save.isPending && <Loader2 className='animate-spin' />}
              Save rule
            </Button>
            <Button variant='outline' onClick={onDone}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SavedRules({ camera, rules, loading }: { camera: Camera; rules: SavedRule[] | undefined; loading: boolean }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: number) => api.removeRule(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['rules'] }),
  });

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Rules on this camera</CardTitle>
          <CardDescription>Each one watches its zone and alerts on Telegram.</CardDescription>
        </div>
        {rules && <Badge variant='muted'>{rules.length}</Badge>}
      </CardHeader>
      <CardContent>
        {loading && <Skeleton className='h-16' />}
        {rules?.length === 0 && <p className='text-muted-foreground text-sm'>No rules yet. Use a suggestion, or select an outline on the picture.</p>}
        <ul className='divide-y'>
          {rules?.map((r) => (
            <li key={r.id} className='flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0'>
              <div className='min-w-0 space-y-1.5'>
                <p className='text-sm'>{r.sentence}</p>
                <div className='flex flex-wrap gap-1.5'>
                  <Badge variant='outline'>{r.zone.name}</Badge>
                  <Badge variant='muted'>{r.zone.kind === 'outline' ? 'SAM outline' : 'Drawn box'}</Badge>
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
                  if (confirm(`Remove the rule “${r.sentence}”? ${camera.name} stops watching ${r.zone.name}.`)) remove.mutate(r.id);
                }}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
        {remove.isError && <Notice tone='error' className='mt-3'>{remove.error.message}</Notice>}
      </CardContent>
    </Card>
  );
}
