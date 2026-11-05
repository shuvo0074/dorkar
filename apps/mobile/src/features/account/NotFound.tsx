import { useI18n } from '../../lib/i18n';
import { useNav } from '../../nav/routes';
import { Button } from '../../ui/Button';
import { Empty, Screen } from '../../ui/Layout';

/** A page whose record doesn't exist, or that this member can't see. */
export function NotFound() {
  const { t } = useI18n();
  const nav = useNav();
  return (
    <Screen>
      <Empty
        title={t('notFound.title')}
        body={t('notFound.body')}
        action={
          <Button
            kind="outline"
            small
            label={t('notFound.back')}
            onPress={() => nav.navigate('Tabs', { screen: 'Home' })}
          />
        }
      />
    </Screen>
  );
}
