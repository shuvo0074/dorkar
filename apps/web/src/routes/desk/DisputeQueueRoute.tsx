import { Link, useSearchParams } from 'react-router';
import { Segmented } from '../../components/forms/fields';
import { ScalesGlyph } from '../../components/glyphs/glyphs';
import { MoreButton, usePaged } from '../../components/ui/Paging';
import { LedgerSkeleton, LoadError } from '../../components/ui/Status';
import { dealCode } from '../../features/deals/api';
import { disputesApi } from '../../features/disputes/api';
import { DeskCrumb, StaffPage } from '../../features/desk/tools';
import { shortCode, useFormat } from '../../lib/format';
import { useI18n } from '../../lib/i18n';

export default function DisputeQueueRoute() {
  return (
    <StaffPage needs="dispute:read" from="/desk/disputes">
      <Queue />
    </StaffPage>
  );
}

function Queue() {
  const { t } = useI18n();
  const f = useFormat();
  const [params, setParams] = useSearchParams();
  const assignee = params.get('assignee') ?? '';
  const list = usePaged(['desk', 'disputes', assignee], (cursor) =>
    disputesApi.queue({ assignee: assignee || undefined }, cursor),
  );
  return (
    <div className="browse">
      <header className="desk__head">
        <DeskCrumb />
        <h1 tabIndex={-1}>{t('sdisp.title')}</h1>
        <p className="desk__lede">{t('sdisp.lede')}</p>
      </header>
      <section aria-labelledby="queue-title">
        <div className="section-head">
          <h2 id="queue-title">{t('sdisp.title')}</h2>
        </div>
        <Segmented
          legend={t('sdisp.assignee')}
          name="dispute-assignee"
          value={assignee}
          onChange={(v) => setParams(v ? { assignee: v } : {})}
          options={[
            { value: '', label: t('staff.any') },
            { value: 'me', label: t('sdisp.mine') },
            { value: 'none', label: t('sdisp.none') },
          ]}
        />
        {list.isPending && <LedgerSkeleton rows={4} />}
        {list.isError && <LoadError onRetry={() => void list.refetch()} />}
        {list.data && list.rows.length === 0 && <p className="muted">{t('sdisp.empty')}</p>}
        {list.rows.length > 0 && (
          <ul className="ledger">
            {list.rows.map((d) => (
              <li key={d.id}>
                <span className="ledger__art">
                  <ScalesGlyph />
                </span>
                <div>
                  <Link className="ledger__title" to={`/disputes/${d.id}`}>
                    {t(`reason.${d.reason}`)}
                  </Link>
                  <p className="ledger__meta">
                    {[
                      shortCode('D', d.id),
                      t('dispute.onDeal', { code: dealCode(d.transactionId) }),
                      f.state(d.status),
                      d.assignedTo
                        ? t('staff.assigned', { who: shortCode('M', d.assignedTo) })
                        : t('staff.unassigned'),
                      t('dispute.respondBy') + ' ' + f.relative(d.respondBy),
                    ].join(' · ')}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <MoreButton query={list} />
      </section>
    </div>
  );
}
