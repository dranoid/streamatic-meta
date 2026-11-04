import { useEffect, useState, type ReactNode } from 'react';
import { BellRing, Cctv, Clapperboard, ImageUp, Info, Menu, Moon, Search, Sun, Wand2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from '@/components/ui/link';
import { cn } from '@/lib/cn';
import type { Route } from '@/lib/router';

const PRIVATE_NAV = [
  { href: '/cameras', label: 'Cameras', icon: Cctv, pages: ['cameras', 'camera'] },
  { href: '/events', label: 'Events', icon: BellRing, pages: ['events', 'event'] },
  { href: '/clips', label: 'Search', icon: Search, pages: ['clips', 'clip'] },
  { href: '/about', label: 'About', icon: Info, pages: ['about'] },
];

const PUBLIC_NAV = [
  { href: '/setup', label: 'Setup', icon: Wand2, pages: ['setup', 'setup-camera'] },
  { href: '/clips', label: 'Clips', icon: Clapperboard, pages: ['clips', 'clip'] },
  { href: '/try', label: 'Your own picture', icon: ImageUp, pages: ['try'] },
  { href: '/about', label: 'About', icon: Info, pages: ['about'] },
];

export function AppShell({ route, isPublic = false, children }: { route: Route; isPublic?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [route]);

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
          {(isPublic ? PUBLIC_NAV : PRIVATE_NAV).map(({ href, label, icon: Icon, pages }) => {
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
          <span className='text-muted-foreground text-sm'>Camera intelligence</span>
          <ThemeSwitch />
        </header>
        <main className='mx-auto w-full max-w-[90rem] flex-1 px-4 py-6 md:px-6'>{children}</main>
        {isPublic && <SmallPrint />}
      </div>
    </div>
  );
}

function SmallPrint() {
  return (
    <footer className='text-muted-foreground mx-auto w-full max-w-[90rem] space-y-1 border-t px-4 py-4 text-xs leading-relaxed md:px-6'>
      <p>A picture you upload is sent to Meta and to Baseten to be analysed, and a voice note, on this page or in the Telegram chat you link from it, is sent to Meta to be written out, under the hackathon’s credit terms, which allow Meta to use them for product improvement. This page keeps no copy of either. Please upload only a picture you are allowed to share.</p>
      <p>
        Clips: MEVA dataset by Kitware Inc. and IARPA,{' '}
        <a className='underline underline-offset-2' href='https://mevadata.org/resources/MEVA-data-license.txt' target='_blank' rel='noreferrer'>
          CC BY 4.0
        </a>
        , resized and re-encoded for this page. Kitware and IARPA do not endorse this work.
      </p>
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
    <Button variant='ghost' size='icon' className='ml-auto' aria-label={dark ? 'Use the light theme' : 'Use the dark theme'} onClick={toggle}>
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
