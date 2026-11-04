import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, CircleAlert, CircleCheck, LoaderCircle, Pencil, RotateCcw, Trash2, Wand2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { NeedsKeys } from '@/components/needs-keys';
import { PictureBusy, PictureFrame, ZONE_COLOURS, type DrawnPath } from '@/components/picture-frame';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Link } from '@/components/ui/link';
import { Notice } from '@/components/ui/notice';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { useAbilities } from '@/lib/abilities';
import { api, type DemoRule, type DemoSetup } from '@/lib/api';
import { cn } from '@/lib/cn';
import { RULE_FINISHED, progressOf, saveProgress, useRefreshRulesBeingAdded } from '@/lib/setup-progress';
import { sentence } from '@/lib/time';

const STEPS = [
  { title: 'Camera view', note: 'Streamatic starts from a still picture of what the camera sees. A live camera provides one by day, one at dusk and one at night.' },
  { title: 'Zones', note: 'Streamatic finds what is in view for this kind of site and outlines each item as a zone your rules can name. You can rename or delete a zone. Your changes apply only to what you see, and Reset returns them.' },
  { title: 'Rules', note: 'Select the rules you want on this camera, then add them.' },
] as const;
const ZONES_STEP = 1;
const LAST_STEP = STEPS.length - 1;

const ZONE_MS = 320;
const LONGEST_REVEAL_MS = 6_000;

// Counts up to `total`, one every `everyMs`, so that many zones can be taken in one at a time. Nothing is sent anywhere meanwhile.
function useReveal(total: number, everyMs: number, startKey: unknown): number {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(total);
      return;
    }
    setShown(0);
    let count = 0;
    const next = setInterval(() => {
      count += 1;
      setShown(count);
      if (count >= total) clearInterval(next);
    }, everyMs);
    return () => clearInterval(next);
  }, [total, everyMs, startKey]);
  return shown;
}

