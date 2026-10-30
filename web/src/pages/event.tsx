import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BellRing, Cctv, Clock, ScanSearch, Target } from 'lucide-react';
import { ClipPlayer } from '@/components/clip-player';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { dateAndTime, sentence } from '@/lib/time';

export function EventPage({ id }: { id: number }) {
  const event = useQuery({ queryKey: ['event', id], queryFn: () => api.event(id), retry: false });
  const frames = useQuery({ queryKey: ['frames', id], queryFn: () => api.frames(id) });

  if (event.isPending) return <Skeleton className='h-[32rem] rounded-xl' />;
  if (event.isError) return <Notice tone='error'>{event.error.message}</Notice>;
  const e = event.data;

  return (
    <>
      <PageHeader
        trail={[{ href: '/events', label: 'Events' }]}
        icon={<BellRing />}
        title={`${sentence(e.zone)} · ${dateAndTime(e.at)}`}
        description={e.rule}
      />
      <div className='grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]'>
        <Card className='min-w-0'>
          <CardContent>{frames.isPending ? <Skeleton className='aspect-video rounded-lg' /> : <ClipPlayer event={e} frames={frames.data ?? []} />}</CardContent>
        </Card>

        <aside className='min-w-0 space-y-6'>
          <Card>
            <CardHeader>
              <CardTitle>Alert</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className='space-y-3 text-sm'>
                <Fact icon={<Target />} term='Rule' value={e.rule} />
                <Fact icon={<ScanSearch />} term='Zone' value={e.zone} />
                <Fact icon={<Cctv />} term='Camera' value={e.camera} />
                <Fact icon={<Clock />} term='Time' value={dateAndTime(e.at)} />
              </dl>
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}

function Fact({ icon, term, value }: { icon: ReactNode; term: string; value: string }) {
  return (
    <div className='flex gap-3'>
      <span className='text-muted-foreground mt-0.5 [&_svg]:size-4'>{icon}</span>
      <div className='min-w-0'>
        <dt className='text-muted-foreground text-xs'>{term}</dt>
        <dd className='mt-0.5'>{value}</dd>
      </div>
    </div>
  );
}
