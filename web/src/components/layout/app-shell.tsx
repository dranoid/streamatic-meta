import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BellRing, Cctv, Clapperboard, ImageUp, Info, LoaderCircle, Menu, Moon, RotateCcw, Search, Sun, Wand2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from '@/components/ui/link';
import { Notice } from '@/components/ui/notice';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { navigate, type Route } from '@/lib/router';
import { forgetAllProgress } from '@/lib/setup-progress';

// Said only over the public clips: on the footage of a deployed camera it would be untrue.
export const RECORDED_CLIPS_NOTE = 'This page uses recorded clips. The cameras Streamatic has deployed are on private property, so for reasons of permission and privacy they appear only in the submission video.';

const PRIVATE_NAV = [
  { href: '/cameras', label: 'Cameras', icon: Cctv, pages: ['cameras', 'camera'] },
  { href: '/events', label: 'Events', icon: BellRing, pages: ['events', 'event'] },
  { href: '/clips', label: 'Search', icon: Search, pages: ['clips', 'clip'] },
  { href: '/about', label: 'About', icon: Info, pages: ['about'] },
];

const PUBLIC_NAV = [
  { href: '/setup', label: 'Setup', icon: Wand2, pages: ['setup', 'setup-camera'] },
  { href: '/clips', label: 'Clips', icon: Clapperboard, pages: ['clips', 'clip'] },
  { href: '/events', label: 'Events', icon: BellRing, pages: ['events'] },
  { href: '/try', label: 'Your own picture', icon: ImageUp, pages: ['try'] },
  { href: '/about', label: 'About', icon: Info, pages: ['about'] },
];

