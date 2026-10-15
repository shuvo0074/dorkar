import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { AlertIcon } from '../../components/glyphs/glyphs';
import { errorMessage } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { chatApi, type ContextType } from './api';

export function contextLink(type: ContextType, id: string): string {
  switch (type) {
    case 'LISTING':
      return `/listings/${id}`;
    case 'OFFER':
      return `/offers/${id}`;
    case 'TRANSACTION':
      return `/deals/${id}`;
    case 'LEND_ITEM':
      return `/lend/${id}`;
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
  const navigate = useNavigate();
  const qc = useQueryClient();
  const open = useMutation({
    mutationFn: () => chatApi.open(contextType, contextId),
    onSuccess: (c) => {
      qc.setQueryData(['me', 'conversations', c.id], c);
      void navigate(`/messages/${c.id}`);
    },
  });
  return (
    <>
      <button
        type="button"
        className={block ? 'btn btn--outline btn--block' : 'btn btn--outline btn--small'}
        disabled={open.isPending}
        onClick={() => open.mutate()}
      >
        {label}
      </button>
      {open.isError && (
        <p className="alert" role="alert">
          <AlertIcon />
          <span>{errorMessage(open.error, t)}</span>
        </p>
      )}
    </>
  );
}
