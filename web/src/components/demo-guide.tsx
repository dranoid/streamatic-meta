import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Compass, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label, Textarea } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { NeedsKeys } from '@/components/needs-keys';
import { VoiceNote } from '@/components/voice-note';
import { useAbilities } from '@/lib/abilities';
import { api, type DemoClip, type DemoRule, type DemoZone, type GuidePlan, type PlanAttempt } from '@/lib/api';
import { cn } from '@/lib/cn';
import { clockTime } from '@/lib/time';

const POLL_MS = 1_500;
const GUIDE_PAUSE_MS = 700;
const FINISHED = new Set(['ready', 'refused', 'failed']);

function statusLine(rule: DemoRule | undefined): string {
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

interface Step {
  key: string;
  title: string;
  detail: React.ReactNode;
  // The page shows what the step did, so the person can confirm it.
  ready: boolean;
  waiting?: string;
  confirm: string;
  onConfirm: () => void;
  done: boolean;
}

// The guide on a clip: the plan is drafted and checked, the zones it uses are shown on the player, Streamatic reads the
// rule over the clip, and the rule joins the clip. A step is ticked only once the page shows it and the person confirms it.
export function DemoGuide({
  clip,
  added,
  onShowZones,
  onAdd,
  onTyped,
}: {
  clip: DemoClip;
  added: (rule: string) => boolean;
  onShowZones: (zones: DemoZone[] | null) => void;
  onAdd: (rule: string) => void;
  onTyped: () => void;
}) {
  const { models } = useAbilities();
  const [text, setText] = useState('');
  const [plan, setPlan] = useState<{ plan: GuidePlan; attempts: PlanAttempt[] } | null>(null);
  const [planChecked, setPlanChecked] = useState(false);
  const [zonesShown, setZonesShown] = useState(false);
  const [zonesChecked, setZonesChecked] = useState(false);
  const [readingChecked, setReadingChecked] = useState(false);
  const [ruleId, setRuleId] = useState<string | null>(null);

  const reset = () => {
    setPlan(null);
    setPlanChecked(false);
    setZonesShown(false);
    setZonesChecked(false);
    setReadingChecked(false);
    setRuleId(null);
    onShowZones(null);
  };

  const planning = useMutation({
    mutationFn: (sentence: string) => api.planOnClip(clip.id, sentence),
    onSuccess: (result) => {
      reset();
      if (result.status === 'ready') setPlan({ plan: result.plan, attempts: result.attempts });
    },
  });
  const refused = planning.data?.status === 'needs-person' ? planning.data : null;
  const adding = useMutation({
    mutationFn: (rule: { text: string } | { plan: GuidePlan }) => api.addToClip(clip.id, rule),
    onSuccess: ({ id }) => setRuleId(id),
  });
  const rule = useQuery({
    queryKey: ['clip-rule', clip.id, ruleId],
    queryFn: () => api.clipRule(clip.id, ruleId!),
    enabled: ruleId !== null,
    refetchInterval: (query) => (query.state.data && FINISHED.has(query.state.data.status) ? false : POLL_MS),
  });
  const reading = rule.data;
  useEffect(() => {
    if (reading?.status === 'ready') onTyped();
  }, [reading?.status, onTyped]);

  // The zones are drawn on the player for as long as the person is looking at them.
  const zones = plan ? zonesOf(clip, plan.plan) : [];
  useEffect(() => {
    if (!plan || !planChecked || zonesChecked) return;
    onShowZones(zones);
    const shown = setTimeout(() => setZonesShown(true), GUIDE_PAUSE_MS);
    return () => clearTimeout(shown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, planChecked, zonesChecked]);

  const clockNote = plan?.plan.hours ? `This clip’s clock runs from ${clockTime(clip.startsAt)} to ${clockTime(clip.startsAt + clip.lengthMs)}, so a rule limited to other hours will not alert on it.` : null;
  const steps: Step[] = [];
  if (plan) {
    const rejected = plan.attempts.filter((a) => a.problems.length > 0);
    steps.push({
      key: 'plan',
      title: 'Review the plan',
      detail: (
        <div className='space-y-1'>
          <p>Watches for: {plan.plan.about}</p>
          <p>Zones: {plan.plan.zones.length ? plan.plan.zones.join(', ') : 'none'}</p>
          {plan.plan.box && <p>A box{plan.plan.box.over ? ` over the ${plan.plan.box.over}` : ''}: {plan.plan.box.question}</p>}
          <p>{rejected.length === 0 ? 'Checked against the zones on this clip: passed.' : `Checked against the zones on this clip: refused ${rejected.length === 1 ? 'once' : `${rejected.length} times`}, corrected, then passed.`}</p>
          {rejected.map((a, i) => (
            <p key={i}>Refused: {a.problems.join(' ')}</p>
          ))}
          {clockNote && <p>{clockNote}</p>}
        </div>
      ),
      ready: true,
      confirm: 'Confirm the plan',
      onConfirm: () => setPlanChecked(true),
      done: planChecked,
    });
    steps.push({
      key: 'zones',
      title: 'Review the zones',
      detail: zones.length ? `Outlined on the player: ${zones.map((z) => z.name).join(', ')}. The sentence sent to Streamatic says where each one is in the picture.` : 'This rule watches the whole picture, so nothing is outlined.',
      ready: zonesShown,
      confirm: 'Run the rule on this clip',
      onConfirm: () => {
        setZonesChecked(true);
        onShowZones(null);
        adding.mutate({ plan: plan.plan });
      },
      done: zonesChecked,
    });
  }
  if ((plan && zonesChecked) || ruleId || adding.isPending) {
    steps.push({
      key: 'read',
      title: 'Review how Streamatic reads the rule',
      detail: !reading || !FINISHED.has(reading.status) ? `${statusLine(reading)}. This usually takes under a minute.` : reading.status === 'ready' ? (
        <div className='space-y-1'>
          <p>Reads as: {reading.readsAs ?? reading.name}</p>
          {!reading.canAnswer && <p>Streamatic may not be able to see this on this clip. The rule will still run.</p>}
        </div>
      ) : reading.status === 'refused' ? (
        <div className='space-y-2'>
          <p>{reading.reason ?? 'Streamatic cannot watch for this as written.'}</p>
          {reading.rewrites.map((r) => (
            <Button key={r} type='button' size='sm' variant='outline' className='h-auto max-w-full shrink whitespace-normal text-left' onClick={() => { setText(r); planning.mutate(r); }}>
              {r}
            </Button>
          ))}
        </div>
      ) : (
        'This rule could not be finished. Please try again.'
      ),
      ready: reading?.status === 'ready',
      waiting: reading && FINISHED.has(reading.status) ? 'This step cannot go further' : 'Streamatic is working on this step',
      confirm: 'Confirm the reading',
      onConfirm: () => setReadingChecked(true),
      done: readingChecked,
    });
  }
  if (readingChecked && ruleId) {
    steps.push({
      key: 'add',
      title: 'Add the rule to the clip',
      detail: added(ruleId) ? 'Added. The rule runs from the start of the clip. A new rule waits 5 minutes after an alert before it can alert again, as it would on a live camera, so on this clip it alerts about once.' : 'The rule will be ticked and the clip will play from the start.',
      ready: true,
      confirm: 'Add the rule and play from the start',
      onConfirm: () => onAdd(ruleId),
      done: added(ruleId),
    });
  }
  const current = steps.findIndex((s) => !s.done);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className='flex items-center gap-2'>
            <Compass className='text-primary size-4' />
            Guide
          </CardTitle>
          <CardDescription>Describe what to monitor on this clip. The guide plans the rule, completes each step on this page, and asks you to confirm it.</CardDescription>
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
          <Label htmlFor='clip-guide'>What should this camera monitor?</Label>
          <Textarea id='clip-guide' rows={2} maxLength={300} disabled={!models} value={text} onChange={(e) => setText(e.target.value)} placeholder='Tell me when someone stops by the entrance.' />
          <VoiceNote disabled={!models} read={(audio) => api.voiceNoteOnClip(clip.id, audio)} onText={setText} />
          <Button type='submit' disabled={!models || planning.isPending || text.trim().length < 3}>
            {planning.isPending ? <Loader2 className='animate-spin' /> : <Compass />}
            {planning.isPending ? 'Planning the rule' : 'Add rule'}
          </Button>
        </form>
        {!models && <NeedsKeys />}
        {models && clip.suggestions.length > 0 && !plan && (
          <div className='space-y-1.5'>
            <p className='text-muted-foreground text-xs'>Suggested when this clip was set up:</p>
            <div className='flex flex-wrap gap-1.5'>
              {clip.suggestions.slice(0, 4).map((s) => (
                <Button key={s} type='button' size='sm' variant='outline' className='h-auto max-w-full shrink whitespace-normal py-1 text-left text-xs' onClick={() => setText(s)}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        )}
        {planning.isError && <Notice tone='error'>{planning.error.message}</Notice>}
        {adding.isError && <Notice tone='error'>{adding.error.message}</Notice>}
        {refused && !ruleId && (
          <div className='space-y-2'>
            <Notice>The guide could not plan this rule on this clip’s zones after {refused.attempts.length} attempts. {refused.problems.join(' ')}</Notice>
            <Button variant='outline' size='sm' disabled={adding.isPending} onClick={() => adding.mutate({ text: text.trim() })}>
              Run the rule as written
            </Button>
          </div>
        )}
        {steps.length > 0 && (
          <ol className='space-y-2' aria-label='Guide steps'>
            {steps.map((s, i) => {
              const now = i === current;
              return (
                <li key={s.key} className={cn('rounded-lg border p-3', now && 'border-primary/50 bg-primary/5')}>
                  <div className='flex items-center gap-2'>
                    {s.done ? (
                      <span className='bg-primary text-primary-foreground flex size-5 items-center justify-center rounded-full'>
                        <Check className='size-3.5' />
                      </span>
                    ) : (
                      <span className='flex size-5 items-center justify-center rounded-full border text-xs tabular-nums'>{i + 1}</span>
                    )}
                    <span className='text-sm font-medium'>{s.title}</span>
                  </div>
                  <div className='text-muted-foreground mt-1.5 pl-7 text-xs leading-relaxed'>{s.detail}</div>
                  {now && (
                    <div className='mt-2 flex flex-wrap items-center gap-2 pl-7'>
                      <Button type='button' size='sm' disabled={!s.ready} onClick={s.onConfirm}>
                        {s.confirm}
                      </Button>
                      {!s.ready && <span className='text-muted-foreground text-xs'>{s.waiting ?? 'The guide is doing this step'}</span>}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
