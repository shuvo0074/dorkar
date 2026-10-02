import type { DeliveryMode, EventEnvelope, TransactionState } from '@dorkar/contracts';
import type { AuditEntry, RequestContext } from '@dorkar/kernel';
import type {
  ActorRole,
  TransactionCommand,
  TransitionPatch,
} from '../domain/transaction-state-machine';
import type {
  Delivery,
  DeliveryProviderName,
  Deposit,
  DepositStatus,
  DeliveryStatus,
  ListingSnapshot,
  Payment,
  PaymentProviderName,
  PaymentStatus,
  Transaction,
  Transition,
} from '../domain/transaction';

// ---------------------------------------------------------------- payment & delivery ports

/** What a provider decided about a payment; the application persists it. */
export interface PaymentUpdate {
  status: PaymentStatus;
  providerRef?: string | null;
  note?: string | null;
}

/**
 * Money movement, behind a port so bKash/Nagad/cards/escrow plug in without touching the state
 * machine. Calls run inside the transition's DB transaction; adapters that call out to a gateway
 * must be idempotent on `tx.id`.
 */
export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** Whether `refund` actually moves money back (a dispute REFUND is applied only then). */
  readonly supportsRefund: boolean;
  initiate(tx: Transaction): Promise<PaymentUpdate>;
  onCompleted(tx: Transaction, payment: Payment): Promise<PaymentUpdate>;
  refund(tx: Transaction, payment: Payment): Promise<PaymentUpdate>;
  status(tx: Transaction, payment: Payment): Promise<PaymentStatus>;
}

export interface DeliveryArrangement {
  method: DeliveryMode;
  scheduledFor: Date | null;
  notes: string | null;
}

export interface DeliveryUpdate {
  status: DeliveryStatus;
  providerRef?: string | null;
}

/** Fulfilment, behind a port so Pathao/Steadfast/RedX plug in later. */
export interface DeliveryProvider {
  readonly name: DeliveryProviderName;
  arrange(tx: Transaction, input: DeliveryArrangement): Promise<DeliveryUpdate>;
  markDelivered(tx: Transaction, delivery: Delivery): Promise<DeliveryUpdate>;
  cancel(tx: Transaction, delivery: Delivery): Promise<DeliveryUpdate>;
}

/** Providers keyed by name; plus the policy choosing one for a new payment/delivery. */
export interface ProviderRegistry<P extends { name: string }> {
  get(name: string): P;
}

export interface ProviderSelection {
  paymentFor(tx: Transaction): PaymentProviderName;
  deliveryFor(tx: Transaction, method: DeliveryMode): DeliveryProviderName;
}

// ---------------------------------------------------------------- storage

export type NewTransaction = Omit<
  Transaction,
  | 'state'
  | 'buyerConfirmedAt'
  | 'sellerConfirmedAt'
  | 'deliveredAt'
  | 'handedOverAt'
  | 'returnReportedAt'
  | 'returnedAt'
  | 'completedAt'
  | 'cancelReason'
  | 'disputeReason'
  | 'disputeCategory'
  | 'preDisputeState'
  | 'createdAt'
  | 'updatedAt'
  | 'version'
>;

export interface TransitionRecord {
  transactionId: string;
  from: TransactionState;
  to: TransactionState;
  command: TransactionCommand;
  actorId: string | null;
  actorRole: ActorRole;
  reason: string | null;
}

export interface ListQuery {
  state?: TransactionState | undefined;
  cursor: { k: string | number; id: string } | null;
  limit: number;
}

export interface Loaded {
  tx: Transaction;
  /** Database clock at read time; deadlines are always compared against it. */
  now: Date;
}

/** Everything the use cases need from storage, bound to one executor (autocommit or a transaction). */
export interface TransactionStore {
  load(id: string): Promise<Loaded | null>;
  /**
   * Inserts; returns null when a transaction for the same source already exists (every source
   * type except LISTING is unique per source id).
   */
  insert(tx: NewTransaction): Promise<Transaction | null>;
  /** Guarded `UPDATE … WHERE state = from AND version = v`; null when someone else won. */
  transition(
    id: string,
    guard: { from: TransactionState; version: number },
    to: TransactionState,
    patch: TransitionPatch,
  ): Promise<Transaction | null>;
  appendTransition(t: TransitionRecord): Promise<void>;
  transitions(transactionId: string): Promise<Transition[]>;

  payment(transactionId: string): Promise<Payment | null>;
  insertPayment(
    tx: Transaction,
    provider: PaymentProviderName,
    update: PaymentUpdate,
  ): Promise<Payment>;
  updatePayment(paymentId: string, update: PaymentUpdate): Promise<void>;

  delivery(transactionId: string): Promise<Delivery | null>;
  insertDelivery(
    tx: Transaction,
    provider: DeliveryProviderName,
    input: DeliveryArrangement,
    update: DeliveryUpdate,
  ): Promise<Delivery>;
  updateDelivery(deliveryId: string, update: DeliveryUpdate): Promise<void>;

  deposit(transactionId: string): Promise<Deposit | null>;
  insertDeposit(tx: Transaction, amount: number): Promise<Deposit>;
  updateDeposit(depositId: string, status: DepositStatus, note: string | null): Promise<void>;

  listForParty(
    accountId: string,
    role: 'buyer' | 'seller' | undefined,
    q: ListQuery,
  ): Promise<Transaction[]>;
  listAll(q: ListQuery): Promise<Transaction[]>;
  /** Ids of CREATED transactions past the confirmation TTL (rows locked, skip locked). */
  dueForExpiry(confirmTtlMs: number, limit: number): Promise<string[]>;
  /**
   * Ids of DELIVERED transactions past the completion window and RETURNED ones past the return
   * window (rows locked, skip locked).
   */
  dueForAutoComplete(
    windows: { deliveredMs: number; returnedMs: number },
    limit: number,
  ): Promise<string[]>;

  listing(listingId: string): Promise<ListingSnapshot | null>;
  /** Guarded decrement of the projected stock; false when not enough is left. */
  reserveListing(listingId: string, quantity: number): Promise<boolean>;
  upsertListing(l: Omit<ListingSnapshot, 'available'>, publish: boolean): Promise<void>;
  markListingUnavailable(listingId: string): Promise<void>;

  audit(ctx: RequestContext, entry: AuditEntry): Promise<void>;
  outbox(events: EventEnvelope<unknown> | EventEnvelope<unknown>[]): Promise<void>;
}

export interface TransactionUnitOfWork {
  readonly store: TransactionStore;
  transaction<T>(fn: (store: TransactionStore) => Promise<T>): Promise<T>;
}
