import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { makeQueryClient, routes } from '../src/app/App';
import { SessionProvider } from '../src/features/auth/session';
import { I18nProvider, type Lang } from '../src/lib/i18n';

export function renderApp(path = '/', lang: Lang = 'en') {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const utils = render(
    <QueryClientProvider client={makeQueryClient()}>
      <I18nProvider lang={lang}>
        <SessionProvider>
          <RouterProvider router={router} />
        </SessionProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...utils, router };
}
