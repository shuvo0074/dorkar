import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const SMS_LOG = process.env['E2E_SMS_LOG'];

/** Reads the newest code the dev SMS provider wrote for this number. */
function latestCode(phoneE164: string): string {
  const lines = readFileSync(SMS_LOG!, 'utf8').trim().split('\n').reverse();
  for (const line of lines) {
    const m = JSON.parse(line) as { to: string; text: string };
    if (m.to === phoneE164) return /code is (\d{6})/.exec(m.text)![1]!;
  }
  throw new Error(`no SMS for ${phoneE164}`);
}

const randomPhone = () => `017${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

test.skip(!SMS_LOG, 'set E2E_SMS_LOG to the identity dev SMS file');

test('post-a-need visitor signs in, lands on the need form with their words, and signs out', async ({
  page,
}) => {
  const phone = randomPhone();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/What do you need\?/i);

  await page.getByLabel('Your need').fill('Used iPhone 15 Pro, 256GB, Dhaka');
  await page.getByRole('button', { name: 'Post need' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText(/We sent a code to/)).toBeVisible();
  await page.getByLabel('6-digit code').fill(latestCode(`+880${phone.slice(1)}`));

  // Signing in carries the visitor straight on to the need they started, words intact.
  await expect(page).toHaveURL(/\/needs\/new$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Post a need' })).toBeVisible();
  await expect(page.getByLabel('Headline')).toHaveValue('Used iPhone 15 Pro, 256GB, Dhaka');

  await page.goto('/account');
  await expect(page.getByText('This browser')).toBeVisible();

  // Reload: the session is restored from the httpOnly refresh cookie.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out', exact: true }).last().click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/account');
  await expect(page).toHaveURL(/\/sign-in$/);
});
