import { useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ImageUp, Loader2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { PictureFrame, ZONE_COLOURS, type DrawnPath } from '@/components/picture-frame';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { NeedsKeys } from '@/components/needs-keys';
import { useAbilities } from '@/lib/abilities';
import { api } from '@/lib/api';
import { sentence } from '@/lib/time';

// A visitor's own picture goes through the same setup as a camera, on this one picture, and nothing is kept.
export function TryPage() {
  const { models } = useAbilities();
  const input = useRef<HTMLInputElement>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const setting = useMutation({ mutationFn: api.setUpOwnPicture, onSuccess: () => setHidden(new Set()) });
  const result = setting.data;
  const zones = result?.setup.zones ?? [];
  const paths = useMemo<DrawnPath[]>(
    () =>
      zones.flatMap((zone, i) =>
        hidden.has(zone.name)
          ? []
          : Object.values(zone.outlines)
              .flat()
              .map((outline, j) => ({ key: `${zone.name}-${j}`, d: outline.path, colour: ZONE_COLOURS[i % ZONE_COLOURS.length]!, style: 'fill' as const, title: sentence(zone.name), group: zone.name })),
      ),
    [zones, hidden],
  );

  return (
    <>
      <PageHeader icon={<ImageUp />} title='Your own picture' description='Upload a picture from a camera. Streamatic lists what matters in it, outlines each item and suggests rules.' />
      <div className='grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]'>
        <Card className='min-w-0'>
          <CardContent className='space-y-4'>
            {result ? (
              <PictureFrame src={result.picture} alt='The picture you uploaded, with what was found outlined' paths={paths} />
            ) : (
              <div className='bg-muted/50 flex aspect-video flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center'>
                {setting.isPending ? <Loader2 className='text-muted-foreground size-6 animate-spin' /> : <ImageUp className='text-muted-foreground size-6' />}
                <p className='text-muted-foreground text-sm'>{setting.isPending ? 'Setting up this picture. This usually takes under a minute.' : 'JPEG, PNG or WebP, up to 8 MB.'}</p>
              </div>
            )}
            <div className='flex flex-wrap items-center gap-2'>
              <Button size='sm' variant={result ? 'outline' : 'default'} disabled={!models || setting.isPending} onClick={() => input.current?.click()}>
                <ImageUp />
                {result ? 'Choose another picture' : 'Choose a picture'}
              </Button>
              <input
                ref={input}
                type='file'
                accept='image/jpeg,image/png,image/webp'
                className='sr-only'
                aria-label='Choose a picture'
                tabIndex={-1}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) setting.mutate(file);
                  e.target.value = '';
                }}
              />
            </div>
            {!models && <NeedsKeys />}
            {setting.isError && <Notice tone='error'>{setting.error.message}</Notice>}
          </CardContent>
        </Card>

        {result && (
          <aside className='min-w-0 space-y-4'>
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Items found</CardTitle>
                  <CardDescription>Select one to show or hide it.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                {zones.length === 0 ? (
                  <p className='text-muted-foreground text-sm'>Nothing could be outlined in this picture.</p>
                ) : (
                  <ul className='flex flex-wrap gap-1.5'>
                    {zones.map((zone, i) => (
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
                )}
              </CardContent>
            </Card>
            {result.setup.rules.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Suggested rules</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className='list-disc space-y-1.5 pl-4 text-sm'>
                    {result.setup.rules.map((r) => (
                      <li key={r.sentence}>{r.sentence}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </aside>
        )}
      </div>
    </>
  );
}
