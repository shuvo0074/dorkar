import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAccessToken } from '../src/lib/http';
import { fakeApi } from './fake-api';
import { catalogRoutes, need, NEED, OTHER, PHONES, signedIn, signedOut } from './fixtures';
import { renderApp } from './render';

afterEach(() => clearAccessToken());

describe('posting a need', () => {
  it('carries the composer text into the form and publishes', async () => {
    localStorage.setItem(
      'dorkar.needDraft',
      JSON.stringify({ mode: 'BUY', text: 'Used iPhone 15 Pro, 256GB\nBattery above 85%' }),
    );
    const { calls } = fakeApi({
      ...signedIn(),
      ...catalogRoutes,
      'POST /api/v1/needs': (body) => ({
        status: 201,
        body: { data: need({ ...(body as object), id: NEED }) },
      }),
      [`GET /api/v1/needs/${NEED}`]: () => ({ body: { data: need() } }),
    });
    const { router } = renderApp('/needs/new');
    const user = userEvent.setup();

    expect(await screen.findByRole('heading', { level: 1, name: 'Post a need' })).toBeVisible();
    expect(screen.getByLabelText('Headline')).toHaveValue('Used iPhone 15 Pro, 256GB');
    expect(screen.getByLabelText(/More about it/)).toHaveValue('Battery above 85%');

    await user.selectOptions(await screen.findByLabelText('Category'), PHONES);
    await user.type(await screen.findByLabelText(/Brand/), 'Apple');
    await user.type(screen.getByLabelText(/Budget up to/), '80,000');
    await user.selectOptions(screen.getByLabelText('District'), 'dhaka');
    await user.click(screen.getByRole('button', { name: 'Publish need' }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/needs/${NEED}`));
    const post = calls.find((c) => c.key === 'POST /api/v1/needs')!;
    expect(post.body).toMatchObject({
      mode: 'BUY',
      categoryId: PHONES,
      title: 'Used iPhone 15 Pro, 256GB',
      description: 'Battery above 85%',
      quantity: 1,
      budget: { min: null, max: { amount: 8_000_000, currency: 'BDT' }, flexible: false },
      attributes: { brand: 'Apple' },
      location: { district: 'dhaka' },
      publish: true,
    });
    expect(await screen.findByText(/Your need is live/)).toBeInTheDocument();
    expect(localStorage.getItem('dorkar.needDraft')).toBeNull();
  });

  it('marks missing fields and contact details without calling the API', async () => {
    const { calls } = fakeApi({ ...signedIn(), ...catalogRoutes });
    renderApp('/needs/new');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Headline'), 'Call me 01712345678');
    await user.click(screen.getByRole('button', { name: 'Publish need' }));
    expect(await screen.findByText('Fix the marked fields, then try again.')).toBeInTheDocument();
    expect(screen.getByLabelText('Headline')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Category')).toHaveAttribute('aria-invalid', 'true');
    expect(calls.some((c) => c.key === 'POST /api/v1/needs')).toBe(false);
  });

  it('sends a signed-out visitor to sign in and back to the form', async () => {
    fakeApi(signedOut);
    const { router } = renderApp('/needs/new');
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(router.state.location.state).toMatchObject({ from: '/needs/new' });
  });
});

describe('need page', () => {
  it('shows the owner their controls and closes after confirming', async () => {
    const { calls } = fakeApi({
      ...signedIn(),
      ...catalogRoutes,
      [`GET /api/v1/needs/${NEED}`]: () => ({ body: { data: need() } }),
      [`POST /api/v1/needs/${NEED}/close`]: () => ({ body: { data: need({ status: 'CLOSED' }) } }),
    });
    renderApp(`/needs/${NEED}`);
    const user = userEvent.setup();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Used iPhone 15 Pro, 256GB' }),
    ).toBeVisible();
    expect(await screen.findByText('This is your need')).toBeInTheDocument();
    expect(await screen.findByText('Apple')).toBeInTheDocument();
    expect(screen.getByText('Used is fine')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close need' }));
    await user.click(screen.getByRole('button', { name: 'Yes, close it' }));
    await waitFor(() =>
      expect(calls.some((c) => c.key === `POST /api/v1/needs/${NEED}/close`)).toBe(true),
    );
    expect(await screen.findByText('Closed')).toBeInTheDocument();
  });

  it('invites a visitor to sign in to make an offer', async () => {
    fakeApi({
      ...signedOut,
      ...catalogRoutes,
      [`GET /api/v1/needs/${NEED}`]: () => ({ body: { data: need({ requesterId: OTHER }) } }),
    });
    renderApp(`/needs/${NEED}`);
    expect(await screen.findByRole('link', { name: 'Sign in to make an offer' })).toBeVisible();
    expect(screen.queryByText('This is your need')).not.toBeInTheDocument();
  });

  it('renders in Bangla', async () => {
    fakeApi({
      ...signedOut,
      ...catalogRoutes,
      [`GET /api/v1/needs/${NEED}`]: () => ({ body: { data: need({ requesterId: OTHER }) } }),
    });
    renderApp(`/needs/${NEED}`, 'bn');
    expect(await screen.findByText('এই দরকার সম্পর্কে')).toBeInTheDocument();
    expect(screen.getAllByText(/Mirpur, ঢাকা/).length).toBeGreaterThan(0);
  });
});
