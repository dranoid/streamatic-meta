import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Compass, ImageUp, Search, Wand2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { PictureFrame } from '@/components/picture-frame';
import { Badge } from '@/components/ui/badge';
import { Link } from '@/components/ui/link';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { api, clipPictureUrl, type AppInfo, type Clip, type DemoClipSummary } from '@/lib/api';

const length = (seconds: number) => (seconds < 90 ? `${Math.round(seconds)} seconds` : `${Math.round(seconds / 60)} minutes`);

const WHAT_TO_TRY = [
  { icon: Wand2, title: 'Set up a camera', text: 'Add zones and rules.', href: '/setup' },
  { icon: Compass, title: 'Describe a rule', text: 'Write it in a sentence.', href: null },
  { icon: Search, title: 'Search past words', text: 'Find and track an item.', href: null },
  { icon: ImageUp, title: 'Your own picture', text: 'Upload and set it up.', href: '/try' },
];

export function ClipsPage({ isPublic = false, app }: { isPublic?: boolean; app?: AppInfo }) {
  const clips = useQuery<Array<Clip & Partial<DemoClipSummary>>>({ queryKey: ['clips-list', isPublic], queryFn: isPublic ? api.demoClips : api.clips });

  return (
    <>
      <PageHeader
        icon={<Search />}
        title={isPublic ? 'Streamatic' : 'Search'}
        description={
          isPublic
            ? 'Rules and alerts in plain English, on the cameras a business already has. Every alert on these recorded clips is one that Streamatic’s rules really raised.'
            : 'Pause a clip and search for any item: enter its name, or draw a box around it. Streamatic outlines its exact shape, tracks it through the clip and shows when it was in view.'
        }
      />
      {app?.models === false && (
        <Notice className='mb-6'>Provide your keys for the full experience. The README says which to add. The clips, rules, alerts and kept searches work without them.</Notice>
      )}
      {isPublic && (
        <nav aria-label='What to try' className='mb-8 grid gap-2 sm:grid-cols-2 xl:grid-cols-4'>
          {WHAT_TO_TRY.map(({ icon: Icon, title, text, href }) => (
            <Link
              key={title}
              href={href ?? (clips.data?.[0] ? `/clips/${encodeURIComponent(clips.data[0].id)}` : '/clips')}
              className='bg-card hover:border-primary/50 focus-visible:ring-ring/50 flex min-w-0 items-center gap-3 rounded-lg border p-3 transition-colors outline-none focus-visible:ring-[3px]'
            >
              <span className='bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4'>
                <Icon />
              </span>
              <span className='min-w-0 flex-1'>
                <span className='block truncate text-sm font-medium'>{title}</span>
                <span className='text-muted-foreground block truncate text-xs'>{text}</span>
              </span>
            </Link>
          ))}
        </nav>
      )}
      {clips.isError && <Notice tone='error'>The clips could not be loaded. Please reload the page.</Notice>}
      {isPublic && <h2 className='mb-3 text-sm font-semibold'>Recorded clips</h2>}
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
                {clip.description && <p className='text-muted-foreground mt-1 text-sm'>{clip.description}</p>}
                <div className='mt-2 flex flex-wrap gap-1.5'>
                  <Badge variant='outline'>{length(clip.frames / clip.fps)}</Badge>
                  {clip.rules !== undefined && <Badge variant='outline'>{clip.rules} {clip.rules === 1 ? 'rule' : 'rules'}</Badge>}
                </div>
              </div>
              <ArrowRight className='text-muted-foreground group-hover:text-foreground mt-0.5 size-4 shrink-0 transition-colors' />
            </div>
          </Link>
        ))}
      </div>
      {clips.data?.length === 0 && <Notice>No clips are available yet.</Notice>}
    </>
  );
}
