import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Cctv } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { PictureFrame, ZONE_COLOURS } from '@/components/picture-frame';
import { Badge } from '@/components/ui/badge';
import { Link } from '@/components/ui/link';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { api, pictureUrl, type Camera } from '@/lib/api';
import { sentence } from '@/lib/time';

export function CamerasPage() {
  const cameras = useQuery({ queryKey: ['cameras'], queryFn: api.cameras });
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api.rules() });

  return (
    <>
      <PageHeader
        icon={<Cctv />}
        title='Cameras'
        description='Each camera sets itself up: Muse Spark Open lists what it sees, and SAM 3.1 outlines each thing as a zone a rule can watch.'
      />
      {cameras.isError && <Notice tone='error'>The cameras could not be loaded. Please reload the page.</Notice>}
      <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-3'>
        {cameras.isPending && [0, 1].map((i) => <Skeleton key={i} className='aspect-[4/3] rounded-xl' />)}
        {cameras.data?.map((camera) => (
          <CameraCard key={camera.id} camera={camera} ruleCount={rules.data?.filter((r) => r.camera === camera.id).length ?? 0} />
        ))}
      </div>
      {cameras.data?.length === 0 && <Notice>No cameras are in this app folder yet.</Notice>}
    </>
  );
}

function CameraCard({ camera, ruleCount }: { camera: Camera; ruleCount: number }) {
  const label = Object.keys(camera.pictures)[0]!;
  const zones = camera.zones;
  const active = zones.filter((z) => z.rules.length > 0);
  // The card shows the zones rules watch; before any rule, everything setup found.
  const shown = active.length > 0 ? active : zones;
  const paths = shown.flatMap((z) =>
    (z.outlines[label] ?? []).map((o) => ({
      key: `${z.word}-${o.objectId}`,
      d: o.path,
      colour: ZONE_COLOURS[zones.indexOf(z) % ZONE_COLOURS.length]!,
      style: 'fill' as const,
    })),
  );

  return (
    <Link
      href={`/cameras/${encodeURIComponent(camera.id)}`}
      className='group bg-card hover:border-primary/50 focus-visible:ring-ring/50 flex flex-col overflow-hidden rounded-xl border shadow-sm transition-colors outline-none focus-visible:ring-[3px]'
    >
      <PictureFrame src={pictureUrl(camera.id, camera.pictures[label]!)} alt={`${camera.name}, ${label} picture`} paths={paths} className='rounded-none' />
      <div className='flex flex-1 flex-col gap-3 p-4'>
        <div className='flex items-start justify-between gap-2'>
          <div className='min-w-0'>
            <p className='truncate font-semibold'>{camera.name}</p>
            <p className='text-muted-foreground mt-0.5 line-clamp-1 text-xs'>{sentence(camera.site)}</p>
          </div>
          <ArrowRight className='text-muted-foreground group-hover:text-foreground mt-0.5 size-4 shrink-0 transition-colors' />
        </div>
        <div className='mt-auto flex flex-wrap gap-1.5'>
          {camera.setup ? <Badge variant='success'>{zones.length} zones found</Badge> : <Badge variant='muted'>Not set up</Badge>}
          {camera.setup && <Badge variant='outline'>{active.length} active</Badge>}
          <Badge variant='outline'>
            {ruleCount} {ruleCount === 1 ? 'rule' : 'rules'}
          </Badge>
          <Badge variant='outline'>{Object.keys(camera.pictures).length} pictures</Badge>
        </div>
      </div>
    </Link>
  );
}
