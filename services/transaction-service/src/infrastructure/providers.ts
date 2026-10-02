import type {
  DeliveryProvider,
  PaymentProvider,
  ProviderRegistry,
  ProviderSelection,
} from '../application/ports';

/**
 * Cash on delivery/meet-up. Dorkar never holds the money: the payment is recorded as PENDING
 * when the deal is made and as PAID once the transaction completes. Refunds are between the
 * parties, so `refund` only records a note.
 */
export class CashPaymentProvider implements PaymentProvider {
  readonly name = 'CASH' as const;
  readonly supportsRefund = false;

  async initiate() {
    return { status: 'PENDING' as const, providerRef: null };
  }

  async onCompleted() {
    return { status: 'PAID' as const, note: 'Cash settled between the parties on completion.' };
  }

  async refund(_tx: unknown, payment: { status: 'PENDING' | 'PAID' | 'REFUNDED' | 'FAILED' }) {
    return {
      status: payment.status,
      note: 'Cash payments are not refunded through Dorkar; nothing was collected.',
    };
  }

  async status(_tx: unknown, payment: { status: 'PENDING' | 'PAID' | 'REFUNDED' | 'FAILED' }) {
    return payment.status;
  }
}

/** The parties arrange pickup/delivery themselves; we only record method and outcome. */
export class SelfArrangedDelivery implements DeliveryProvider {
  readonly name = 'SELF_ARRANGED' as const;

  async arrange() {
    return { status: 'ARRANGED' as const, providerRef: null };
  }

  async markDelivered() {
    return { status: 'DELIVERED' as const };
  }

  async cancel() {
    return { status: 'CANCELLED' as const };
  }
}

export function providerRegistry<P extends { name: string }>(
  providers: readonly P[],
): ProviderRegistry<P> {
  const byName = new Map(providers.map((p) => [p.name, p]));
  return {
    get(name) {
      const p = byName.get(name);
      if (!p) throw new Error(`No provider registered for ${name}`);
      return p;
    },
  };
}

/** MVP policy: cash for every payment, self-arranged for every delivery method. */
export const mvpProviderSelection: ProviderSelection = {
  paymentFor: () => 'CASH',
  deliveryFor: () => 'SELF_ARRANGED',
};
