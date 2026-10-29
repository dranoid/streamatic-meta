import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, BellRing, Loader2, MessageSquareText, Sparkles } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { PictureFrame } from '@/components/picture-frame';
import { SecondOpinionBadge } from '@/components/second-opinion';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Link } from '@/components/ui/link';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { api, mediaUrl, type StoredEvent } from '@/lib/api';
import { clockTime, dateAndTime, sentence, shortDate } from '@/lib/time';

const EXAMPLES = ['How many times was the front door opened after 9 pm yesterday?', 'List the events in the last 7 days.'];

export function EventsPage() {
  const events = useQuery({ queryKey: ['events'], queryFn: api.events });

  return (
    <>
      <PageHeader icon={<BellRing />} title='Events' description='Every alert a rule raised, with the picture that shows it and a second opinion from Muse Spark Open.' />
      <div className='space-y-6'>
        <AskCard events={events.data ?? []} />
        {events.isError && <Notice tone='error'>The events could not be loaded. Please reload the page.</Notice>}
        <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-3'>
          {events.isPending && [0, 1, 2].map((i) => <Skeleton key={i} className='aspect-[4/3] rounded-xl' />)}
          {events.data?.map((e) => <EventCard key={e.id} event={e} />)}
        </div>
        {events.data?.length === 0 && <Notice>No events yet. A rule’s alerts appear here.</Notice>}
      </div>
    </>
  );
}

function AskCard({ events }: { events: StoredEvent[] }) {
  const [question, setQuestion] = useState('');
  const ask = useMutation({ mutationFn: api.ask });
  const linked = ask.data ? ask.data.eventIds.map((id) => events.find((e) => e.id === id)).filter((e): e is StoredEvent => !!e) : [];
  const send = (q: string) => {
    const trimmed = q.trim();
    if (trimmed) ask.mutate(trimmed);
  };

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className='flex items-center gap-2'>
            <MessageSquareText className='text-primary size-4' />
            Ask about the events
          </CardTitle>
          <CardDescription>Muse Spark Open chooses what to look up; the events database does the counting, so every number links to its events.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className='space-y-4'>
        <form
          className='flex flex-col gap-2 sm:flex-row'
          onSubmit={(e) => {
            e.preventDefault();
            send(question);
          }}
        >
          <Input value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={300} placeholder={EXAMPLES[0]} aria-label='Question' />
          <Button type='submit' disabled={ask.isPending || !question.trim()}>
            {ask.isPending ? <Loader2 className='animate-spin' /> : <Sparkles />}
            Ask
          </Button>
        </form>
        {!ask.data && !ask.isPending && (
          <div className='flex flex-wrap gap-1.5'>
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type='button'
                className='bg-muted/60 text-muted-foreground hover:text-foreground hover:bg-accent rounded-md border px-2 py-1 text-left text-xs transition-colors'
                onClick={() => {
                  setQuestion(example);
                  send(example);
                }}
              >
                {example}
              </button>
            ))}
          </div>
        )}
        {ask.isPending && <p className='text-muted-foreground text-sm'>Muse Spark Open is choosing what to look up.</p>}
        {ask.isError && <Notice tone='error'>{ask.error.message}</Notice>}
        {ask.data && (
          <div className='bg-muted/40 space-y-3 rounded-lg border p-4' aria-live='polite'>
            <p className='flex items-baseline gap-3'>
              {ask.data.count !== null && <span className='text-primary text-3xl font-semibold tabular-nums'>{ask.data.count}</span>}
              <span className='text-sm'>{ask.data.text}</span>
            </p>
            {linked.length > 0 && (
              <ul className='flex flex-wrap gap-2'>
                {linked.map((e) => (
                  <li key={e.id}>
                    <Link
                      href={`/events/${e.id}`}
                      className='bg-background hover:border-primary/50 inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors dark:bg-input/30'
                    >
                      <BellRing className='text-alert size-3.5' />
                      {e.zone} · {dateAndTime(e.at)}
                      <ArrowRight className='text-muted-foreground size-3.5' />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EventCard({ event }: { event: StoredEvent }) {
  const paths = [
    ...(event.reference ? [{ key: 'reference', d: event.reference, colour: '#ffffff', style: 'dashed' as const }] : []),
    ...(event.outline ? [{ key: 'outline', d: event.outline, colour: '#ef4444', style: 'fill' as const }] : []),
  ];
  return (
    <Link
      href={`/events/${event.id}`}
      className='group bg-card hover:border-primary/50 focus-visible:ring-ring/50 flex flex-col overflow-hidden rounded-xl border shadow-sm transition-colors outline-none focus-visible:ring-[3px]'
    >
      <PictureFrame src={event.picture ? mediaUrl(event.picture) : null} alt={`${event.zone} on ${event.camera} at ${clockTime(event.at)}`} paths={paths} className='rounded-none' />
      <div className='flex flex-1 flex-col gap-2.5 p-4'>
        <div className='flex items-start justify-between gap-2'>
          <div className='min-w-0'>
            <p className='truncate font-semibold'>{sentence(event.zone)}</p>
            <p className='text-muted-foreground mt-0.5 text-xs'>
              {event.camera} · {shortDate(event.at)}, {clockTime(event.at)}
            </p>
          </div>
          <ArrowRight className='text-muted-foreground group-hover:text-foreground mt-0.5 size-4 shrink-0 transition-colors' />
        </div>
        <p className='text-muted-foreground line-clamp-2 text-sm'>{event.rule}</p>
        <div className='mt-auto'>
          <SecondOpinionBadge opinion={event.secondOpinion} />
        </div>
      </div>
    </Link>
  );
}
