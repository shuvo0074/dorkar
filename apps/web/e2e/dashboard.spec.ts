import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const SMS_LOG = process.env['E2E_SMS_LOG'];

function latestCode(phoneE164: string): string {
  const lines = readFileSync(SMS_LOG!, 'utf8').trim().split('\n').reverse();
  for (const line of lines) {
    const m = JSON.parse(line) as { to: string; text: string };
    if (m.to === phoneE164) return /code is (\d{6})/.exec(m.text)![1]!;
  }
  throw new Error(`no SMS for ${phoneE164}`);
}

const randomPhone = () => `017${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

test.skip(!SMS_LOG, 'set E2E_SMS_LOG to the dev SMS file');

test('a new member opens their dashboard, sees their own sign-in in the activity, and no staff desk', async ({
  page,
}) => {
  const phone = randomPhone();
  await page.goto('/dashboard');
  // Signed out: sign in first, then come back to the dashboard.
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText(/We sent a code to/)).toBeVisible();
  await page.getByLabel('6-digit code').fill(latestCode(`+880${phone.slice(1)}`));

  // A brand-new account is welcomed on its account page first; the dashboard is one tap away.
  await expect(page).toHaveURL(/\/account$/);
  await page.getByRole('link', { name: 'Dashboard' }).first().click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Your dashboard' })).toBeVisible();
  await expect(page.getByText('Open needs').first()).toBeVisible();
  // The activity log is fed by events: the sign-in shows up within seconds.
  await expect(page.getByText('Created an account')).toBeVisible({ timeout: 15_000 });

  // No horizontal scrolling on any viewport.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // Members are refused at the desk.
  await page.goto('/desk');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff only' })).toBeVisible();
});
