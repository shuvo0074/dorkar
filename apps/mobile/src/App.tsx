import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { c } from './design/tokens';
import { SessionProvider } from './features/auth/session';
import { ApiError } from './lib/http';
import { I18nProvider } from './lib/i18n';
import { hydrateStorage } from './lib/storage';
import { AppNavigator } from './nav/AppNavigator';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Don't hammer the API on client errors; retry transient ones once.
      retry: (count, err) => count < 1 && !(err instanceof ApiError && err.status < 500),
    },
  },
});

export function App() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void hydrateStorage().then(() => setReady(true));
  }, []);
  if (!ready) return <View style={{ flex: 1, backgroundColor: c.ground }} />;
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <SessionProvider>
            <AppNavigator />
          </SessionProvider>
        </I18nProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
