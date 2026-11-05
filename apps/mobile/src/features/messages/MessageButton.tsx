import { chatApi, type ContextType } from '@web/features/messages/api';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { useNav } from '../../nav/routes';
import { Button } from '../../ui/Button';
import { Alert, Stack } from '../../ui/Layout';
import type { NavTarget } from '../notifications/links';

/** The page a conversation is about. */
export function contextLink(type: ContextType, id: string): NavTarget {
  switch (type) {
    case 'LISTING':
      return { name: 'Listing', params: { id } };
    case 'OFFER':
      return { name: 'Offer', params: { id } };
    case 'TRANSACTION':
      return { name: 'Deal', params: { id } };
    case 'LEND_ITEM':
      return { name: 'LendItem', params: { id } };
  }
}

/** Opens (or creates) the conversation about one offer, deal, listing or lend item. */
export function MessageButton({
  contextType,
  contextId,
  label,
  block = false,
}: {
  contextType: ContextType;
  contextId: string;
  label: string;
  block?: boolean;
}) {
  const { t } = useI18n();
  const nav = useNav();
  const qc = useQueryClient();
  const open = useMutation({
    mutationFn: () => chatApi.open(contextType, contextId),
    onSuccess: (c) => {
      qc.setQueryData(['me', 'conversations', c.id], c);
      nav.navigate('Conversation', { id: c.id });
    },
  });
  return (
    <Stack gap={8} {...(block ? {} : { style: { alignSelf: 'flex-start' } })}>
      <Button
        kind="outline"
        block={block}
        small={!block}
        busy={open.isPending}
        label={label}
        onPress={() => open.mutate()}
      />
      {open.isError ? <Alert message={errorMessage(open.error, t)} /> : null}
    </Stack>
  );
}
