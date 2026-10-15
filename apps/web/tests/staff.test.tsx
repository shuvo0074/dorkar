import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAccessToken } from '../src/lib/http';
import { fakeApi } from './fake-api';
import { NEED, OTHER, signedIn } from './fixtures';
import { renderApp } from './render';

afterEach(() => clearAccessToken());

const CASE = '0192f0c4-0000-7000-8000-0000000ca001';
const modCase = (over: Record<string, unknown> = {}) => ({
  id: CASE,
  targetType: 'NEED',
  targetId: NEED,
  status: 'OPEN',
  reportCount: 3,
  topReason: 'SCAM',
  priority: 7,
  assignedTo: null,
  targetHidden: false,
  openedAt: '2026-10-15T08:00:00.000Z',
  closedAt: null,
  version: 1,
  reports: [
    {
      id: 'r1',
      reporterId: OTHER,
      reason: 'SCAM',
      details: 'Asks for advance payment',
      status: 'OPEN',
      createdAt: '2026-10-15T08:00:00.000Z',
    },
  ],
  actions: [],
  ...over,
});

describe('the desk for moderators', () => {
  it('shows a moderator the desk with their tools only', async () => {
    fakeApi(signedIn(['MODERATOR']));
    renderApp('/desk');
    expect(await screen.findByRole('link', { name: 'Moderation' })).toHaveAttribute(
      'href',
      '/desk/moderation',
    );
    expect(screen.queryByRole('link', { name: 'Disputes' })).not.toBeInTheDocument();
    expect(screen.queryByText('Figures')).not.toBeInTheDocument();
  });

  it('keeps members out of staff tools', async () => {
    fakeApi(signedIn(['MEMBER']));
    renderApp('/desk/moderation');
    expect(await screen.findByRole('heading', { name: 'Staff only' })).toBeVisible();
  });

  it('lists open cases and hides the reported need with a reason', async () => {
    const { calls } = fakeApi({
      ...signedIn(['MODERATOR']),
      'GET /api/v1/admin/moderation/cases': () => ({
        body: { data: [modCase()], page: { nextCursor: null } },
      }),
      [`GET /api/v1/admin/moderation/cases/${CASE}`]: () => ({ body: { data: modCase() } }),
      [`POST /api/v1/admin/moderation/cases/${CASE}/actions`]: () => ({
        body: { data: modCase({ status: 'ACTIONED', targetHidden: true }) },
      }),
    });
    const { router } = renderApp('/desk/moderation');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Need · 3 reports' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/desk/moderation/${CASE}`));
    expect(await screen.findByText('“Asks for advance payment”')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide it' }));
    await user.type(screen.getByLabelText('Reason'), 'Advance-fee scam');
    await user.click(screen.getByRole('button', { name: 'Hide it' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.key === `POST /api/v1/admin/moderation/cases/${CASE}/actions`)?.body,
      ).toEqual({
        action: 'HIDE',
        reason: 'Advance-fee scam',
      }),
    );
  });
});
