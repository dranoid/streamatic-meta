import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/app-shell';
import { api } from '@/lib/api';
import { useRoute } from '@/lib/router';
import { AboutPage } from '@/pages/about';
import { CameraPage } from '@/pages/camera';
import { ClipPage } from '@/pages/clip';
import { ClipsPage } from '@/pages/clips';
import { CamerasPage } from '@/pages/cameras';
import { EventPage } from '@/pages/event';
import { EventsPage } from '@/pages/events';
import { SetupCameraPage, SetupPage } from '@/pages/setup';
import { TryPage } from '@/pages/try';
import { AbilitiesProvider } from '@/lib/abilities';
import './styles.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 10_000 } } });

function App() {
  const parsed = useRoute();
  const app = useQuery({ queryKey: ['app'], queryFn: api.app, staleTime: Infinity });
  if (app.isPending) return null;
  const isPublic = app.data?.public ?? false;
  // The public page has no cameras or events, so every other path opens its clips. The private app sets up its cameras on their own pages.
  const route = isPublic && ['cameras', 'camera', 'events', 'event'].includes(parsed.page) ? ({ page: 'clips' } as const) : !isPublic && (parsed.page === 'setup' || parsed.page === 'setup-camera') ? ({ page: 'cameras' } as const) : parsed;
  return (
    <AbilitiesProvider value={app.data ?? null}>
    <AppShell route={route} isPublic={isPublic} credit={app.data?.credit ?? null}>
      {route.page === 'cameras' && <CamerasPage />}
      {route.page === 'camera' && <CameraPage id={route.id} />}
      {route.page === 'events' && <EventsPage />}
      {route.page === 'event' && <EventPage id={route.id} />}
      {route.page === 'clips' && <ClipsPage isPublic={isPublic} {...(app.data ? { app: app.data } : {})} />}
      {route.page === 'try' && <TryPage />}
      {route.page === 'setup' && <SetupPage />}
      {route.page === 'setup-camera' && <SetupCameraPage key={route.id} id={route.id} />}
      {route.page === 'clip' && <ClipPage id={route.id} isPublic={isPublic} trackSeconds={app.data?.trackSeconds ?? null} />}
      {route.page === 'about' && <AboutPage />}
    </AppShell>
    </AbilitiesProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
