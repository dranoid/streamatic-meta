import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Compass, Crosshair, ImageUp, Search } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { PictureFrame } from '@/components/picture-frame';
import { Badge } from '@/components/ui/badge';
import { Link } from '@/components/ui/link';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import { api, clipPictureUrl, type AppInfo, type Clip, type DemoClipSummary } from '@/lib/api';

const length = (seconds: number) => (seconds < 90 ? `${Math.round(seconds)} seconds` : `${Math.round(seconds / 60)} minutes`);

const WHAT_TO_TRY = [
  { icon: Compass, title: 'Say what to watch', text: 'Open a clip and write a rule in a sentence. The guide plans it on the zones found in the picture, and you confirm each step.' },
  { icon: Search, title: 'Search past words', text: 'Pause a clip and search for anything: type it, or select it on the picture. Streamatic outlines its exact shape, tracks it through the clip and shows when it was in view.' },
  { icon: ImageUp, title: 'Try your own picture', text: 'Upload a picture from a camera. Streamatic lists what matters in it, outlines each thing and suggests rules.', href: '/try' },
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
            ? 'Rules and alerts in plain English, on the cameras a business already has. These recorded clips have been through Streamatic’s rules, and every alert shown is the one those rules really raised.'
            : 'Pause a clip and search for anything: type it, or select it on the picture. Streamatic outlines its exact shape, tracks it through the clip and shows when it was in view.'
        }
      />
      {app?.models === false && (
        <Notice className='mb-6'>This copy runs without model keys. The clips, rules, alerts and kept searches all work. To search for something new or use the guide, add the keys described in the README.</Notice>
      )}
      {isPublic && (
        <div className='mb-6 grid gap-4 md:grid-cols-3'>
          {WHAT_TO_TRY.map(({ icon: Icon, title, text, href }) => {
            const body = (
              <Card className='h-full'>
                <CardContent className='flex gap-3'>
                  <Icon className='text-primary mt-0.5 size-5 shrink-0' />
                  <div>
                    <p className='font-semibold'>{title}</p>
                    <p className='text-muted-foreground mt-1 text-sm'>{text}</p>
                  </div>
                </CardContent>
              </Card>
            );
            return href ? (
              <Link key={title} href={href} className='focus-visible:ring-ring/50 rounded-xl outline-none focus-visible:ring-[3px]'>
                {body}
              </Link>
            ) : (
              <div key={title}>{body}</div>
            );
          })}
        </div>
      )}
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
