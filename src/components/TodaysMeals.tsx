import type { DateKey, FamilyData } from '../types';
import { isSchoolDay, mealFor } from '../lib/meals';
import { Avatar } from './Avatar';

/** Dashboard card showing each child's school main and pudding for today. */
export function TodaysMeals({ data, today }: { data: FamilyData; today: DateKey }) {
  if (data.children.length === 0) return null;
  const schoolDay = isSchoolDay(today);
  const anyPlanned = schoolDay && data.children.some((c) => mealFor(data, c.id, today));

  return (
    <section className="meals-card" aria-labelledby="meals-title">
      <h2 id="meals-title" className="meals-title">
        <span aria-hidden="true">🍽️</span> Today’s school lunch
      </h2>

      {!schoolDay ? (
        <p className="meals-empty">No school lunches today. Enjoy the weekend!</p>
      ) : !anyPlanned ? (
        <p className="meals-empty">No school meals planned for today. A grown-up can add them in the Parent area.</p>
      ) : (
        <ul className="meals-list">
          {data.children.map((child) => {
            const meal = mealFor(data, child.id, today);
            return (
              <li key={child.id} className={`meal-child accent-${child.color}`}>
                <div className="meal-child-head">
                  <Avatar child={child} size="sm" />
                  <span className="meal-child-name">{child.name}</span>
                </div>
                {meal ? (
                  <dl className="meal-items">
                    <div className="meal-item">
                      <dt>
                        <span aria-hidden="true">🍝</span> Main
                      </dt>
                      <dd>{meal.main || '—'}</dd>
                    </div>
                    <div className="meal-item">
                      <dt>
                        <span aria-hidden="true">🍰</span> Pudding
                      </dt>
                      <dd>{meal.pudding || '—'}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="meal-none">No school meal today</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
