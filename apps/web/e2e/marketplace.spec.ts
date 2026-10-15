import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * The marketplace loop across two people, against the full local stack
 * (`pnpm dev:backend` + `pnpm --filter @dorkar/web dev`): a buyer posts a need, a seller offers,
 * the buyer accepts, and both find the deal.
 *   E2E_BASE_URL=http://localhost:5173 E2E_SMS_LOG=var/dev-sms.log pnpm --filter @dorkar/web e2e
 */
const SMS_LOG = process.env['E2E_SMS_LOG'];
/** Seeded by services/catalog-service/migrations/0002_seed_categories.ts (BUY, RENT, BORROW). */
const MOBILE_PHONES = '0192ca7a-0000-7000-8000-000000000101';

function latestCode(phoneE164: string): string {
  const lines = readFileSync(SMS_LOG!, 'utf8').trim().split('\n').reverse();
  for (const line of lines) {
    const m = JSON.parse(line) as { to: string; text: string };
    if (m.to === phoneE164) return /code is (\d{6})/.exec(m.text)![1]!;
  }
  throw new Error(`no SMS for ${phoneE164}`);
}

const randomPhone = () => `018${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

async function signIn(browser: Browser, path: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  const phone = randomPhone();
  await page.goto(path);
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText(/We sent a code to/)).toBeVisible();
  await page.getByLabel('6-digit code').fill(latestCode(`+880${phone.slice(1)}`));
  await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, '\\/')}$`));
  return page;
}

test.skip(!SMS_LOG, 'set E2E_SMS_LOG to the dev SMS file');
test.setTimeout(120_000);

test('need → offer → accept → deal, between two members', async ({ browser }) => {
  // The buyer posts a need.
  const buyer = await signIn(browser, '/needs/new');
  const title = `Used phone for e2e ${Date.now()}`;
  await buyer.getByLabel('Headline').fill(title);
  await buyer.getByLabel('Category').selectOption(MOBILE_PHONES);
  await buyer.getByLabel(/Budget up to/).fill('30000');
  await buyer.getByLabel('District').selectOption('dhaka');
  await buyer.getByRole('button', { name: 'Publish need' }).click();
  await expect(buyer.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(buyer.getByText(/Your need is live/)).toBeVisible();
  const needUrl = buyer.url();

  // A seller makes an offer on it.
  const seller = await signIn(browser, `${new URL(needUrl).pathname}/offer`);
  await seller.getByLabel(/Your total price/).fill('28000');
  await seller.getByRole('button', { name: 'Send offer' }).click();
  await expect(seller.getByText(/Offer sent/)).toBeVisible();

  // The buyer compares, opens and accepts it.
  await buyer.reload();
  await buyer.getByRole('link', { name: '৳28,000' }).click();
  await buyer.getByRole('button', { name: 'Accept offer' }).click();
  await buyer.getByRole('button', { name: 'Yes, accept' }).click();
  await expect(buyer.getByText(/Your deal is being set up/)).toBeVisible();

  // The deal appears for both once the transaction service has handled the event.
  for (const page of [buyer, seller]) {
    await page.goto('/deals');
    await expect(async () => {
      await page.reload();
      await expect(page.getByText('৳28,000').first()).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
  }
});
