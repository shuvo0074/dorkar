import { itemCode, type LendItem } from '@web/features/lending/api';
import { useFormat } from '@web/lib/format';
import { c } from '../../design/tokens';
import { useI18n } from '../../lib/i18n';
import { useNav } from '../../nav/routes';
import { BorrowIcon } from '../../ui/icons';
import { MediaImage } from '../../ui/Misc';
import { EntryCard, entryPhoto, EntryStamp } from '../catalog/pageParts';

/** A lend item as a card; lay these out two to a row. */
export function LendEntry({ item }: { item: LendItem }) {
  const { t } = useI18n();
  const f = useFormat();
  const nav = useNav();
  const stamp = (
    <EntryStamp>
      <BorrowIcon size={32} color={c.inkSoft} />
    </EntryStamp>
  );
  return (
    <EntryCard
      art={
        item.mediaIds[0] ? (
          <MediaImage id={item.mediaIds[0]} style={entryPhoto} fallback={stamp} />
        ) : (
          stamp
        )
      }
      code={itemCode(item.id)}
      title={item.title}
      meta={`${f.district(item.district)} · ${
        item.deposit ? `${t('lend.deposit')} ${f.taka(item.deposit)}` : t('lend.noDeposit')
      }`}
      onPress={() => nav.navigate('LendItem', { id: item.id })}
    />
  );
}
