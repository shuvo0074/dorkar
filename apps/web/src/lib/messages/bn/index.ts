import type { MessageKey } from '../../i18n';
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

/** All Bangla strings. Loaded on demand, so English readers never download them. */
export const bn: Record<MessageKey, string> = {
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
