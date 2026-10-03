import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../../src/contexts/AuthContext';
import { ToastProvider } from '../../src/contexts/ToastContext';
import { LDAPSettings } from '../../src/components/LDAPSettings';
import { OIDCProviderSettings } from '../../src/components/OIDCProviderSettings';
import '../../src/i18n';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
  },
});

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <ToastProvider>
        <main>
          <LDAPSettings />
          <OIDCProviderSettings />
        </main>
      </ToastProvider>
    </AuthProvider>
  </QueryClientProvider>,
);
