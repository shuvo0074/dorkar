import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAccessToken } from '../src/lib/http';
import { fakeApi } from './fake-api';
import { catalogRoutes, ME, PHONES, signedIn } from './fixtures';
import { renderApp } from './render';

afterEach(() => clearAccessToken());

const me = {
  id: ME,
  displayName: 'Nadia',
  userType: 'INDIVIDUAL',
  bio: null,
  district: null,
  area: null,
  locale: 'en',
  avatarMediaId: null,
  memberSince: '2026-10-01T00:00:00.000Z',
  badges: ['PHONE_VERIFIED'],
  capabilities: null,
};

const routes = {
  ...signedIn(),
  ...catalogRoutes,
  'GET /api/v1/me/profile': () => ({ body: { data: me } }),
  'GET /api/v1/me/verifications': () => ({
    body: {
      data: [
        {
          kind: 'PHONE',
          status: 'VERIFIED',
          verifiedAt: '2026-10-01T00:00:00.000Z',
          nidLast4: null,
        },
      ],
    },
  }),
};

describe('profile settings', () => {
  it('saves the public profile', async () => {
    const { calls } = fakeApi({
      ...routes,
      'PATCH /api/v1/me/profile': (body) => ({ body: { data: { ...me, ...(body as object) } } }),
    });
    renderApp('/account/profile');
    const user = userEvent.setup();
    const name = await screen.findByLabelText('Name shown to others');
    await user.clear(name);
    await user.type(name, 'Nadia Electronics');
    await user.click(screen.getByRole('radio', { name: 'Business' }));
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'PATCH /api/v1/me/profile')?.body).toMatchObject({
      displayName: 'Nadia Electronics',
      userType: 'BUSINESS',
      bio: null,
    });
  });

  it('saves what the member sells', async () => {
    const { calls } = fakeApi({
      ...routes,
      'PUT /api/v1/me/seller-capabilities': (body) => ({ body: { data: body } }),
    });
    renderApp('/account/profile');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Send me matching needs' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Electronics › Phones' }));
    await user.selectOptions(screen.getByLabelText('District'), 'gazipur');
    await user.click(screen.getByRole('button', { name: 'Save what you sell' }));
    await waitFor(() =>
      expect(calls.find((c) => c.key === 'PUT /api/v1/me/seller-capabilities')?.body).toEqual({
        roles: ['SELLER'],
        categoryIds: [PHONES],
        serviceDistricts: ['gazipur'],
        deliveryModes: [],
        active: true,
      }),
    );
  });

  it('submits a national ID for checking', async () => {
    const { calls } = fakeApi({
      ...routes,
      'POST /api/v1/me/verifications/nid': () => ({
        status: 202,
        body: { data: { kind: 'NID', status: 'PENDING' } },
      }),
    });
    renderApp('/account/profile');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('NID number'), '১২৩৪৫৬৭৮৯০');
    await user.type(screen.getByLabelText('Date of birth'), '1990-05-01');
    await user.type(screen.getByLabelText('Full name as on the card'), 'Nadia Rahman');
    await user.click(screen.getByRole('button', { name: 'Submit for checking' }));
    expect(await screen.findByText(/Submitted/)).toBeInTheDocument();
    expect(calls.find((c) => c.key === 'POST /api/v1/me/verifications/nid')?.body).toEqual({
      nidNumber: '1234567890',
      dateOfBirth: '1990-05-01',
      fullName: 'Nadia Rahman',
    });
  });
});
