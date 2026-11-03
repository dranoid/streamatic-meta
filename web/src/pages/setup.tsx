import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, Wand2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { PictureFrame, ZONE_COLOURS, type DrawnPath } from '@/components/picture-frame';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/components/ui/link';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { api, type DemoSetup } from '@/lib/api';
import { cn } from '@/lib/cn';
import { sentence } from '@/lib/time';

const STEPS = [
  { title: 'The picture', note: 'Setup starts from a still picture from the camera. A live camera is given one picture by day, one at dusk and one at night. Each clip here has one.' },
  { title: 'What Streamatic listed', note: 'Streamatic lists what matters on the picture, for this kind of site.' },
  { title: 'What was outlined', note: 'Each item listed is searched for on the picture and outlined. An outline becomes a zone, which a rule can refer to by name. Move the pointer over a zone to see its name.' },
  { title: 'What could not be outlined', note: 'An item that could not be outlined is searched for again under other words. If none finds it, it is reported here and no rule relies on it.' },
  { title: 'Suggested rules', note: 'Streamatic suggests rules for this camera. A suggestion is kept only if every zone it names was outlined.' },
] as const;
const OUTLINES_FROM_STEP = 2;
const LAST_STEP = STEPS.length - 1;

// How a camera is set up, step by step, on the one picture each clip was set up from. Everything shown was saved at the time, so this page calls no model.
export function SetupPage() {
  const clips = useQuery({ queryKey: ['clips-list', true], queryFn: api.demoClips });
  const [chosen, setChosen] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const list = clips.data ?? [];
  const clip = list.find((c) => c.id === chosen) ?? list[0] ?? null;
  const setup = useQuery({ queryKey: ['demo-setup', clip?.id], queryFn: () => api.demoSetup(clip!.id), enabled: clip !== null, staleTime: Infinity });
  const next = clip ? (list[list.findIndex((c) => c.id === clip.id) + 1] ?? null) : null;

  const open = (id: string) => {
    setChosen(id);
    setStep(0);
  };
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [clip?.id]);

  return (
    <>
      <PageHeader icon={<Wand2 />} title='Setup' description='How Streamatic prepares a camera, shown on one picture from each camera. Select a camera and go through each step.' />
      {clips.isError && <Notice tone='error'>The cameras could not be loaded. Please reload the page.</Notice>}
      {clips.isPending && <Skeleton className='h-96 rounded-xl' />}
      {clip && (
        <div className='space-y-4'>
          <div role='group' aria-label='Camera' className='flex flex-wrap gap-2'>
            {list.map((c) => (
              <Button key={c.id} size='sm' variant={c.id === clip.id ? 'default' : 'outline'} aria-pressed={c.id === clip.id} onClick={() => open(c.id)}>
                {c.name}
              </Button>
            ))}
          </div>
          <div className='grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]'>
            <Card className='min-w-0'>
              <CardHeader>
                <div>
                  <CardTitle>
                    Step {step + 1} of {STEPS.length}: {STEPS[step]!.title}
                  </CardTitle>
                  <CardDescription>{STEPS[step]!.note}</CardDescription>
                </div>
              </CardHeader>
              <CardContent className='space-y-4'>
                {setup.isError && <Notice tone='error'>{setup.error.message}</Notice>}
                {setup.isPending && <Skeleton className='aspect-video rounded-lg' />}
                {setup.data && <StepBody key={clip.id} setup={setup.data} step={step} clip={clip.id} />}
                <div className='flex flex-wrap items-center gap-2'>
                  <Button size='sm' variant='outline' disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
                    <ArrowLeft />
                    Back
                  </Button>
                  {step < LAST_STEP ? (
                    <Button size='sm' onClick={() => setStep((s) => s + 1)}>
                      Next
                      <ArrowRight />
                    </Button>
                  ) : next ? (
                    <Button size='sm' onClick={() => open(next.id)}>
                      Next camera: {next.name}
                      <ArrowRight />
                    </Button>
                  ) : (
                    <Link href='/try' className='bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium [&_svg]:size-4'>
                      Set up your own picture
                      <ArrowRight />
                    </Link>
                  )}
                </div>
              </CardContent>
            </Card>
            <aside className='min-w-0'>
              <Card>
                <CardHeader>
                  <CardTitle>Steps</CardTitle>
                </CardHeader>
                <CardContent>
                  <ol className='space-y-1.5'>
                    {STEPS.map((s, i) => (
                      <li key={s.title}>
                        <button
                          type='button'
                          aria-current={i === step ? 'step' : undefined}
                          onClick={() => setStep(i)}
                          className={cn('hover:bg-accent flex w-full items-center gap-2.5 rounded-lg border p-2.5 text-left text-sm transition-colors', i === step && 'border-primary/50 bg-primary/5 font-medium')}
                        >
                          {i < step ? (
                            <span className='bg-primary text-primary-foreground flex size-5 shrink-0 items-center justify-center rounded-full'>
                              <Check className='size-3.5' />
                            </span>
                          ) : (
                            <span className='flex size-5 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums'>{i + 1}</span>
                          )}
                          {s.title}
                        </button>
                      </li>
                    ))}
                  </ol>
                </CardContent>
              </Card>
            </aside>
          </div>
        </div>
      )}
    </>
  );
}