export function SetupPage() {
  const cameras = useQuery({ queryKey: ['demo-cameras'], queryFn: api.demoCameras });
  return (
    <>
      <PageHeader icon={<Wand2 />} title='Setup' description='Select a camera to set it up. Streamatic finds what is in view, outlines each item as a zone and suggests rules for you to add.' />
      {cameras.isError && <Notice tone='error'>The cameras could not be loaded. Please reload the page.</Notice>}
      <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
        {cameras.isPending && [0, 1, 2, 3].map((i) => <Skeleton key={i} className='aspect-[4/3] rounded-xl' />)}
        {cameras.data?.map((camera) => (
          <Link
            key={camera.id}
            href={`/setup/${encodeURIComponent(camera.id)}`}
            className='group bg-card hover:border-primary/50 focus-visible:ring-ring/50 flex flex-col overflow-hidden rounded-xl border shadow-sm transition-colors outline-none focus-visible:ring-[3px]'
          >
            <PictureFrame src={camera.picture} alt={camera.name} className='rounded-none' />
            <div className='flex flex-1 items-center justify-between gap-2 p-4'>
              <div className='min-w-0'>
                <p className='font-semibold'>{camera.name}</p>
                <Badge variant='outline' className='mt-2'>
                  {camera.setUp ? 'Ready' : 'Not set up'}
                </Badge>
              </div>
              <ArrowRight className='text-muted-foreground group-hover:text-foreground size-4 shrink-0 transition-colors' />
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}

type Stage = 'start' | number | 'ready';

export function SetupCameraPage({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const cameras = useQuery({ queryKey: ['demo-cameras'], queryFn: api.demoCameras });
  const setup = useQuery({ queryKey: ['demo-setup', id], queryFn: () => api.demoSetup(id), staleTime: Infinity });
  const hasClip = cameras.data?.find((c) => c.id === id)?.hasClip ?? false;
  const clip = useQuery({ queryKey: ['demo-clip', id], queryFn: () => api.demoClip(id), enabled: hasClip });
  const name = cameras.data?.find((c) => c.id === id)?.name ?? 'Camera';
  const [progress, setProgress] = useState(() => progressOf(id));
  const [stage, setStage] = useState<Stage>('start');
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  // Where the person was going when they were sent here to set this camera up.
  const [next] = useState(() => new URLSearchParams(location.search).get('next'));
  const asked = next ? new URLSearchParams(next.split('?')[1] ?? '').get('ask') : null;
  const refreshClip = useCallback(() => void queryClient.invalidateQueries({ queryKey: ['demo-clip', id] }), [queryClient, id]);
  const refreshWhatIsSetUp = useCallback(() => {
    for (const queryKey of [['clips-list'], ['demo-cameras'], ['demo-events']]) void queryClient.invalidateQueries({ queryKey });
  }, [queryClient]);
  useRefreshRulesBeingAdded(id, clip.data?.rules ?? [], refreshClip);
  // The server says what this person has set up; what this browser remembers only says how far through the steps they got.
  const placed = useRef(false);
  useEffect(() => {
    if (!setup.data || placed.current) return;
    placed.current = true;
    if (setup.data.live) setStage(progress.ready ? 'ready' : 0);
    else if (progress.ready) {
      saveProgress(id, null);
      setProgress(progressOf(id));
    }
  }, [setup.data, progress.ready, id]);

  const finish = (offered: string[], added: string[], failed: string | null) => {
    const next = { ready: true, offered, added: [...progress.added, ...added] };
    saveProgress(id, next);
    setProgress(next);
    setProblem(failed);
    setStage('ready');
    refreshClip();
  };
  const zonesChanged = useCallback(
    (next: DemoSetup) => {
      queryClient.setQueryData(['demo-setup', id], next);
      refreshClip();
    },
    [queryClient, id, refreshClip],
  );
  const reset = useMutation({
    mutationFn: async () => {
      await Promise.all(progress.added.map((rule) => api.removeClipRule(id, rule).catch(() => null)));
      return api.resetDemoZones(id);
    },
    onSuccess: (next) => {
      zonesChanged(next);
      saveProgress(id, null);
      setProgress(progressOf(id));
      setConfirmingReset(false);
      setProblem(null);
      setStage('start');
      refreshClip();
      refreshWhatIsSetUp();
    },
  });
  const { models } = useAbilities();
  const running = useMutation({
    mutationFn: () => api.runDemoSetup(id),
    onSuccess: (found) => {
      zonesChanged(found);
      refreshWhatIsSetUp();
      setStage(0);
    },
  });
  const hasProgress = progress.ready || progress.added.length > 0 || setup.data?.edited === true || setup.data?.live === true;

  return (
    <div className='mx-auto max-w-4xl'>
      <PageHeader
        trail={[{ href: '/setup', label: 'Setup' }]}
        icon={<Wand2 />}
        title={name}
        badges={<Badge variant='outline'>{setup.data?.live ? 'Ready' : 'Not set up'}</Badge>}
        actions={
          <Button size='sm' variant='outline' disabled={!hasProgress || reset.isPending} onClick={() => setConfirmingReset(true)}>
            <RotateCcw />
            Reset
          </Button>
        }
      />
      {confirmingReset && (
        <Notice className='mb-4'>
          <p>
            Reset this camera? It returns to not set up.{setup.data?.edited ? ' Its zones return to what setup found.' : ''}{progress.added.length > 0 ? ` The ${progress.added.length === 1 ? 'rule' : `${progress.added.length} rules`} added from setup will be removed from its clip.` : ''}
          </p>
          {reset.isError && <p className='text-destructive mt-1 text-xs'>{reset.error.message}</p>}
          <div className='mt-2 flex flex-wrap gap-2'>
            <Button size='sm' disabled={reset.isPending} onClick={() => reset.mutate()}>
              {reset.isPending && <LoaderCircle className='animate-spin' />}
              Reset
            </Button>
            <Button size='sm' variant='outline' onClick={() => setConfirmingReset(false)}>
              Cancel
            </Button>
          </div>
        </Notice>
      )}
      {next && !setup.data?.live && <Notice className='mb-4'>{asked ? `Set this camera up first. “${asked}” continues on its clip afterwards.` : 'Set this camera up first. Its clip opens afterwards.'}</Notice>}
      {setup.isError && <Notice tone='error'>{setup.error.message}</Notice>}
      {setup.isPending && <Skeleton className='aspect-video rounded-xl' />}
      {setup.data && stage === 'start' && (
        <Card>
          <CardContent className='space-y-4'>
            <PictureFrame src={setup.data.picture} alt={`The view from ${name}`}>
              {running.isPending && <PictureBusy label='Finding what is in view' />}
            </PictureFrame>
            <div>
              <p className='text-sm'>Setup runs now on this picture. Streamatic finds what is in view, outlines each item as a zone, and suggests rules for you to add. This usually takes a minute or two, and the result can differ a little from one run to the next.</p>
              {!models && <p className='text-muted-foreground mt-1 text-xs'>Without keys, each step shows the result saved with this copy.</p>}
            </div>
            {running.isError && <Notice tone='error'>{running.error.message}</Notice>}
            <Button disabled={running.isPending} onClick={() => running.mutate()}>
              {running.isPending ? <LoaderCircle className='animate-spin' /> : <Wand2 />}
              {running.isPending ? 'Setting up this camera' : 'Set up this camera'}
            </Button>
          </CardContent>
        </Card>
      )}
      {setup.data && typeof stage === 'number' && <Steps key={id} setup={setup.data} step={stage} onStep={setStage} clipRules={clip.data?.rules ?? []} chosenBefore={progress.offered} clip={id} onFinish={finish} name={name} onZonesChanged={zonesChanged} />}
      {setup.data && stage === 'ready' && <Ready id={id} next={next} setup={setup.data} rules={clip.data?.rules ?? []} offered={progress.offered} added={progress.added} problem={problem} />}
    </div>
  );
}

function Steps({
  setup,
  step,
  onStep,
  clip,
  clipRules,
  chosenBefore,
  onFinish,
  name,
  onZonesChanged,
}: {
  setup: DemoSetup;
  step: number;
  onStep: (step: number) => void;
  clip: string;
  clipRules: DemoRule[];
  chosenBefore: string[];
  onFinish: (offered: string[], added: string[], problem: string | null) => void;
  name: string;
  onZonesChanged: (next: DemoSetup) => void;
}) {
  // The zones are revealed once, as many as setup found, so renaming or deleting one does not start the reveal again.
  const [zonesToReveal] = useState(setup.zones.length);
  const revealed = useReveal(step === ZONES_STEP ? zonesToReveal : 0, Math.min(ZONE_MS, LONGEST_REVEAL_MS / Math.max(1, zonesToReveal)), step);
  // Among many like zones, a row shows which one it is by drawing that zone alone.
  const [pointedAt, setPointedAt] = useState<string | null>(null);
  const allRevealed = revealed >= zonesToReveal;
  const zones = allRevealed ? setup.zones : setup.zones.slice(0, revealed);
  const stepDone = step === ZONES_STEP ? allRevealed : true;
  const [label, setLabel] = useState(setup.pictures[0]!.label);
  const manyPictures = setup.pictures.length > 1;
  const lastLabel = setup.pictures[setup.pictures.length - 1]!.label;
  const paths = useMemo<DrawnPath[]>(
    () =>
      step !== ZONES_STEP
        ? []
        : zones.flatMap((zone, i) => (pointedAt !== null && pointedAt !== zone.name ? [] : (zone.pathsBy[label] ?? [])).map((d, j) => ({ key: `${zone.name}-${j}`, d, colour: ZONE_COLOURS[i % ZONE_COLOURS.length]!, style: 'fill' as const, title: sentence(zone.name), group: zone.name }))),
    [zones, step, label, pointedAt],
  );

  return (
    <Card>
      <CardHeader className='flex-col gap-4'>
        <ol aria-label='Setup steps' className='flex w-full items-center gap-2'>
          {STEPS.map((s, i) => (
            <li key={s.title} aria-current={i === step ? 'step' : undefined} className='flex flex-none items-center gap-2'>
              {i < step ? (
                <span className='bg-primary text-primary-foreground flex size-5 items-center justify-center rounded-full'>
                  <Check className='size-3.5' />
                </span>
              ) : (
                <span className={cn('flex size-5 items-center justify-center rounded-full border text-xs tabular-nums', i === step && 'border-primary text-primary')}>{i + 1}</span>
              )}
              <span className={cn('text-xs', i === step ? 'font-medium' : 'text-muted-foreground hidden sm:inline')}>{s.title}</span>
              {i < LAST_STEP && <span className='bg-border h-px w-4 sm:w-8' aria-hidden />}
            </li>
          ))}
        </ol>
        <div>
          <CardTitle>{STEPS[step]!.title}</CardTitle>
          <CardDescription>{STEPS[step]!.note}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className='space-y-4'>
        {step === 0 && manyPictures ? (
          <div className='grid gap-2 sm:grid-cols-3'>
            {setup.pictures.map((picture) => (
              <figure key={picture.label} className='space-y-1'>
                <PictureFrame src={picture.src} alt={`The view from ${name}: ${picture.label}`} />
                <figcaption className='text-muted-foreground text-xs'>{sentence(picture.label)}</figcaption>
              </figure>
            ))}
          </div>
        ) : (
          step < LAST_STEP && (
            <PictureFrame src={step === ZONES_STEP ? setup.pictures.find((p) => p.label === label)!.src : setup.picture} alt={`The view from ${name}`} paths={paths} />
          )
        )}
        {step === ZONES_STEP && manyPictures && <Segmented label='Picture' value={label} options={setup.pictures.map((p) => ({ value: p.label, label: sentence(p.label) }))} onChange={setLabel} />}
        {step === ZONES_STEP && (
          <>
            <p className='text-muted-foreground text-xs' role='status'>
              {!allRevealed ? `Found ${revealed + 1} of ${zonesToReveal}: ${sentence(setup.zones[revealed]?.name ?? '')}` : zonesInPlace(setup.zones.length)}
            </p>
            <ul aria-label='Zones' className='grid max-h-80 min-h-16 content-start items-start gap-2 overflow-y-auto sm:grid-cols-2' onMouseLeave={() => setPointedAt(null)} onBlur={() => setPointedAt(null)}>
              {zones.map((zone, i) => (
                <ZoneRow
                  key={zone.name}
                  onPoint={() => setPointedAt(zone.name)}
                  zone={zone.name}
                  colour={ZONE_COLOURS[i % ZONE_COLOURS.length]!}
                  note={manyPictures && !zone.seenAt.includes(lastLabel) ? `Uncertain at ${lastLabel}` : null}
                  rulesOnIt={clipRules.filter((r) => r.kind === 'typed' && r.zones.some((z) => z.name === zone.name)).length}
                  canEdit={allRevealed}
                  clip={clip}
                  onChanged={onZonesChanged}
                />
              ))}
            </ul>
          </>
        )}
        {step === LAST_STEP ? (
          <RulesStep setup={setup} clip={clip} clipRules={clipRules} chosenBefore={chosenBefore} onBack={() => onStep(step - 1)} onFinish={onFinish} />
        ) : (
          <div className='flex flex-wrap items-center gap-2'>
            <Button size='sm' variant='outline' disabled={step === 0} onClick={() => onStep(step - 1)}>
              <ArrowLeft />
              Back
            </Button>
            <Button size='sm' disabled={!stepDone} onClick={() => onStep(step + 1)}>
              Next
              <ArrowRight />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const zonesInPlace = (count: number) => (count === 0 ? 'No zones are in place.' : count === 1 ? '1 zone is in place.' : `${count} zones are in place.`);

function ZoneRow({ zone, colour, note, rulesOnIt, canEdit, clip, onChanged, onPoint }: { zone: string; colour: string; note: string | null; rulesOnIt: number; canEdit: boolean; clip: string; onChanged: (next: DemoSetup) => void; onPoint: () => void }) {
  const [mode, setMode] = useState<'shown' | 'renaming' | 'deleting'>('shown');
  const [draft, setDraft] = useState(sentence(zone));
  const rename = useMutation({ mutationFn: (name: string) => api.renameDemoZone(clip, zone, name), onSuccess: onChanged });
  const remove = useMutation({ mutationFn: () => api.deleteDemoZone(clip, zone), onSuccess: onChanged });
  const problem = rename.error?.message ?? remove.error?.message ?? null;
  const save = (e: FormEvent) => {
    e.preventDefault();
    const name = draft.trim();
    if (name === sentence(zone)) setMode('shown');
    else rename.mutate(name);
  };

  return (
    <li className='animate-in fade-in hover:bg-accent/50 min-w-0 rounded-lg border px-3 py-2 text-sm' onMouseEnter={onPoint} onFocus={onPoint}>
      {mode === 'renaming' ? (
        <form onSubmit={save} className='flex flex-wrap items-center gap-2'>
          <span className='size-2.5 shrink-0 rounded-full' style={{ background: colour }} aria-hidden />
          <Input aria-label={`New name for ${sentence(zone)}`} value={draft} maxLength={60} autoFocus className='h-8 max-w-64 min-w-40 flex-1' onChange={(e) => setDraft(e.target.value)} />
          <Button size='sm' type='submit' disabled={rename.isPending || draft.trim().length === 0}>
            {rename.isPending && <LoaderCircle className='animate-spin' />}
            Save
          </Button>
          <Button size='sm' type='button' variant='outline' disabled={rename.isPending} onClick={() => { rename.reset(); setDraft(sentence(zone)); setMode('shown'); }}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className='flex flex-wrap items-center gap-2'>
          <span className='size-2.5 shrink-0 rounded-full' style={{ background: colour }} aria-hidden />
          <span className='min-w-0 flex-1 font-medium'>
            {sentence(zone)}
            {note && <span className='text-muted-foreground ml-2 text-xs font-normal'>{note}</span>}
          </span>
          {canEdit && mode === 'shown' && (
            <span className='flex gap-1'>
              <Button size='sm' variant='ghost' aria-label={`Rename ${sentence(zone)}`} title='Rename' className='size-8 p-0' onClick={() => setMode('renaming')}>
                <Pencil />
              </Button>
              <Button size='sm' variant='ghost' aria-label={`Delete ${sentence(zone)}`} title='Delete' className='size-8 p-0' onClick={() => setMode('deleting')}>
                <Trash2 />
              </Button>
            </span>
          )}
        </div>
      )}
      {mode === 'deleting' && (
        <div className='mt-3 space-y-2'>
          <p className='text-sm'>
            Delete the zone “{sentence(zone)}”? It will no longer be outlined on this camera, and new rules cannot name it.
            {rulesOnIt > 0 && ` ${rulesOnIt === 1 ? 'The 1 rule that uses it stays on the clip and keeps' : `The ${rulesOnIt} rules that use it stay on the clip and keep`} watching that place.`}
          </p>
          <div className='flex flex-wrap gap-2'>
            <Button size='sm' disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending && <LoaderCircle className='animate-spin' />}
              Delete
            </Button>
            <Button size='sm' variant='outline' disabled={remove.isPending} onClick={() => { remove.reset(); setMode('shown'); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {problem && <p className='text-destructive mt-2 text-xs' role='alert'>{problem}</p>}
    </li>
  );
}

function RulesStep({ setup, clip, clipRules, chosenBefore, onBack, onFinish }: { setup: DemoSetup; clip: string; clipRules: DemoRule[]; chosenBefore: string[]; onBack: () => void; onFinish: (offered: string[], added: string[], problem: string | null) => void }) {
  const { rules: canRunRules } = useAbilities();
  const offered = clipRules.filter((r) => r.kind === 'offered');
  const alreadyAdded = new Set(clipRules.filter((r) => r.kind === 'typed').map((r) => r.text));
  const suggested = setup.rules.filter((text) => !alreadyAdded.has(text));
  // A rule already run on this clip costs nothing to select, so those start selected; a suggested rule must be run first, so it is the person's choice.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const chosen = picked ?? new Set(chosenBefore.length > 0 ? chosenBefore : offered.map((r) => r.id));
  const toggle = (key: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(key);
    else next.delete(key);
    setPicked(next);
  };
  const adding = useMutation({
    mutationFn: async () => {
      const added: string[] = [];
      let problem: string | null = null;
      for (const text of suggested.filter((s) => chosen.has(s))) {
        try {
          added.push((await api.addToClip(clip, { text })).id);
        } catch (error) {
          problem = (error as Error).message;
          break;
        }
      }
      return { added, problem };
    },
    onSuccess: ({ added, problem }) => onFinish(offered.filter((r) => chosen.has(r.id)).map((r) => r.id), added, problem),
  });
  const chosenCount = offered.filter((r) => chosen.has(r.id)).length + suggested.filter((s) => chosen.has(s)).length;

  return (
    <div className='space-y-4'>
      {offered.length > 0 && (
        <fieldset className='space-y-2'>
          <legend className='text-sm font-medium'>Ready to use</legend>
          <p className='text-muted-foreground text-xs'>These rules have already run on this clip, so their alerts are available at once.</p>
          {offered.map((rule) => (
            <RuleChoice key={rule.id} label={rule.name} checked={chosen.has(rule.id)} disabled={adding.isPending} onChange={(on) => toggle(rule.id, on)} />
          ))}
        </fieldset>
      )}
      {suggested.length > 0 && (
        <fieldset className='space-y-2'>
          <legend className='text-sm font-medium'>Suggested for this camera</legend>
          <p className='text-muted-foreground text-xs'>{setup.hasClip ? 'Streamatic runs each of these over the clip first. You can go on to the clip while it runs.' : 'This camera has no recording here, so these rules cannot be run on this page.'}</p>
          {suggested.map((text) => (
            <RuleChoice key={text} label={text} checked={chosen.has(text)} disabled={adding.isPending || !canRunRules || !setup.hasClip} onChange={(on) => toggle(text, on)} />
          ))}
        </fieldset>
      )}
      {!canRunRules && setup.hasClip && <NeedsKeys />}
      {adding.isError && <Notice tone='error'>{adding.error.message}</Notice>}
      <div className='flex flex-wrap items-center gap-2'>
        <Button size='sm' variant='outline' disabled={adding.isPending} onClick={onBack}>
          <ArrowLeft />
          Back
        </Button>
        <Button size='sm' disabled={adding.isPending} onClick={() => adding.mutate()}>
          {adding.isPending ? <LoaderCircle className='animate-spin' /> : <Check />}
          {!setup.hasClip ? 'Continue' : chosenCount === 0 ? 'Continue without rules' : `Add ${chosenCount === 1 ? '1 rule' : `${chosenCount} rules`}`}
        </Button>
      </div>
    </div>
  );
}

function RuleChoice({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className={cn('hover:bg-accent flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm transition-colors', disabled && 'cursor-not-allowed opacity-60')}>
      <input type='checkbox' className='accent-primary mt-0.5 size-4' checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className='min-w-0 font-medium'>{label}</span>
    </label>
  );
}

function Ready({ id, next, setup, rules, offered, added, problem }: { id: string; next: string | null; setup: DemoSetup; rules: DemoRule[]; offered: string[]; added: string[]; problem: string | null }) {
  const chosen = [...offered, ...added].flatMap((rule) => rules.filter((r) => r.id === rule));
  const paths = useMemo<DrawnPath[]>(
    () => setup.zones.flatMap((zone, i) => (zone.pathsBy[setup.pictures[0]!.label] ?? []).map((d, j) => ({ key: `${zone.name}-${j}`, d, colour: ZONE_COLOURS[i % ZONE_COLOURS.length]!, style: 'fill' as const, title: sentence(zone.name), group: zone.name }))),
    [setup],
  );
  const hasAdded = chosen.some((r) => r.kind === 'typed');

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className='flex items-center gap-2'>
            <CircleCheck className='text-primary size-5' />
            This camera is ready
          </CardTitle>
          <CardDescription>
            {!setup.hasClip ? `${zonesInPlace(setup.zones.length)} This camera has no recording here, so its rules cannot be run on this page.` : `${zonesInPlace(setup.zones.length)} ${chosen.length === 0 ? 'No rules were added.' : chosen.length === 1 ? '1 rule was added.' : `${chosen.length} rules were added.`}`}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className='space-y-4'>
        <PictureFrame src={setup.picture} alt='The zones on this camera' paths={paths} />
        {problem && <Notice tone='error'>{problem}</Notice>}
        {chosen.length > 0 && (
          <ul aria-label='Rules on this camera' className='space-y-2'>
            {chosen.map((rule) => (
              <li key={rule.id} className='flex items-start gap-2.5 rounded-lg border p-3 text-sm'>
                {rule.status === 'ready' ? (
                  <Check className='text-primary mt-0.5 size-4 shrink-0' />
                ) : RULE_FINISHED.has(rule.status) ? (
                  <CircleAlert className='text-muted-foreground mt-0.5 size-4 shrink-0' />
                ) : (
                  <LoaderCircle className='text-primary mt-0.5 size-4 shrink-0 animate-spin' />
                )}
                <span className='min-w-0'>
                  <span className='font-medium'>{rule.kind === 'typed' ? rule.text : rule.name}</span>
                  <span className='text-muted-foreground mt-0.5 block text-xs'>
                    {rule.status === 'ready' ? 'Ready.' : RULE_FINISHED.has(rule.status) ? (rule.reason ?? 'This rule could not be added.') : 'Streamatic is running this rule over the clip. You can go to the clip now; it will be selected when it is ready.'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {hasAdded && <p className='text-muted-foreground text-xs'>A new rule waits 5 minutes after an alert before it can alert again, as it would on a live camera.</p>}
        <div className='flex flex-wrap items-center gap-2'>
          {setup.hasClip && (
          <Link href={next?.startsWith('/clips/') ? next : `/clips/${encodeURIComponent(id)}`} className='bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium [&_svg]:size-4'>
            {next ? 'Continue' : 'Go to the clip'}
            <ArrowRight />
          </Link>
          )}
          <Link href='/setup' className='hover:bg-accent inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium'>
            All cameras
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
