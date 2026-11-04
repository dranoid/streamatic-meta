import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Compass, Loader2, Play, X } from 'lucide-react';
import { NeedsKeys } from '@/components/needs-keys';
import { PictureFrame } from '@/components/picture-frame';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Link } from '@/components/ui/link';
import { Notice } from '@/components/ui/notice';
import { VoiceNote } from '@/components/voice-note';
import { useAbilities } from '@/lib/abilities';
import { api, type CameraOffer, type ClipAnswer, type DemoAlert, type DemoClip, type DemoRule, type DemoZone, type Follow, type GuidePlan, type PlanAttempt } from '@/lib/api';
import { cn } from '@/lib/cn';
import { RULE_FINISHED } from '@/lib/setup-progress';
import { clockTime, sentence as asSentence } from '@/lib/time';

const POLL_MS = 1_500;
const DETECTION_POLL_MS = 3_000;
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
  | { stage: 'search'; sentence: string }
  | { stage: 'asking' | 'detecting'; sentence: string }
  | { stage: 'answered'; sentence: string; answer: ClipAnswer }
  | { stage: 'zones' | 'running'; sentence: string; plan: GuidePlan | null; attempts: PlanAttempt[] };

// How the search for an item stands on the clip's own picture, which the guide reports stage by stage.
export type GuideFinding =
  | { stage: 'searching'; item: string }
  | { stage: 'none'; item: string; looks: number }
  | { stage: 'select'; item: string; count: number; at: number }
  | { stage: 'tracking'; item: string; framesDone: number; framesTotal: number; at: number }
  | { stage: 'done'; item: string; follows: Follow[]; fps: number };

const moment = (seconds: number) => `${Math.floor(Math.round(seconds) / 60)}:${String(Math.round(seconds) % 60).padStart(2, '0')}`;

