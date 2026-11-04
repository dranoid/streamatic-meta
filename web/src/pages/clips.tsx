import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, Compass, ImageUp, LoaderCircle, Search, Wand2 } from 'lucide-react';
import { OfferCard } from '@/components/demo-guide';
import { RECORDED_CLIPS_NOTE } from '@/components/layout/app-shell';
import { PageHeader } from '@/components/layout/page-header';
import { PictureFrame } from '@/components/picture-frame';
import { VoiceNote } from '@/components/voice-note';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { Link } from '@/components/ui/link';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { useAbilities } from '@/lib/abilities';
import { api, clipPictureUrl, type AppInfo, type Clip, type DemoClipSummary } from '@/lib/api';
import { navigate } from '@/lib/router';

const length = (seconds: number) => (seconds < 90 ? `${Math.round(seconds)} seconds` : `${Math.round(seconds / 60)} minutes`);

const WHAT_TO_TRY = [
  { icon: Wand2, title: 'Set up a camera', text: 'Add zones and rules.', href: '/setup' },
  { icon: Search, title: 'Search past words', text: 'Find and track an item.', href: null },
  { icon: ImageUp, title: 'Your own picture', text: 'Upload and set it up.', href: '/try' },
];

// One sentence with no camera chosen. Code finds the camera that outlined what was asked about, and the guide carries on there by itself.
function AskAnyCamera({ clips }: { clips: Array<Clip & Partial<DemoClipSummary>> }) {
  const { models, rules } = useAbilities();
  const [text, setText] = useState('');
  const tested = models && rules ? clips.flatMap((clip) => (clip.suggestions ?? []).slice(0, 2).map((sentence) => ({ clip, sentence }))) : [];
  const choosing = useMutation({
    mutationFn: (sentence: string) => api.routeSentence(sentence),
    onSuccess: ({ cameras }, sentence) => {
      const best = cameras[0];
      const same = cameras.filter((c) => c.matched === best?.matched);
      if (best?.hasClip && same.length === 1) navigate(`/clips/${encodeURIComponent(best.camera)}?ask=${encodeURIComponent(sentence)}`);
    },
  });
  const asked = choosing.variables ?? '';
  const found = choosing.data?.cameras ?? null;
  const best = found?.filter((c) => c.matched === found[0]?.matched) ?? [];

  return (
    <Card className='mb-6'>
      <CardContent className='space-y-3'>
        <form
          className='space-y-2'
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) choosing.mutate(text.trim());
          }}
        >
          <Label htmlFor='ask-any-camera'>What should your cameras watch?</Label>
          <div className='flex flex-wrap items-center gap-2'>
            <Input id='ask-any-camera' className='min-w-48 flex-1' maxLength={300} disabled={!models} value={text} onChange={(e) => setText(e.target.value)} placeholder='Tell me when someone opens the door of the building.' />
            <Button type='submit' disabled={!models || !rules || text.trim().length < 3 || choosing.isPending}>
              {choosing.isPending ? <LoaderCircle className='animate-spin' /> : <Compass />}
              Start
            </Button>
          </div>
        </form>
        {tested.length > 0 && !found && (
          <div className='space-y-1.5'>
            <p className='text-muted-foreground text-xs'>Or select one of these. Each was tested on its clip, and runs there live.</p>
            <div className='flex flex-wrap items-center gap-1.5'>
              {tested.map(({ clip, sentence }) => (
                <Link
                  key={`${clip.id}-${sentence}`}
                  href={`/clips/${encodeURIComponent(clip.id)}?ask=${encodeURIComponent(sentence)}`}
                  className='hover:bg-accent inline-flex max-w-full items-center rounded-md border px-2.5 py-1 text-left text-xs'
                >
                  {sentence} ({clip.name})
                </Link>
              ))}
            </div>
          </div>
        )}
        <VoiceNote disabled={!models} read={api.voiceNoteOnPage} onText={setText} />
        {choosing.isError && <Notice tone='error'>{choosing.error.message}</Notice>}
        {found && found.length === 0 && (
          <div className='space-y-2'>
            <Notice>No camera outlined what you asked about by name. Select the camera to use.</Notice>
            <div className='flex flex-wrap gap-2'>
              {clips.map((clip) => (
                <Link key={clip.id} href={`/clips/${encodeURIComponent(clip.id)}?ask=${encodeURIComponent(asked)}`} className='hover:bg-accent inline-flex h-8 items-center rounded-md border px-2.5 text-sm font-medium'>
                  {clip.name}
                </Link>
              ))}
            </div>
          </div>
        )}
        {best.length > 0 && !(best.length === 1 && best[0]!.hasClip) && (
          <div className='space-y-2'>
            <p className='text-sm'>{best.length === 1 ? 'This camera outlined what you asked about.' : 'These cameras all outlined what you asked about. Select one.'}</p>
            <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
              {best.map((offer) => (
                <OfferCard key={offer.camera} offer={offer} sentence={asked} />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

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
      {app?.credit === 'meva' && <Notice className='mb-6'>{RECORDED_CLIPS_NOTE}</Notice>}
      {isPublic && (
        <AskAnyCamera clips={clips.data ?? []} />
      )}
      {isPublic && (
        <nav aria-label='What to try' className='mb-8 grid gap-2 sm:grid-cols-3'>
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
