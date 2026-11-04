import { useEffect, useState } from 'react';

// Eight pages need no router library: the path is the state, and links push to history.
export type Route =
  | { page: 'cameras' }
  | { page: 'camera'; id: string }
  | { page: 'events' }
  | { page: 'event'; id: number }
  | { page: 'clips' }
  | { page: 'clip'; id: string }
  | { page: 'try' }
  | { page: 'setup' }
  | { page: 'setup-camera'; id: string }
  | { page: 'about' };

export function parse(path: string): Route {
  const camera = /^\/cameras\/([^/]+)$/.exec(path);
  if (camera) return { page: 'camera', id: decodeURIComponent(camera[1]!) };
  const event = /^\/events\/(\d+)$/.exec(path);
  if (event) return { page: 'event', id: Number(event[1]) };
  if (path.startsWith('/events')) return { page: 'events' };
  const clip = /^\/clips\/([^/]+)$/.exec(path);
  if (clip) return { page: 'clip', id: decodeURIComponent(clip[1]!) };
  if (path === '/clips') return { page: 'clips' };
  if (path === '/try') return { page: 'try' };
  const setup = /^\/setup\/([^/]+)$/.exec(path);
  if (setup) return { page: 'setup-camera', id: decodeURIComponent(setup[1]!) };
  if (path === '/setup') return { page: 'setup' };
  if (path === '/about') return { page: 'about' };
  return { page: 'cameras' };
}

// `replace` is for a page that sends the person elsewhere, so Back does not return them to it and send them on again.
export function navigate(path: string, { replace = false }: { replace?: boolean } = {}): void {
  if (path === location.pathname) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0 });
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.pathname));
  useEffect(() => {
    const update = () => setRoute(parse(location.pathname));
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return route;
}
