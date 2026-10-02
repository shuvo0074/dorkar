import { findContactInfo, type Condition, type District, type NeedMode } from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';

/** What a lender asks of borrowers. Checked against the borrower's projected signals. */
export interface Requirements {
  nidVerified: boolean;
  minCompletedDeals: number;
  /** 1–5, or null for "no rating requirement". */
  minRating: number | null;
}

export const NO_REQUIREMENTS: Requirements = {
  nidVerified: false,
  minCompletedDeals: 0,
  minRating: null,
};

export interface LendItem {
  id: string;
  lenderId: string;
  categoryId: string;
  title: string;
  description: string;
  condition: Condition;
  district: District;
  mediaIds: string[];
  /** Poisha; null when no deposit is asked. */
  depositAmount: number | null;
  maxLoanDays: number;
  requirements: Requirements;
  active: boolean;
  /** Hidden by moderation: invisible to everyone but the owner. */
  hidden: boolean;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

/** Lender history computed from this service's own loans (never from other services). */
export interface LenderStats {
  completedLoans: number;
  /** Share of returned loans that came back by `returnBy`; null when nothing was returned yet. */
  onTimeReturnRate: number | null;
}

/** Category projection: only active categories that allow BORROW can hold lend items. */
export interface CategoryFacts {
  categoryId: string;
  modes: NeedMode[];
  active: boolean;
}

/** Public text must not leak contact details (phone numbers stay private on Dorkar). */
export function assertNoContactInfo(field: string, text: string | null | undefined): void {
  if (!text) return;
  const kind = findContactInfo(text);
  if (kind) {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      `Remove the ${kind === 'PHONE' ? 'phone number' : 'email address'} from the ${field}. People contact you through Dorkar.`,
      { rule: 'NO_CONTACT_INFO', field },
    );
  }
}

export function assertCategoryLendable(category: CategoryFacts | null): void {
  if (!category || !category.active || !category.modes.includes('BORROW')) {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      'Items in this category cannot be lent. Choose a category that allows borrowing.',
      { rule: 'CATEGORY_NOT_LENDABLE' },
    );
  }
}

export function assertMaxLoanDays(days: number, limit: number): void {
  if (days > limit) {
    throw new AppError('BUSINESS_RULE_VIOLATION', `A loan can last at most ${limit} days.`, {
      rule: 'MAX_LOAN_DAYS_EXCEEDED',
      limit,
    });
  }
}

/** Ratings are kept to two decimals (numeric(3,2)). */
export const normalizeRequirements = (r: Requirements): Requirements => ({
  nidVerified: r.nidVerified,
  minCompletedDeals: r.minCompletedDeals,
  minRating: r.minRating === null ? null : Math.round(r.minRating * 100) / 100,
});

export const dedupe = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
