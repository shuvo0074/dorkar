import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAccessToken } from '../src/lib/http';
import { account, fakeApi, inTenMinutes } from './fake-api';
import { renderApp } from './render';

afterEach(() => clearAccessToken());

const signedOut = {
  'POST /api/v1/auth/refresh': () => ({
    status: 401,
    body: { error: { code: 'UNAUTHENTICATED' } },
  }),
};

describe('home', () => {
  it('leads with the need composer and labels the examples as examples', async () => {
    fakeApi(signedOut);
    renderApp('/');
    expect(
      screen.getByRole('heading', { level: 1, name: 'What do you need?' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'I want to' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Buy/ })).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByText('Examples only, until the first real needs are posted.'),
    ).toBeInTheDocument();
  });

  it('switches mode with the keyboard and updates the example placeholder', async () => {
    fakeApi(signedOut);
    renderApp('/');
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /Buy/ }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: /Rent/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Your need')).toHaveAttribute(
      'placeholder',
      expect.stringContaining('Microbus'),
    );
  });

  it('asks for text first, then sends a signed-out visitor to sign in with the draft kept', async () => {
    fakeApi(signedOut);
    const { router } = renderApp('/');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Post need' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Write what you need first.');
    await user.type(screen.getByLabelText('Your need'), 'Used iPhone 15 Pro');
    await waitFor(() =>
      expect(
        screen.queryByText('Sign in with your mobile number to post. It takes a minute.'),
      ).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'Post need' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(JSON.parse(localStorage.getItem('dorkar.needDraft')!)).toMatchObject({
      text: 'Used iPhone 15 Pro',
    });
  });

  it('renders fully in Bangla', async () => {
    fakeApi(signedOut);
    renderApp('/', 'bn');
    expect(screen.getByRole('heading', { level: 1, name: 'কী দরকার?' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /কিনব/ })).toBeInTheDocument();
  });
});

describe('sign in', () => {
  it('rejects a non-BD number before calling the API', async () => {
    const { calls } = fakeApi(signedOut);
    renderApp('/sign-in');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Mobile number'), '+14155550100');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('isn’t a Bangladeshi mobile number');
    expect(calls.some((c) => c.key.includes('request-otp'))).toBe(false);
  });

  it('phone → code → signed in, sending a device key and label', async () => {
    const { calls } = fakeApi({
      ...signedOut,
      'POST /api/v1/auth/request-otp': () => ({
        status: 202,
        body: { data: { challengeId: 'c-1', expiresAt: inTenMinutes(), resendAfterSeconds: 60 } },
      }),
      'POST /api/v1/auth/verify-otp': (body) =>
        (body as { code: string }).code === '123456'
          ? {
              body: {
                data: {
                  accessToken: 'a',
                  accessTokenExpiresAt: inTenMinutes(),
                  account,
                  isNewAccount: true,
                },
              },
            }
          : { status: 400, body: { error: { code: 'OTP_INVALID', message: 'x' } } },
    });
    const { router } = renderApp('/sign-in');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Mobile number'), '01712345678');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText('We sent a code to +88017•••••678.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New code in 60s' })).toBeDisabled();

    await user.type(screen.getByLabelText('6-digit code'), '999999');
    expect(await screen.findByRole('alert')).toHaveTextContent('That code didn’t work');

    await user.type(screen.getByLabelText('6-digit code'), '123456');
    expect(await screen.findByText('Signed in')).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe('/account'), { timeout: 2000 });

    const req = calls.find((c) => c.key === 'POST /api/v1/auth/request-otp')!.body as {
      deviceKey: string;
    };
    const ver = calls.filter((c) => c.key === 'POST /api/v1/auth/verify-otp').at(-1)!.body as {
      device: { key: string; label: string };
    };
    expect(req.deviceKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ver.device.key).toBe(req.deviceKey);
    expect(ver.device.label).toMatch(/ on /);
  });

  it('shows the server’s rate limit with its wait time', async () => {
    fakeApi({
      ...signedOut,
      'POST /api/v1/auth/request-otp': () => ({
        status: 429,
        body: { error: { code: 'RATE_LIMITED', message: 'x' } },
        headers: { 'retry-after': '42' },
      }),
    });
    renderApp('/sign-in');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Mobile number'), '01712345678');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wait 42 seconds');
  });
});

describe('account', () => {
  const signedIn = {
    'POST /api/v1/auth/refresh': () => ({
      body: { data: { accessToken: 'a', accessTokenExpiresAt: inTenMinutes() } },
    }),
    'GET /api/v1/me/account': () => ({ body: { data: account } }),
    'GET /api/v1/me/sessions': () => ({
      body: {
        data: [
          {
            id: 's1',
            deviceId: 'd1',
            createdAt: account.createdAt,
            lastRefreshedAt: null,
            expiresAt: inTenMinutes(),
            current: true,
          },
        ],
      },
    }),
    'GET /api/v1/me/devices': () => ({
      body: {
        data: [
          {
            id: 'd1',
            platform: 'web',
            label: 'Chrome on Android',
            trust: 'UNTRUSTED',
            createdAt: account.createdAt,
            lastSeenAt: account.createdAt,
            current: true,
          },
          {
            id: 'd2',
            platform: 'web',
            label: 'Firefox on Windows',
            trust: 'UNTRUSTED',
            createdAt: account.createdAt,
            lastSeenAt: account.createdAt,
            current: false,
          },
        ],
      },
    }),
    'DELETE /api/v1/me/devices/d2': () => ({ status: 204 }),
  };

  it('sends signed-out visitors to sign in', async () => {
    fakeApi(signedOut);
    const { router } = renderApp('/account');
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
  });

  it('shows the account, devices and sessions, and revokes another device after confirmation', async () => {
    const { calls } = fakeApi(signedIn);
    renderApp('/account');
    expect(await screen.findByText('+88017•••••678')).toBeInTheDocument();
    expect(await screen.findByText('Firefox on Windows')).toBeInTheDocument();
    expect(screen.getAllByText('This device').length).toBeGreaterThan(0);

    const user = userEvent.setup();
    const signOutButtons = screen.getAllByRole('button', { name: 'Sign out' });
    // the device row's button comes before the page-level sign out
    await user.click(signOutButtons[0]!);
    expect(screen.getByText(/Sign out Firefox on Windows\?/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, sign it out' }));
    await waitFor(() =>
      expect(calls.some((c) => c.key === 'DELETE /api/v1/me/devices/d2')).toBe(true),
    );
  });
});
