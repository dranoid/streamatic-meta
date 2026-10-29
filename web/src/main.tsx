import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/app-shell';
import { useRoute } from '@/lib/router';
import { CameraPage } from '@/pages/camera';
import { CamerasPage } from '@/pages/cameras';
import { EventPage } from '@/pages/event';
import { EventsPage } from '@/pages/events';
import './styles.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 10_000 } } });

function App() {
  const route = useRoute();
  return (
    <AppShell route={route}>
      {route.page === 'cameras' && <CamerasPage />}
      {route.page === 'camera' && <CameraPage id={route.id} />}
      {route.page === 'events' && <EventsPage />}
      {route.page === 'event' && <EventPage id={route.id} />}
    </AppShell>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
