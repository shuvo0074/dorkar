import { Link } from 'react-router';
import { useI18n } from '../lib/i18n';

export default function NotFoundRoute() {
  const { t } = useI18n();
  return (
    <div className="notfound">
      <h1 tabIndex={-1}>{t('notFound.title')}</h1>
      <p>{t('notFound.body')}</p>
      <p>
        <Link to="/" className="btn btn--outline">
          {t('notFound.back')}
        </Link>
      </p>
    </div>
  );
}
