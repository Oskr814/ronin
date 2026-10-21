import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from './shell/Shell.js';
import { queryClient } from './shell/state.js';

// The dashboard (#65, all of it in React since #235): the shell (shell/)
// and its pages (pages/), on one cache of what was read from the API.
createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  </StrictMode>,
);