// The guide on a clip. One sentence, and it does the rest on this page: it checks this is the camera to use, plans the rule, shows the
// zones on the player and runs the rule through Streamatic, whose alerts reach the clip's timeline as they are found.
export function DemoGuide({
  clip,
  cameraName,
  ask,
  onShowZones,
  onRuleRunning,
  onRuleProgress,
  onRuleDropped,
  onPlayAlert,
  onTyped,
  finding,
  onFindItem,
  onStopFinding,
  onMoment,
}: {
  clip: DemoClip;
  cameraName: string;
  // A sentence brought from the page that chose this camera, run at once.
  ask: string | null;
  onShowZones: (zones: DemoZone[] | null) => void;
  onRuleRunning: (rule: string) => void;
  // How much of the clip the running rule has read, from 0 to 1, or null when no rule is running.
  onRuleProgress: (share: number | null) => void;
  onRuleDropped: (rule: string) => void;
  onPlayAlert: (alert: DemoAlert) => void;
  onTyped: () => void;
  finding: GuideFinding | null;
  onFindItem: (item: string, words: string[]) => Promise<void>;
  onStopFinding: () => void;
  onMoment: (atMs: number) => void;
}) {
  const { models, rules: canRunRules } = useAbilities();
  const [text, setText] = useState(ask ?? '');
  const [run, setRun] = useState<Run | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [ruleId, setRuleId] = useState<string | null>(null);
  const [played, setPlayed] = useState(false);
  // A newer sentence, or Stop, leaves an older run to finish with nobody listening.
  const current = useRef(0);
  const unfinishedRule = useRef<string | null>(null);

  const leaveRule = () => {
    if (unfinishedRule.current) onRuleDropped(unfinishedRule.current);
    unfinishedRule.current = null;
    setRuleId(null);
    setPlayed(false);
  };

  const stop = () => {
    current.current += 1;
    setRun(null);
    leaveRule();
    setProblem(null);
    onShowZones(null);
    onStopFinding();
  };

  const runRule = async (me: number, sentence: string, rule: { text: string } | { plan: GuidePlan }, plan: GuidePlan | null, attempts: PlanAttempt[]) => {
    const { id } = await api.addToClip(clip.id, rule);
    if (current.current !== me) return;
    unfinishedRule.current = id;
    setRuleId(id);
    setRun({ stage: 'running', sentence, plan, attempts });
    onRuleRunning(id);
  };

  const start = async (sentence: string, { stay = false } = {}) => {
    const me = (current.current += 1);
    const alive = () => current.current === me;
    setProblem(null);
    leaveRule();
    onShowZones(null);
    onStopFinding();
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
      if (planned.status === 'search') {
        setRun({ stage: 'search', sentence });
        await onFindItem(planned.item, planned.words);
        return;
      }
      if (planned.status === 'question') {
        setRun({ stage: 'asking', sentence });
        let answer = await api.askClip(clip.id, sentence);
        while (alive() && 'status' in answer) {
          setRun({ stage: 'detecting', sentence });
          await new Promise((done) => setTimeout(done, DETECTION_POLL_MS));
          if (!alive()) return;
          const { detection } = await api.demoClip(clip.id);
          if (detection === 'failed') throw new Error('Streamatic could not detect what is on this clip. Please ask again.');
          if (detection === 'ready') {
            setRun({ stage: 'asking', sentence });
            answer = await api.askClip(clip.id, sentence);
          }
        }
        if (alive() && !('status' in answer)) setRun({ stage: 'answered', sentence, answer });
        return;
      }
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
  const finished = reading !== undefined && RULE_FINISHED.has(reading.status);
  const alertsFound = useQuery({
    queryKey: ['guide-alerts', clip.id, ruleId, ready],
    queryFn: () => api.demoAlerts(clip.id, [{ rule: ruleId!, armedMs: 0 }]),
    enabled: ruleId !== null,
    refetchInterval: finished ? false : POLL_MS,
    placeholderData: (previous) => previous,
  });
  const alerts = [...(alertsFound.data?.alerts ?? [])].sort((a, b) => a.atMs - b.atMs);
  useEffect(() => {
    if (ready) onTyped();
  }, [ready, onTyped]);
  const share = ruleId === null || finished ? null : reading?.progress.total ? reading.progress.done / reading.progress.total : 0;
  useEffect(() => {
    onRuleProgress(share);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [share]);
  useEffect(() => {
    if (!finished || !ruleId) return;
    unfinishedRule.current = null;
    if (!ready) onRuleDropped(ruleId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished, ready, ruleId]);
  const noneFound = ready && alertsFound.data !== undefined && alertsFound.data.alerts.length === 0;
  useEffect(() => {
    if (played || noneFound) onShowZones(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [played, noneFound]);

  const searchOver = finding?.stage === 'done' || finding?.stage === 'none';
  const busy = run !== null && run.stage !== 'offer' && run.stage !== 'not-planned' && run.stage !== 'answered' &&!(run.stage === 'search' && searchOver) && !(run.stage === 'running' && reading !== undefined && RULE_FINISHED.has(reading.status));
  const plan = run && (run.stage === 'zones' || run.stage === 'running') ? run.plan : null;
  const attempts = run && (run.stage === 'zones' || run.stage === 'running') ? run.attempts : [];
  const rejected = attempts.filter((a) => a.problems.length > 0);
  const shownZones = plan ? zonesOf(clip, plan) : [];
  const clockNote = plan?.hours ? `This clip’s clock runs from ${clockTime(clip.startsAt)} to ${clockTime(clip.startsAt + clip.lengthMs)}, so a rule limited to other hours will not alert on it.` : null;
  const stageIndex = !run ? -1 : run.stage === 'choosing' ? 0 : run.stage === 'planning' ? 1 : run.stage === 'zones' ? 2 : run.stage === 'running' ? 3 : -1;
  const isSearch = run?.stage === 'search';

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className='flex items-center gap-2'>
            <Compass className='text-primary size-4' />
            Ask Streamatic
          </CardTitle>
          <CardDescription>Say what this camera should monitor{clip.canCount ? ', name an item to find in the clip, or ask how many people passed a place' : ', or name an item to find in the clip'}. The rest runs automatically on this page, and you are asked only to select among the items found.</CardDescription>
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
          <Input aria-label='What should this camera monitor, or what should it find?' className='min-w-48 flex-1' maxLength={300} disabled={!models} value={text} onChange={(e) => setText(e.target.value)} placeholder='Tell me when someone stops by the entrance.' />
          <Button type='submit' disabled={!models || !canRunRules || text.trim().length < 3 || busy}>
            {busy ? <Loader2 className='animate-spin' /> : <Compass />}
            Start
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
        {models &&
          !run &&
          !problem &&
          [
            { label: 'Suggested rules', sentences: clip.suggestions.slice(0, 3) },
            { label: 'Suggested questions', sentences: clip.suggestedQuestions.slice(0, 3) },
          ]
            .filter(({ sentences }) => sentences.length > 0)
            .map(({ label, sentences }) => (
              <div key={label} className='space-y-1.5'>
                <p className='text-muted-foreground text-xs'>{label}</p>
                <div className='flex flex-wrap items-center gap-1.5'>
                  {sentences.map((s) => (
                    <Button
                      key={s}
                      type='button'
                      size='sm'
                      variant='outline'
                      className='h-auto max-w-full shrink whitespace-normal py-1 text-left text-xs'
                      disabled={!canRunRules}
                      onClick={() => {
                        setText(s);
                        // Each of these belongs to this clip, so no other camera is offered.
                        void start(s, { stay: true });
                      }}
                    >
                      {s}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
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
              Streamatic could not plan this rule on this camera’s zones after {run.attempts} attempts. {run.problems.join(' ')}
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

        {isSearch && finding && <SearchStages cameraName={cameraName} finding={finding} />}

        {run?.stage === 'asking' && (
          <ol className='space-y-1.5 text-sm' aria-label='What Streamatic is doing' aria-live='polite'>
            <Stage state='now' title='Counting from what was detected on this clip' />
          </ol>
        )}
        {run?.stage === 'detecting' && (
          <ol className='space-y-1.5 text-sm' aria-label='What Streamatic is doing' aria-live='polite'>
            <Stage state='now' title='Detecting people and objects on this clip'>
              Streamatic does this once for each clip and keeps the result. It usually takes about ten minutes, and your answer follows.
            </Stage>
          </ol>
        )}
        {run?.stage === 'answered' && <AnswerCard answer={run.answer} onMoment={onMoment} />}

        {stageIndex >= 0 && (
          <ol className='space-y-1.5 text-sm' aria-label='What Streamatic is doing' aria-live='polite'>
            <Stage state={stageIndex > 0 ? 'done' : 'now'} title='Choosing the camera'>
              {stageIndex > 0 ? `Using ${cameraName}.` : null}
            </Stage>
            {stageIndex >= 1 && (
              <Stage state={stageIndex > 1 ? 'done' : 'now'} title={plan ? 'Planning the rule' : 'Reading your request'}>
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
                  <>
                    <p>{runningLine(reading)}.</p>
                    {alerts.length > 0 && <p>{alerts.length === 1 ? '1 alert found so far.' : `${alerts.length} alerts found so far.`}</p>}
                    <p>Alerts appear on the timeline as they are found, and you can keep watching the clip meanwhile.</p>
                  </>
                ) : ready ? (
                  <p>Reads as: {reading.readsAs ?? reading.name}</p>
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

        {ready && ruleId && !played && alertsFound.data && (
          <div className='border-primary/50 bg-primary/5 space-y-2 rounded-lg border p-3'>
            <p className='text-sm font-medium'>
              {alerts.length === 0 ? 'This rule is ready. It raised no alert on this clip.' : `This rule is ready. It raised ${alerts.length === 1 ? '1 alert' : `${alerts.length} alerts`} on this clip.`}
            </p>
            <p className='text-muted-foreground text-xs'>A new rule waits 5 minutes after an alert before it can alert again, as it would on a live camera.</p>
            {alerts[0] && (
              <Button
                size='sm'
                onClick={() => {
                  setPlayed(true);
                  onPlayAlert(alerts[0]!);
                }}
              >
                <Play />
                Play the first alert
              </Button>
            )}
          </div>
        )}
        {played && <Notice>Playing from just before the rule’s first alert.</Notice>}
      </CardContent>
    </Card>
  );
}

function AnswerCard({ answer, onMoment }: { answer: ClipAnswer; onMoment: (atMs: number) => void }) {
  return (
    <div className='space-y-2 rounded-lg border p-3' aria-live='polite'>
      <p className='text-sm font-medium'>{answer.answer}</p>
      {answer.moments.length > 0 && (
        <div className='flex flex-wrap gap-1.5'>
          {answer.moments.map((m) => (
            <Button key={`${m.atMs}-${m.label}`} type='button' size='sm' variant='outline' className='h-auto py-1 text-xs' onClick={() => onMoment(m.atMs)}>
              {m.label}, {moment(m.atMs / 1000)}
            </Button>
          ))}
        </div>
      )}
      <p className='text-muted-foreground text-xs'>Counts are approximate. A tracker can lose someone, mix people up or count someone twice, and Streamatic can make mistakes, so please check anything important on the clip.</p>
    </div>
  );
}

// Each stage is ticked from what the clip's own picture has done.
function SearchStages({ cameraName, finding }: { cameraName: string; finding: GuideFinding }) {
  const { item } = finding;
  const found = finding.stage === 'select' || finding.stage === 'tracking' || finding.stage === 'done';
  const percent = finding.stage === 'tracking' && finding.framesTotal > 0 ? Math.round((finding.framesDone / finding.framesTotal) * 100) : 0;
  return (
    <ol className='space-y-1.5 text-sm' aria-label='What Streamatic is doing' aria-live='polite'>
      <Stage state='done' title='Choosing the camera'>{`Using ${cameraName}.`}</Stage>
      <Stage state={found ? 'done' : finding.stage === 'none' ? 'stopped' : 'now'} title={`Searching the clip for the ${item}`}>
        {finding.stage === 'none' && `The ${item} was not found on the ${finding.looks} frames searched. Pause where it appears, select Search this frame and draw a box around it.`}
        {(finding.stage === 'select' || finding.stage === 'tracking') && `Found on the frame at ${moment(finding.at)}.`}
      </Stage>
      {finding.stage === 'select' && (
        <Stage state='now' title='Selecting what to track'>
          {`${finding.count} items were found. Select up to 4 on the picture.`}
        </Stage>
      )}
      {(finding.stage === 'tracking' || finding.stage === 'done') && (
        <Stage state={finding.stage === 'done' ? 'done' : 'now'} title={`Tracking the ${item}`}>
          {finding.stage === 'tracking' && (percent > 0 ? `${percent}% of the frames so far.` : 'Preparing the frames around this moment.')}
          {finding.stage === 'done' &&
            finding.follows.map((f) => (
              <p key={f.id}>
                {f.spans.length === 0
                  ? `${asSentence(f.name)}: could not be tracked from this frame.`
                  : `${asSentence(f.name)}: in view ${f.spans.map((s) => `${moment(s.from / finding.fps)}–${moment((s.to + 1) / finding.fps)}`).join(', ')}.`}
              </p>
            ))}
        </Stage>
      )}
    </ol>
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