function StepBody({ setup, step, clip }: { setup: DemoSetup; step: number; clip: string }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const paths = useMemo<DrawnPath[]>(
    () =>
      step < OUTLINES_FROM_STEP
        ? []
        : setup.zones.flatMap((zone, i) =>
            hidden.has(zone.name)
              ? []
              : zone.paths.map((d, j) => ({ key: `${zone.name}-${j}`, d, colour: ZONE_COLOURS[i % ZONE_COLOURS.length]!, style: 'fill' as const, title: sentence(zone.name), group: zone.name })),
          ),
    [setup, step, hidden],
  );
  const listed = [...new Set([...setup.zones.map((z) => z.item), ...setup.notOutlined.map((m) => m.item)])];

  return (
    <div className='space-y-4'>
      <PictureFrame src={setup.picture} alt='The still picture this camera was set up from' paths={paths} />
      {step === 1 && (
        <ul aria-label='What Streamatic listed' className='flex flex-wrap gap-1.5'>
          {listed.map((item) => (
            <li key={item} className='rounded-md border px-2 py-1 text-xs'>
              {sentence(item)}
            </li>
          ))}
        </ul>
      )}
      {step === 2 && (
        <div className='space-y-2'>
          <p className='text-muted-foreground text-xs'>Select a zone to show or hide it.</p>
          <ul className='flex flex-wrap gap-1.5'>
            {setup.zones.map((zone, i) => (
              <li key={zone.name}>
                <button
                  type='button'
                  aria-pressed={!hidden.has(zone.name)}
                  onClick={() =>
                    setHidden((all) => {
                      const next = new Set(all);
                      if (!next.delete(zone.name)) next.add(zone.name);
                      return next;
                    })
                  }
                  className='hover:bg-accent flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors aria-[pressed=false]:opacity-50'
                >
                  <span className='size-2.5 rounded-full' style={{ background: ZONE_COLOURS[i % ZONE_COLOURS.length] }} />
                  {sentence(zone.name)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {step === 3 &&
        (setup.notOutlined.length === 0 ? (
          <p className='text-sm'>Everything listed was outlined.</p>
        ) : (
          <ul className='space-y-1.5 text-sm'>
            {setup.notOutlined.map((m) => (
              <li key={m.item}>
                <span className='font-medium'>{sentence(m.item)}.</span> <span className='text-muted-foreground'>Searched for as: {m.triedWords.join(', ')}.</span>
              </li>
            ))}
          </ul>
        ))}
      {step === 4 && (
        <div className='space-y-3'>
          {setup.rules.length === 0 ? (
            <p className='text-sm'>No rule was suggested for this camera.</p>
          ) : (
            <ul className='list-disc space-y-1.5 pl-4 text-sm'>
              {setup.rules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          )}
          <p className='text-sm'>
            <Link href={`/clips/${encodeURIComponent(clip)}`} className='text-primary underline underline-offset-2'>
              Open this camera’s clip
            </Link>{' '}
            to add one of these rules.
          </p>
        </div>
      )}
    </div>
  );
}
