import { useEffect, useState } from 'react';

// Four pages need no router library: the path is the state, and links push to history.
export type Route =
  | { page: 'cameras' }
  | { page: 'camera'; id: string }
  | { page: 'events' }
  | { page: 'event'; id: number };

export function parse(path: string): Route {
  const camera = /^\/cameras\/([^/]+)$/.exec(path);
  if (camera) return { page: 'camera', id: decodeURIComponent(camera[1]!) };
  const event = /^\/events\/(\d+)$/.exec(path);
  if (event) return { page: 'event', id: Number(event[1]) };
  if (path.startsWith('/events')) return { page: 'events' };
  return { page: 'cameras' };
}

export function navigate(path: string): void {
  if (path === location.pathname) return;
  history.pushState(null, '', path);
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
