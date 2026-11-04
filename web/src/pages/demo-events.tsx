import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BellRing } from 'lucide-react';
import { LanguageChoice, type AlertLanguage } from '@/components/language-choice';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Link } from '@/components/ui/link';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';

const moment = (ms: number) => `${Math.floor(Math.round(ms / 1000) / 60)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`;

// Every alert on the page's clips, and those of the rules this visitor added. Each opens its clip at that moment with its rule selected.
export function DemoEventsPage() {
  const events = useQuery({ queryKey: ['demo-events'], queryFn: api.demoEvents });
  const list = events.data?.events ?? [];
  const [language, setLanguage] = useState<AlertLanguage>('english');

  return (
    <>
      <PageHeader icon={<BellRing />} title='Events' description='Every alert Streamatic’s rules raised on these clips, and the alerts of the rules you added. Select one to see it on its clip.' />
      {events.isError && <Notice tone='error'>The events could not be loaded. Please reload the page.</Notice>}
      <div className='mb-4'>
        <LanguageChoice value={language} onChange={setLanguage} />
      </div>
      <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-3'>
        {events.isPending && [0, 1, 2].map((i) => <Skeleton key={i} className='aspect-[4/3] rounded-xl' />)}
        {list.map((event) => (
          <Link
            key={`${event.rule}-${event.key}`}
            href={`/clips/${encodeURIComponent(event.clip)}?rule=${encodeURIComponent(event.rule)}&at=${event.atMs}`}
            className='bg-card hover:border-primary/50 focus-visible:ring-ring/50 flex min-w-0 flex-col overflow-hidden rounded-xl border shadow-sm transition-colors outline-none focus-visible:ring-[3px]'
          >
            {event.picture ? (
              <img src={event.picture} alt={event.caption ?? `The picture this alert carries, from ${event.camera}`} className='aspect-video w-full object-cover' loading='lazy' />
            ) : (
              <div className='bg-muted aspect-video w-full' />
            )}
            <div className='space-y-1 p-4'>
              <p className='text-sm font-medium'>{event.ruleName}</p>
              {language !== 'english' && event.captions[language] && (
                <p lang={language === 'yoruba' ? 'yo' : 'pcm'} className='text-sm'>
                  {event.captions[language]}
                </p>
              )}
              <p className='text-muted-foreground text-xs'>
                {event.camera}, at {moment(event.atMs)}
              </p>
              {event.yours && <Badge variant='outline'>Your rule</Badge>}
            </div>
          </Link>
        ))}
      </div>
      {events.data && list.length === 0 && <Notice>No alerts have been raised on these clips yet.</Notice>}
    </>
  );
}