export function AppShell({ route, isPublic = false, nothingSetUp = false, credit = null, children }: { route: Route; isPublic?: boolean; nothingSetUp?: boolean; credit?: 'meva' | null; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [route]);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const queryClient = useQueryClient();
  const reset = useMutation({
    mutationFn: api.resetDemo,
    onSuccess: async () => {
      forgetAllProgress();
      setConfirmingReset(false);
      await queryClient.invalidateQueries();
      navigate('/setup');
    },
  });

  const sidebar = (
    <div className='flex h-full flex-col gap-2 p-3'>
      <div className='flex items-center gap-2.5 px-2 py-2'>
        <span className='bg-gold text-[#1a1d24] flex size-8 items-center justify-center rounded-lg text-sm font-extrabold'>S</span>
        <span className='grid text-sm leading-tight'>
          <span className='font-bold'>Streamatic</span>
          <span className='text-muted-foreground text-xs'>safety</span>
        </span>
      </div>
      <nav aria-label='Main' className='mt-2'>
        <p className='text-muted-foreground px-2 pb-1.5 text-xs font-medium'>Camera intelligence</p>
        <ul className='space-y-1'>
          {(isPublic ? PUBLIC_NAV.filter(({ href }) => !nothingSetUp || href === '/setup') : PRIVATE_NAV).map(({ href, label, icon: Icon, pages }) => {
            const active = pages.includes(route.page);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex h-9 items-center gap-2.5 rounded-md px-2 text-sm transition-colors',
                    active ? 'bg-sidebar-accent text-foreground font-medium shadow-xs dark:bg-accent' : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground dark:hover:bg-accent/60',
                  )}
                >
                  <Icon className='size-4' />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className='text-muted-foreground mt-auto rounded-lg border bg-background/60 p-3 text-xs leading-relaxed dark:bg-muted/40'>
        <p className='text-foreground font-medium'>Meta hackathon build</p>
        <p className='mt-1'>
          Built on SAM 3.1, Muse Spark Open and Muse Voice Transcribe.{' '}
          <Link href='/about' className='text-foreground underline underline-offset-2'>
            What each one does
          </Link>
        </p>
      </div>
    </div>
  );

  return (
    <div className='flex min-h-svh'>
      <aside className='bg-sidebar sticky top-0 hidden h-svh w-64 shrink-0 border-r md:block'>{sidebar}</aside>
      {open && (
        <div className='fixed inset-0 z-50 md:hidden' role='dialog' aria-modal='true' aria-label='Menu'>
          <button type='button' aria-label='Close the menu' className='absolute inset-0 bg-black/50' onClick={() => setOpen(false)} />
          <div className='bg-sidebar animate-in slide-in-from-left absolute inset-y-0 left-0 w-72 border-r'>
            <Button variant='ghost' size='icon' className='absolute top-3 right-3' aria-label='Close the menu' onClick={() => setOpen(false)}>
              <X />
            </Button>
            {sidebar}
          </div>
        </div>
      )}
      <div className='flex min-w-0 flex-1 flex-col'>
        <header className='bg-background/95 sticky top-0 z-40 flex h-14 items-center gap-2 border-b px-4 backdrop-blur md:px-6'>
          <Button variant='ghost' size='icon' className='md:hidden' aria-label='Open the menu' onClick={() => setOpen(true)}>
            <Menu />
          </Button>
          <span className='text-muted-foreground min-w-0 truncate text-sm'>Camera intelligence</span>
          <div className='ml-auto flex shrink-0 items-center gap-1'>
            {isPublic && !nothingSetUp && (
              <Button variant='ghost' size='sm' onClick={() => setConfirmingReset(true)}>
                <RotateCcw />
                Reset
              </Button>
            )}
            <ThemeSwitch />
          </div>
          {/* Held in the sticky bar, so it opens wherever the page is scrolled to and moves nothing beneath it. */}
          {confirmingReset && (
            <div className='bg-background absolute top-full right-4 left-4 mt-2 rounded-lg shadow-lg md:right-6 md:left-auto md:w-[28rem]'>
              <Notice>
                <p>Reset everything? Every camera returns to not set up, and your zone changes, rules and tracks are removed.</p>
                {reset.isError && <p className='text-destructive mt-1 text-xs'>{reset.error.message}</p>}
                <div className='mt-2 flex flex-wrap gap-2'>
                  <Button size='sm' disabled={reset.isPending} onClick={() => reset.mutate()}>
                    {reset.isPending && <LoaderCircle className='animate-spin' />}
                    Reset
                  </Button>
                  <Button size='sm' variant='outline' onClick={() => setConfirmingReset(false)}>
                    Cancel
                  </Button>
                </div>
              </Notice>
            </div>
          )}
        </header>
        <main className='mx-auto w-full max-w-[90rem] flex-1 px-4 py-6 md:px-6'>{children}</main>
        {isPublic && <SmallPrint credit={credit} />}
      </div>
    </div>
  );
}

function SmallPrint({ credit }: { credit: 'meva' | null }) {
  return (
    <footer className='text-muted-foreground mx-auto w-full max-w-[90rem] space-y-1 border-t px-4 py-4 text-xs leading-relaxed md:px-6'>
      <p>Uploaded pictures go to Meta and Baseten, and voice notes to Meta, which may use them for product improvement under the hackathon’s credit terms. No copy is kept here. Upload only pictures you may share.</p>
      {credit === 'meva' && <p>{RECORDED_CLIPS_NOTE}</p>}
      {credit === 'meva' && (
        <p>
          Clips: MEVA dataset by Kitware Inc. and IARPA,{' '}
          <a className='underline underline-offset-2' href='https://mevadata.org/resources/MEVA-data-license.txt' target='_blank' rel='noreferrer'>
            CC BY 4.0
          </a>
          , resized and re-encoded for this page. This work is not affiliated with Kitware or IARPA.
        </p>
      )}
    </footer>
  );
}

function ThemeSwitch() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {
      // The choice simply isn't remembered.
    }
    setDark(next);
  };
  return (
    <Button variant='ghost' size='icon' aria-label={dark ? 'Use the light theme' : 'Use the dark theme'} onClick={toggle}>
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
