import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAccessToken } from '../src/lib/http';
import { fakeApi } from './fake-api';
import { dispute, DISPUTE, signedIn } from './fixtures';
import { renderApp } from './render';

afterEach(() => clearAccessToken());

describe('disputes', () => {
  it('lists the member’s disputes', async () => {
    fakeApi({
      ...signedIn(),
      'GET /api/v1/me/disputes': () => ({
        body: { data: [dispute()], page: { nextCursor: null } },
      }),
    });
    renderApp('/disputes');
    expect(await screen.findByRole('link', { name: 'Not returned' })).toHaveAttribute(
      'href',
      `/disputes/${DISPUTE}`,
    );
  });

  it('lets the respondent give a statement', async () => {
    const { calls } = fakeApi({
      ...signedIn(),
      [`GET /api/v1/disputes/${DISPUTE}`]: () => ({ body: { data: dispute() } }),
      [`POST /api/v1/disputes/${DISPUTE}/statement`]: () => ({
        body: {
          data: dispute({
            status: 'UNDER_REVIEW',
            actions: ['evidence'],
            statementSubmitted: true,
          }),
        },
      }),
    });
    renderApp(`/disputes/${DISPUTE}`);
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { level: 1, name: 'Not returned' })).toBeVisible();
    expect(screen.getByText('The other side')).toBeInTheDocument();
    await user.type(
      screen.getByLabelText('Your statement'),
      'I returned it on Friday at the gate.',
    );
    await user.click(screen.getByRole('button', { name: 'Submit statement' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.key === `POST /api/v1/disputes/${DISPUTE}/statement`)?.body,
      ).toEqual({
        text: 'I returned it on Friday at the gate.',
      }),
    );
    expect(await screen.findByText('Under review')).toBeInTheDocument();
    expect(screen.queryByLabelText('Your statement')).not.toBeInTheDocument();
  });
});
