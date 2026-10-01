import { Biro } from '../components/ui/Biro';
import { Composer } from '../features/needs/Composer';
import { exampleCode, exampleNeeds } from '../features/needs/examples';
import { useI18n } from '../lib/i18n';

export default function HomeRoute() {
  const { t, lang } = useI18n();

  return (
    <div className="home">
      <section aria-labelledby="home-title">
        <h1 id="home-title" className="home__title" tabIndex={-1}>
          {t('home.title')}
        </h1>
        <p className="home__lede">{t('home.lede')}</p>
        <Composer />
      </section>

      <section className="home__catalog" aria-labelledby="examples-title">
        <div className="section-head">
          <h2 id="examples-title">{t('examples.title')}</h2>
          <p>{t('examples.note')}</p>
        </div>
        <ul className="catalog">
          {exampleNeeds.map((e) => {
            const copy = e[lang];
            return (
              <li key={exampleCode(e)} className="entry">
                <div className="entry__art">
                  {e.glyph}
                  {e.circled && <Biro tilt={e.n % 2 ? -4 : 3} />}
                </div>
                <span className="entry__code code">{exampleCode(e)}</span>
                <span className="entry__title">{copy.title}</span>
                <span className="entry__meta">{copy.meta}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="how-title">
        <div className="section-head">
          <h2 id="how-title">{t('how.title')}</h2>
        </div>
        <ol className="steps">
          {([1, 2, 3] as const).map((n) => (
            <li key={n}>
              <h3>{t(`how.${n}.title`)}</h3>
              <p>{t(`how.${n}.body`)}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
