import type { Mode } from '@web/features/needs/modes';
import type { ComponentType } from 'react';
import {
  BorrowIcon,
  BuyIcon,
  HireIcon,
  RentIcon,
  SourceIcon,
  type IconProps,
} from '../../ui/icons';

export const modeIcon: Record<Mode, ComponentType<IconProps>> = {
  BUY: BuyIcon,
  RENT: RentIcon,
  BORROW: BorrowIcon,
  HIRE: HireIcon,
  SOURCE: SourceIcon,
};
