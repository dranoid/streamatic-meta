import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BellRing } from 'lucide-react';
import { LanguageChoice, type AlertLanguage } from '@/components/language-choice';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Link } from '@/components/ui/link';
import { Notice } from '@/components/ui/notice';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { api, type DemoEvent } from '@/lib/api';
import { cn } from '@/lib/cn';

type Layout = 'large' | 'small' | 'list';
type Grouping = 'all' | 'camera';
type Order = 'earliest' | 'latest';
interface View {
  layout: Layout;
  grouping: Grouping;
  order: Order;
}

const VIEW_KEY = 'events-view';
const DEFAULT_VIEW: View = { layout: 'large', grouping: 'all', order: 'earliest' };
const GRID: Record<Exclude<Layout, 'list'>, string> = {
  large: 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3',
  small: 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6',
};

const moment = (ms: number) => `${Math.floor(Math.round(ms / 1000) / 60)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`;

function savedView(): View {
  try {
    return { ...DEFAULT_VIEW, ...(JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Partial<View>) };
  } catch {
    return DEFAULT_VIEW;
  }
}

function EventItem({ event, language, layout }: { event: DemoEvent; language: AlertLanguage; layout: Layout }) {
  const translated = language !== 'english' ? event.captions[language] : undefined;
  const words = (
    <>
      <p className={cn('font-medium', layout === 'large' ? 'text-sm' : 'text-xs')}>{event.ruleName}</p>
      {translated && (
        <p lang={language === 'yoruba' ? 'yo' : 'pcm'} className={layout === 'large' ? 'text-sm' : 'text-xs'}>
          {translated}
        </p>
      )}
      <p className='text-muted-foreground text-xs'>
        {event.camera}, at {moment(event.atMs)}
      </p>
      {event.yours && <Badge variant='outline'>Your rule</Badge>}
    </>
  );
  const picture = event.picture ? (
    <img src={event.picture} alt={event.caption ?? `The picture this alert carries, from ${event.camera}`} className={cn('object-cover', layout === 'list' ? 'aspect-video w-24 shrink-0 rounded-md sm:w-32' : 'aspect-video w-full')} loading='lazy' />
  ) : (
    <div className={cn('bg-muted aspect-video', layout === 'list' ? 'w-24 shrink-0 rounded-md sm:w-32' : 'w-full')} />
  );
  return (
    <Link
      href={`/clips/${encodeURIComponent(event.clip)}?rule=${encodeURIComponent(event.rule)}&at=${event.atMs}`}
      className={cn(
        'bg-card hover:border-primary/50 focus-visible:ring-ring/50 min-w-0 rounded-xl border shadow-sm transition-colors outline-none focus-visible:ring-[3px]',
        layout === 'list' ? 'flex items-center gap-3 p-2' : 'flex flex-col overflow-hidden',
      )}
    >
      {picture}
      <div className={cn('min-w-0 space-y-1', layout === 'large' && 'p-4', layout === 'small' && 'p-2.5')}>{words}</div>
    </Link>
  );
}

// Every alert on the page's clips, and those of the rules this visitor added. Each opens its clip at that moment with its rule selected.
export function DemoEventsPage() {
  const events = useQuery({ queryKey: ['demo-events'], queryFn: api.demoEvents });
  const [language, setLanguage] = useState<AlertLanguage>('english');
  const [view, setView] = useState<View>(savedView);
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      // The choice simply isn't remembered.
    }
  }, [view]);
  const { layout, grouping, order } = view;
  const change = (next: Partial<View>) => setView((now) => ({ ...now, ...next }));

  const list = useMemo(() => [...(events.data?.events ?? [])].sort((a, b) => (order === 'earliest' ? a.atMs - b.atMs : b.atMs - a.atMs)), [events.data, order]);
  const cameras = useMemo(() => {
    const byCamera = new Map<string, DemoEvent[]>();
    for (const event of list) byCamera.set(event.camera, [...(byCamera.get(event.camera) ?? []), event]);
    return [...byCamera].sort(([a], [b]) => a.localeCompare(b));
  }, [list]);
  const items = (shown: DemoEvent[]) => shown.map((event) => <EventItem key={`${event.rule}-${event.key}`} event={event} language={language} layout={layout} />);
  const count = (n: number) => `${n} ${n === 1 ? 'alert' : 'alerts'}`;

  return (
    <>
      <PageHeader icon={<BellRing />} title='Events' description='Every alert Streamatic’s rules raised on these clips, and the alerts of the rules you added. Select one to see it on its clip.' />
      {events.isError && <Notice tone='error'>The events could not be loaded. Please reload the page.</Notice>}
      <div className='mb-4 flex flex-wrap items-center gap-x-4 gap-y-2'>
        <LanguageChoice value={language} onChange={setLanguage} />
        <Segmented
          label='Layout'
          value={layout}
          onChange={(next) => change({ layout: next })}
          options={[
            { value: 'large', label: 'Large grid' },
            { value: 'small', label: 'Small grid' },
            { value: 'list', label: 'List' },
          ]}
        />
        <Segmented
          label='Group'
          value={grouping}
          onChange={(next) => change({ grouping: next })}
          options={[
            { value: 'all', label: 'All cameras' },
            { value: 'camera', label: 'By camera' },
          ]}
        />
        <Segmented
          label='Sort by time'
          value={order}
          onChange={(next) => change({ order: next })}
          options={[
            { value: 'earliest', label: 'Earliest first' },
            { value: 'latest', label: 'Latest first' },
          ]}
        />
      </div>
      {events.isPending && (
        <div className={GRID.large}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className='aspect-[4/3] rounded-xl' />
          ))}
        </div>
      )}
      {grouping === 'all' && <div className={layout === 'list' ? 'space-y-2' : GRID[layout]}>{items(list)}</div>}
      {grouping === 'camera' && (
        // Lists by camera sit side by side, so several cameras can be read at once.
        <div className={layout === 'list' ? 'grid items-start gap-4 lg:grid-cols-2 2xl:grid-cols-3' : 'space-y-6'}>
          {cameras.map(([camera, shown]) => (
            <section key={camera} aria-label={camera} className='min-w-0'>
              <h2 className='mb-2 text-sm font-semibold'>
                {camera} <span className='text-muted-foreground font-normal'>{count(shown.length)}</span>
              </h2>
              <div className={layout === 'list' ? 'space-y-2' : GRID[layout]}>{items(shown)}</div>
            </section>
          ))}
        </div>
      )}
      {events.data && list.length === 0 && (
        <Notice>
          Alerts appear here for the cameras you have set up.{' '}
          <Link href='/setup' className='underline underline-offset-2'>
            Go to Setup
          </Link>
        </Notice>
      )}
    </>
  );
}
