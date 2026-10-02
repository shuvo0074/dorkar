import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

/** Stock reserved by deals (transaction.TransactionCreated) and released or consumed later. */
export const m0003StockReservations: Migration = {
  name: '0003_stock_reservations',
  async up(trx) {
    // Sold out only because reservations took the last unit (not marked by the owner).
    await sql`
      alter table listings
        add column stock_sold_out boolean not null default false,
        add constraint listings_stock_sold_out_check check (
          not stock_sold_out or status = 'SOLD_OUT' or (status = 'HIDDEN' and hidden_from = 'SOLD_OUT')
        )`.execute(trx);

    await sql`
      create table stock_reservations (
        transaction_id uuid primary key,
        listing_id uuid not null references listings (id),
        requested_quantity int not null check (requested_quantity > 0),
        -- What was actually taken: less than requested (possibly 0) when stock ran out.
        quantity int not null check (quantity >= 0 and quantity <= requested_quantity),
        status text not null default 'ACTIVE' check (status in ('ACTIVE','RELEASED','CONSUMED')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`.execute(trx);
    await sql`create index stock_reservations_listing_idx on stock_reservations (listing_id, status)`.execute(
      trx,
    );
  },
  async down(trx) {
    await sql`drop table stock_reservations`.execute(trx);
    await sql`alter table listings drop column stock_sold_out`.execute(trx);
  },
};
