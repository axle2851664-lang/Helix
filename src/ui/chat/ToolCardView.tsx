import { Icon } from '../components/Icon.js';
import type { CardItem, ToolCard } from '../../tools/cards.js';

/**
 * The on-screen half of a two-part reply.
 *
 * It renders below the spoken line rather than replacing it, because the two
 * are answering different questions: the line answers "what happened", the
 * card answers "show me". Reading the card aloud would be the failure this
 * split exists to avoid, so nothing here is ever fed back to speech.
 *
 * Two things are always drawn, never conditionally: the source on every row,
 * and the caveat at the foot. A card that shows a number without saying where
 * it came from or what it excludes is the kind of confident output that gets
 * believed and should not be.
 */

const KIND_ICON = {
  brief: 'activity',
  plan: 'check',
  requirement: 'alert',
} as const;

export function ToolCardView({ card }: { card: ToolCard }) {
  return (
    <section className={`hx-card hx-card--${card.kind}`} aria-label={card.title}>
      <header className="hx-card__head">
        <Icon name={KIND_ICON[card.kind]} size={14} />
        <h3 className="hx-card__title">{card.title}</h3>
        {card.subtitle && <span className="hx-card__subtitle">{card.subtitle}</span>}
      </header>

      {card.sections.map((section, index) => (
        <div className="hx-card__section" key={section.heading ?? `section-${index}`}>
          {section.heading && <h4 className="hx-card__heading">{section.heading}</h4>}

          {section.items.length === 0 ? (
            <p className="hx-card__empty">{section.empty ?? 'Nothing here.'}</p>
          ) : (
            <ul className="hx-card__items">
              {section.items.map((item) => (
                <CardRow key={item.label} item={item} />
              ))}
            </ul>
          )}
        </div>
      ))}

      <footer className="hx-card__caveat">{card.caveat}</footer>
    </section>
  );
}

function CardRow({ item }: { item: CardItem }) {
  return (
    <li className={`hx-card__row hx-card__row--${item.accent ?? 'normal'}`}>
      <div className="hx-card__row-head">
        <span className="hx-card__label">{item.label}</span>
        {item.meta && <span className="hx-card__meta">{item.meta}</span>}
      </div>
      {item.detail && <p className="hx-card__detail">{item.detail}</p>}
      <span className="hx-card__source">{item.source}</span>
    </li>
  );
}
