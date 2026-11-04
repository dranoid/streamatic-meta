import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Compass, Loader2, X } from 'lucide-react';
import { NeedsKeys } from '@/components/needs-keys';
import { PictureFrame } from '@/components/picture-frame';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Link } from '@/components/ui/link';
import { Notice } from '@/components/ui/notice';
import { VoiceNote } from '@/components/voice-note';
import { useAbilities } from '@/lib/abilities';
import { api, type CameraOffer, type DemoAlert, type DemoClip, type DemoRule, type DemoZone, type GuidePlan, type PlanAttempt } from '@/lib/api';
import { cn } from '@/lib/cn';
import { RULE_FINISHED } from '@/lib/setup-progress';
import { clockTime, sentence as asSentence } from '@/lib/time';

const POLL_MS = 1_500;
// Long enough to see where the zones are before the guide moves on.
const ZONES_SHOWN_MS = 1_800;
const OFFER_COLOUR = '#e8c547';

function runningLine(rule: DemoRule | undefined): string {
  if (rule?.status === 'probing') return 'Checking that this clip can answer the rule';
  if (rule?.status === 'asking') {
    const { done, total } = rule.progress;
    return total ? `Running the rule over the clip: ${done} of ${total} parts` : 'Running the rule over the clip';
  }
  return 'Reading the rule';
}

function zonesOf(clip: DemoClip, plan: GuidePlan): DemoZone[] {
  const wanted = new Set([...plan.zones, ...(plan.box?.over ? [plan.box.over] : [])].map((n) => n.toLowerCase()));
  return clip.zones.filter((z) => wanted.has(z.name.toLowerCase()));
}

// What is on the guide's screen: each stage appears when it starts and is ticked by code when the page shows it done.
type Run =
  | { stage: 'choosing'; sentence: string }
  | { stage: 'offer'; sentence: string; elsewhere: CameraOffer[] }
  | { stage: 'planning'; sentence: string; stayed: boolean }
  | { stage: 'not-planned'; sentence: string; problems: string[]; attempts: number }
  | { stage: 'zones' | 'running'; sentence: string; plan: GuidePlan | null; attempts: PlanAttempt[] };

