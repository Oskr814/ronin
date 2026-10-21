import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ended, setIdleCheck } from './api.js';
import { App } from './App.js';
import { anyBusy } from './busy.js';

// The request portal (#114): people without GitHub ask ronin for small
// changes. A page with no data of its own — everything comes from
// /api/portal/*, behind the login with email and password.

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: ended }),
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

setIdleCheck(() => !anyBusy());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
