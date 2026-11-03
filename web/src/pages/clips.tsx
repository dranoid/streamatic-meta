import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Crosshair } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { PictureFrame } from '@/components/picture-frame';
import { Badge } from '@/components/ui/badge';
import { Link } from '@/components/ui/link';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { api, clipPictureUrl } from '@/lib/api';

export function ClipsPage() {
  const clips = useQuery({ queryKey: ['clips'], queryFn: api.clips });

  return (
    <>
      <PageHeader
        icon={<Crosshair />}
        title='Track'
        description='Pause a clip, select any person, vehicle or object, and Streamatic tracks it through the clip and shows when it was in view.'
      />
      {clips.isError && <Notice tone='error'>The clips could not be loaded. Please reload the page.</Notice>}
      <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-3'>
        {clips.isPending && [0, 1].map((i) => <Skeleton key={i} className='aspect-[4/3] rounded-xl' />)}
        {clips.data?.map((clip) => (
          <Link
            key={clip.id}
            href={`/clips/${encodeURIComponent(clip.id)}`}
            className='group bg-card hover:border-primary/50 focus-visible:ring-ring/50 flex flex-col overflow-hidden rounded-xl border shadow-sm transition-colors outline-none focus-visible:ring-[3px]'
          >
            <PictureFrame src={clipPictureUrl(clip.id, 0)} alt={clip.name} className='rounded-none' />
            <div className='flex flex-1 items-start justify-between gap-2 p-4'>
              <div className='min-w-0'>
                <p className='truncate font-semibold'>{clip.name}</p>
                <div className='mt-2 flex flex-wrap gap-1.5'>
                  <Badge variant='outline'>{Math.round(clip.frames / clip.fps)} seconds</Badge>
                </div>
              </div>
              <ArrowRight className='text-muted-foreground group-hover:text-foreground mt-0.5 size-4 shrink-0 transition-colors' />
            </div>
          </Link>
        ))}
      </div>
      {clips.data?.length === 0 && <Notice>No clips are in this app folder yet.</Notice>}
    </>
  );
}