// The guide on a clip. One sentence, and it does the rest on this page: it checks this is the camera to use, plans the rule, shows the
// zones on the player and runs the rule through Streamatic. The one thing it asks for is the confirmation to add the finished rule.
export function DemoGuide({
  clip,
  cameraName,
  ask,
  added,
  onShowZones,
  onAdd,
  onTyped,
}: {
  clip: DemoClip;
  cameraName: string;
  // A sentence brought from the page that chose this camera, run at once.
  ask: string | null;
  added: (rule: string) => boolean;
  onShowZones: (zones: DemoZone[] | null) => void;
  onAdd: (rule: string, firstAlert: DemoAlert | null) => void;
  onTyped: () => void;
}) {
  const { models, rules: canRunRules } = useAbilities();
  const [text, setText] = useState(ask ?? '');
  const [run, setRun] = useState<Run | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [ruleId, setRuleId] = useState<string | null>(null);
  // A newer sentence, or Stop, leaves an older run to finish with nobody listening.
  const current = useRef(0);

  const stop = () => {
    current.current += 1;
    setRun(null);
    setRuleId(null);
    setProblem(null);
    onShowZones(null);
  };

  const runRule = async (me: number, sentence: string, rule: { text: string } | { plan: GuidePlan }, plan: GuidePlan | null, attempts: PlanAttempt[]) => {
    const { id } = await api.addToClip(clip.id, rule);
    if (current.current !== me) return;
    setRuleId(id);
    setRun({ stage: 'running', sentence, plan, attempts });
  };

  const start = async (sentence: string, { stay = false } = {}) => {
    const me = (current.current += 1);
    const alive = () => current.current === me;
    setProblem(null);
    setRuleId(null);
    onShowZones(null);
    try {
      if (!stay) {
        setRun({ stage: 'choosing', sentence });
        const { elsewhere } = await api.routeFromClip(clip.id, sentence);
        if (!alive()) return;
        if (elsewhere.length > 0) {
          setRun({ stage: 'offer', sentence, elsewhere });
          return;
        }
      }
      setRun({ stage: 'planning', sentence, stayed: stay });
      const planned = await api.planOnClip(clip.id, sentence);
      if (!alive()) return;
      if (planned.status !== 'ready') {
        setRun({ stage: 'not-planned', sentence, problems: planned.problems, attempts: planned.attempts.length });
        return;
      }
      setRun({ stage: 'zones', sentence, plan: planned.plan, attempts: planned.attempts });
      onShowZones(zonesOf(clip, planned.plan));
      await new Promise((done) => setTimeout(done, ZONES_SHOWN_MS));
      if (!alive()) return;
      await runRule(me, sentence, { plan: planned.plan }, planned.plan, planned.attempts);
    } catch (error) {
      if (alive()) {
        setProblem((error as Error).message);
        setRun(null);
        onShowZones(null);
      }
    }
  };

  // A sentence from the page that chose this camera starts here at once, and only once.
  const askedOnce = useRef(false);
  useEffect(() => {
    if (!ask || askedOnce.current || !models) return;
    askedOnce.current = true;
    void start(ask, { stay: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask, models]);

  const rule = useQuery({
    queryKey: ['clip-rule', clip.id, ruleId],
    queryFn: () => api.clipRule(clip.id, ruleId!),
    enabled: ruleId !== null,
    refetchInterval: (query) => (query.state.data && RULE_FINISHED.has(query.state.data.status) ? false : POLL_MS),
  });
  const reading = rule.data;
  const ready = reading?.status === 'ready';
  const alertsFound = useQuery({
    queryKey: ['guide-alerts', clip.id, ruleId],
    queryFn: () => api.demoAlerts(clip.id, [{ rule: ruleId!, armedMs: 0 }]),
    enabled: ready,
  });
  const alerts = [...(alertsFound.data?.alerts ?? [])].sort((a, b) => a.atMs - b.atMs);
  useEffect(() => {
    if (ready) onTyped();
  }, [ready, onTyped]);
  const isAdded = ruleId !== null && added(ruleId);
  useEffect(() => {
    if (isAdded) onShowZones(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdded]);

  const busy = run !== null && run.stage !== 'offer' && run.stage !== 'not-planned' && !(run.stage === 'running' && reading !== undefined && RULE_FINISHED.has(reading.status));
  const plan = run && (run.stage === 'zones' || run.stage === 'running') ? run.plan : null;
  const attempts = run && (run.stage === 'zones' || run.stage === 'running') ? run.attempts : [];
  const rejected = attempts.filter((a) => a.problems.length > 0);
  const shownZones = plan ? zonesOf(clip, plan) : [];
  const clockNote = plan?.hours ? `This clip’s clock runs from ${clockTime(clip.startsAt)} to ${clockTime(clip.startsAt + clip.lengthMs)}, so a rule limited to other hours will not alert on it.` : null;
  const stageIndex = !run ? -1 : run.stage === 'choosing' ? 0 : run.stage === 'planning' ? 1 : run.stage === 'zones' ? 2 : run.stage === 'running' ? 3 : -1;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className='flex items-center gap-2'>
            <Compass className='text-primary size-4' />
            Guide
          </CardTitle>
          <CardDescription>Say what this camera should monitor. Streamatic does the rest on this page, and asks you only to confirm the finished rule.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className='space-y-3'>
        <form
          className='flex flex-wrap items-center gap-2'
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void start(text.trim());
          }}
        >
          <Input aria-label='What should this camera monitor?' className='min-w-48 flex-1' maxLength={300} disabled={!models} value={text} onChange={(e) => setText(e.target.value)} placeholder='Tell me when someone stops by the entrance.' />
          <Button type='submit' disabled={!models || !canRunRules || text.trim().length < 3 || busy}>
            {busy ? <Loader2 className='animate-spin' /> : <Compass />}
            Add rule
          </Button>
          {run && (
            <Button type='button' variant='outline' onClick={stop}>
              <X />
              {busy ? 'Stop' : 'Clear'}
            </Button>
          )}
        </form>
        <VoiceNote disabled={!models} read={(audio) => api.voiceNoteOnClip(clip.id, audio)} onText={setText} />
        {!models && <NeedsKeys />}
        {models && !run && !problem && clip.suggestions.length > 0 && (
          <div className='flex flex-wrap items-center gap-1.5'>
            {clip.suggestions.slice(0, 3).map((s) => (
              <Button key={s} type='button' size='sm' variant='outline' className='h-auto max-w-full shrink whitespace-normal py-1 text-left text-xs' onClick={() => setText(s)}>
                {s}
              </Button>
            ))}
          </div>
        )}
        {problem && <Notice tone='error'>{problem}</Notice>}

        {run?.stage === 'offer' && (
          <div className='space-y-3'>
            <Notice>Setup did not outline that on this camera. It did on {run.elsewhere.map((c) => c.name).join(' and ')}.</Notice>
            <div className='grid gap-3 sm:grid-cols-2'>
              {run.elsewhere.map((offer) => (
                <OfferCard key={offer.camera} offer={offer} sentence={run.sentence} />
              ))}
            </div>
            <Button variant='outline' size='sm' onClick={() => void start(run.sentence, { stay: true })}>
              Stay on this camera
            </Button>
          </div>
        )}

        {run?.stage === 'not-planned' && (
          <div className='space-y-2'>
            <Notice>
              The guide could not plan this rule on this camera’s zones after {run.attempts} attempts. {run.problems.join(' ')}
            </Notice>
            <Button
              variant='outline'
              size='sm'
              onClick={() => {
                const me = (current.current += 1);
                void runRule(me, run.sentence, { text: run.sentence }, null, []).catch((error: Error) => setProblem(error.message));
              }}
            >
              Run the rule as written
            </Button>
          </div>
        )}

        {stageIndex >= 0 && (
          <ol className='space-y-1.5 text-sm' aria-label='What the guide is doing' aria-live='polite'>
            <Stage state={stageIndex > 0 ? 'done' : 'now'} title='Choosing the camera'>
              {stageIndex > 0 ? `Using ${cameraName}.` : null}
            </Stage>
            {stageIndex >= 1 && (
              <Stage state={stageIndex > 1 ? 'done' : 'now'} title='Planning the rule'>
                {plan && (
                  <>
                    <p>Watches for: {plan.about}</p>
                    {plan.box && <p>A box{plan.box.over ? ` over the ${plan.box.over}` : ''}: {plan.box.question}</p>}
                    <p>{rejected.length === 0 ? 'Checked against this camera’s zones: passed.' : `Checked against this camera’s zones: refused ${rejected.length === 1 ? 'once' : `${rejected.length} times`}, corrected, then passed.`}</p>
                    {rejected.map((a, i) => (
                      <p key={i}>Refused: {a.problems.join(' ')}</p>
                    ))}
                    {clockNote && <p>{clockNote}</p>}
                  </>
                )}
              </Stage>
            )}
            {stageIndex >= 2 && (
              <Stage state={stageIndex > 2 ? 'done' : 'now'} title='Placing the zones'>
                {shownZones.length > 0 ? `Outlined on the player: ${shownZones.map((z) => asSentence(z.name)).join(', ')}.` : 'This rule watches the whole picture.'}
              </Stage>
            )}
            {stageIndex >= 3 && (
              <Stage state={reading && RULE_FINISHED.has(reading.status) ? (ready ? 'done' : 'stopped') : 'now'} title='Running the rule through Streamatic'>
                {!reading || !RULE_FINISHED.has(reading.status) ? (
                  `${runningLine(reading)}. You can keep watching the clip meanwhile.`
                ) : ready ? (
                  <>
                    <p>Reads as: {reading.readsAs ?? reading.name}</p>
                    {!reading.canAnswer && <p>Streamatic may not be able to see this on this clip.</p>}
                  </>
                ) : reading.status === 'refused' ? (
                  <div className='space-y-2'>
                    <p>{reading.reason ?? 'Streamatic cannot watch for this as written.'}</p>
                    {reading.rewrites.map((r) => (
                      <Button
                        key={r}
                        type='button'
                        size='sm'
                        variant='outline'
                        className='h-auto max-w-full shrink whitespace-normal text-left'
                        onClick={() => {
                          setText(r);
                          void start(r, { stay: true });
                        }}
                      >
                        {r}
                      </Button>
                    ))}
                  </div>
                ) : (
                  'This rule could not be finished. Please try again.'
                )}
              </Stage>
            )}
          </ol>
        )}

        {ready && ruleId && !isAdded && alertsFound.data && (
          <div className='border-primary/50 bg-primary/5 space-y-2 rounded-lg border p-3'>
            <p className='text-sm font-medium'>
              {alerts.length === 0 ? 'This rule is ready. It raised no alert on this clip.' : `This rule is ready. It raised ${alerts.length === 1 ? '1 alert' : `${alerts.length} alerts`} on this clip.`}
            </p>
            <p className='text-muted-foreground text-xs'>A new rule waits 5 minutes after an alert before it can alert again, as it would on a live camera.</p>
            <Button size='sm' onClick={() => onAdd(ruleId, alerts[0] ?? null)}>
              <Check />
              {alerts.length === 0 ? 'Add the rule' : 'Add the rule and play the alert'}
            </Button>
          </div>
        )}
        {isAdded && <Notice>The rule is on this clip. {alerts.length === 0 ? 'It raised no alert here.' : 'Playing from just before its first alert.'}</Notice>}
      </CardContent>
    </Card>
  );
}

