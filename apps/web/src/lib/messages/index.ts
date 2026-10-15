import { core } from './core';
import { market } from './market';
import { needs } from './needs';
import { offers } from './offers';
import { deals } from './deals';
import { trust } from './trust';
import { listings } from './listings';
import { notifications } from './notifications';
import { profile } from './profile';
import { chat } from './chat';
import { disputes } from './disputes';
import { rentals } from './rentals';
import { lending } from './lending';
import { auctions } from './auctions';
import { staff } from './staff';

/**
 * Every English string, one table per area merged flat. Keys are the app's message keys; the
 * Bangla tables in bn/ are typed against these, so a missing translation is a compile error.
 */
export const en = {
  ...core,
  ...market,
  ...needs,
  ...offers,
  ...deals,
  ...trust,
  ...listings,
  ...notifications,
  ...profile,
  ...chat,
  ...disputes,
  ...rentals,
  ...lending,
  ...auctions,
  ...staff,
};
