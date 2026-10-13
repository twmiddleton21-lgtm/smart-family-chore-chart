import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FamilyData } from '../types';
import { saveMealWeek } from '../lib/meals';
import { makeFamily, MONDAY, SUNDAY, TUESDAY } from '../lib/testFixtures';
import { MealSelect } from '../screens/parent/MealsPanel';
import { TodaysMeals } from './TodaysMeals';

// Static render checks (no DOM or browser): they verify the markup each
// component produces, not clicks or focus behaviour.

const options = [
  { id: 'c', name: 'Curry' },
  { id: 'p', name: 'Pizza' },
];
const noop = () => {};

describe('home-screen lunch card', () => {
  function planned(): FamilyData {
    const r = saveMealWeek(makeFamily(), 'a', MONDAY, [{ date: TUESDAY, main: 'Pizza', pudding: 'Jelly' }], TUESDAY);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  it("shows each child's main and pudding for today", () => {
    const html = renderToStaticMarkup(<TodaysMeals data={planned()} today={TUESDAY} />);
    expect(html).toContain('Today’s school lunch');
    expect(html).toContain('Alex');
    expect(html).toContain('<dd>Pizza</dd>');
    expect(html).toContain('<dd>Jelly</dd>');
    // Bea has nothing planned today.
    expect(html).toContain('Bea');
    expect(html).toContain('No school meal today');
  });

  it('shows a dash for a blank pudding on a day with a main', () => {
    const r = saveMealWeek(makeFamily(), 'a', MONDAY, [{ date: TUESDAY, main: 'Curry', pudding: '' }], TUESDAY);
    if (!r.ok) throw new Error(r.error);
    const html = renderToStaticMarkup(<TodaysMeals data={r.data} today={TUESDAY} />);
    expect(html).toContain('<dd>Curry</dd>');
    expect(html).toContain('<dd>—</dd>');
  });

  it('shows the weekend message and the none-planned message', () => {
    expect(renderToStaticMarkup(<TodaysMeals data={planned()} today={SUNDAY} />)).toContain('Enjoy the weekend');
    expect(renderToStaticMarkup(<TodaysMeals data={makeFamily()} today={TUESDAY} />)).toContain(
      'No school meals planned for today',
    );
  });
});

describe('meal dropdown', () => {
  const render = (value: string) =>
    renderToStaticMarkup(
      <MealSelect
        id="main-x"
        label="Main"
        icon="🍽️"
        blankLabel="— No main —"
        value={value}
        options={options}
        onChange={noop}
        invalid={false}
      />,
    );

  it('lists a blank choice followed by the saved options, and marks the selection', () => {
    const html = render('Pizza');
    expect(html).toMatch(/<option value="">— No main —<\/option><option value="Curry">Curry<\/option><option value="Pizza" selected="">Pizza<\/option>/);
    expect(html).toContain('<label for="main-x"');
  });

  it('selects the blank choice for an unplanned day', () => {
    const html = render('');
    expect(html).toContain('<option value="" selected="">— No main —</option>');
    expect(html).toContain('select-blank');
  });

  it('keeps a saved value that is not in the list, clearly marked, instead of dropping it', () => {
    const html = render('Shepherd’s pie');
    expect(html).toContain('<option value="Shepherd’s pie" selected="">Shepherd’s pie (not in food list)</option>');
  });
});