function Stage({ state, title, children }: { state: 'now' | 'done' | 'stopped'; title: string; children?: ReactNode }) {
  return (
    <li className='flex items-start gap-2.5'>
      {state === 'done' ? (
        <span className='bg-primary text-primary-foreground mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-full'>
          <Check className='size-3' />
        </span>
      ) : state === 'stopped' ? (
        <span className='text-muted-foreground mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-full border'>
          <X className='size-3' />
        </span>
      ) : (
        <Loader2 className='text-primary mt-0.5 size-4.5 shrink-0 animate-spin' />
      )}
      <div className='min-w-0'>
        <p className={cn(state === 'now' && 'font-medium')}>{title}</p>
        {children && <div className='text-muted-foreground mt-0.5 space-y-0.5 text-xs leading-relaxed'>{children}</div>}
      </div>
    </li>
  );
}

// A camera the sentence could go to, with the thing outlined on it. One without a recording here can show that but cannot run a rule.
export function OfferCard({ offer, sentence }: { offer: CameraOffer; sentence: string }) {
  const paths = offer.paths.map((d, i) => ({ key: String(i), d, colour: OFFER_COLOUR, style: 'fill' as const }));
  return (
    <div className='space-y-2 rounded-lg border p-2'>
      <PictureFrame src={offer.picture} alt={offer.name} paths={paths} />
      <div className='px-1'>
        <p className='truncate text-sm font-medium'>{offer.name}</p>
        <p className='text-muted-foreground text-xs'>Outlined here: {offer.zones.map(asSentence).join(', ')}.</p>
        {!offer.hasClip && <p className='text-muted-foreground mt-0.5 text-xs'>This camera has no recording here, so a rule cannot be run on it.</p>}
      </div>
      {offer.hasClip ? (
        <Link href={`/clips/${encodeURIComponent(offer.camera)}?ask=${encodeURIComponent(sentence)}`} className='bg-primary text-primary-foreground hover:bg-primary/90 mx-1 mb-1 inline-flex h-8 items-center rounded-md px-2.5 text-sm font-medium'>
          Use this camera
        </Link>
      ) : (
        <Link href={`/setup/${encodeURIComponent(offer.camera)}`} className='hover:bg-accent mx-1 mb-1 inline-flex h-8 items-center rounded-md border px-2.5 text-sm font-medium'>
          See its setup
        </Link>
      )}
    </div>
  );
}
