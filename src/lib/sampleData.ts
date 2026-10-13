import { DATA_VERSION, type Chore, type Completion, type DateKey, type FamilyData, type MealEntry, type Reward, type Weekday } from '../types';
import { addDays, isScheduledOn } from './dates';
import { foodOptionsFromNames } from './foodOptions';
import { mealWeeks, schoolDays } from './meals';

// Fictional demonstration family. None of this describes a real family.

export const DEFAULT_PIN = '1234';

const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5];

type ChoreSeed = Omit<Chore, 'id' | 'childId'> & { key: string };

const daily = { type: 'daily' } as const;
const weekly = (...days: Weekday[]) => ({ type: 'weekly', days }) as const;

const CHORE_SEEDS: Record<string, ChoreSeed[]> = {
  maya: [
    { key: 'bed', title: 'Make your bed', icon: '🛏️', points: 5, period: 'morning', schedule: daily },
    { key: 'teeth-am', title: 'Brush teeth', icon: '🪥', points: 3, period: 'morning', schedule: daily },
    { key: 'dressed', title: 'Get dressed', icon: '👗', points: 3, period: 'morning', schedule: daily },
    { key: 'bag', title: 'Pack school bag', icon: '🎒', points: 5, period: 'morning', schedule: weekly(...WEEKDAYS) },
    { key: 'reading', title: 'Reading time', icon: '📚', points: 10, period: 'afternoon', schedule: weekly(...WEEKDAYS) },
    { key: 'cat', title: 'Feed the cat', icon: '🐱', points: 5, period: 'afternoon', schedule: daily },
    { key: 'piano', title: 'Piano practice', icon: '🎹', points: 10, period: 'afternoon', schedule: weekly(2, 4, 6) },
    { key: 'table', title: 'Set the table', icon: '🍽️', points: 5, period: 'evening', schedule: daily },
    { key: 'tidy', title: 'Tidy your room', icon: '🧸', points: 5, period: 'evening', schedule: daily },
    { key: 'teeth-pm', title: 'Brush teeth', icon: '🪥', points: 3, period: 'evening', schedule: daily },
  ],
  leo: [
    { key: 'bed', title: 'Make your bed', icon: '🛏️', points: 5, period: 'morning', schedule: daily },
    { key: 'teeth-am', title: 'Brush teeth', icon: '🪥', points: 3, period: 'morning', schedule: daily },
    { key: 'bowl', title: 'Bowl in the sink', icon: '🥣', points: 3, period: 'morning', schedule: daily },
    { key: 'plants', title: 'Water the plants', icon: '🪴', points: 5, period: 'afternoon', schedule: weekly(1, 3, 5) },
    { key: 'toys', title: 'Put toys away', icon: '🧸', points: 5, period: 'evening', schedule: daily },
    { key: 'bath', title: 'Bath time', icon: '🛁', points: 5, period: 'evening', schedule: daily },
    { key: 'teeth-pm', title: 'Brush teeth', icon: '🪥', points: 3, period: 'evening', schedule: daily },
  ],
  ivy: [
    { key: 'bed', title: 'Make your bed', icon: '🛏️', points: 5, period: 'morning', schedule: daily },
    { key: 'dog', title: 'Feed the dog', icon: '🐶', points: 5, period: 'morning', schedule: daily },
    { key: 'teeth-am', title: 'Brush teeth', icon: '🪥', points: 3, period: 'morning', schedule: daily },
    { key: 'homework', title: 'Homework', icon: '✏️', points: 10, period: 'afternoon', schedule: weekly(...WEEKDAYS) },
    { key: 'dishwasher', title: 'Empty the dishwasher', icon: '🍴', points: 10, period: 'afternoon', schedule: daily },
    { key: 'recycling', title: 'Take out recycling', icon: '♻️', points: 10, period: 'evening', schedule: weekly(2, 5) },
    { key: 'read', title: 'Read for 20 minutes', icon: '📖', points: 5, period: 'evening', schedule: daily },
    { key: 'teeth-pm', title: 'Brush teeth', icon: '🪥', points: 3, period: 'evening', schedule: daily },
  ],
};

const REWARDS: Reward[] = [
  { id: 'reward_screen', name: 'Extra screen time', description: '15 extra minutes of tablet or TV time.', icon: '📺', cost: 20 },
  { id: 'reward_movie', name: 'Pick the movie', description: 'Choose the film for family movie night.', icon: '🎬', cost: 40 },
  { id: 'reward_bake', name: 'Bake together', description: 'Bake cookies or a cake with a grown-up.', icon: '🍪', cost: 60 },
  { id: 'reward_park', name: 'Park adventure', description: 'A special trip to your favourite park.', icon: '🛝', cost: 80 },
  { id: 'reward_late', name: 'Stay up late', description: '30 minutes past bedtime on a weekend.', icon: '🌙', cost: 100 },
];

const SAMPLE_MENU: { main: string; pudding: string }[] = [
  { main: 'Cheese & tomato pizza', pudding: 'Strawberry yoghurt' },
  { main: 'Roast chicken dinner', pudding: 'Apple crumble & custard' },
  { main: 'Spaghetti bolognese', pudding: 'Fruit salad' },
  { main: 'Fish fingers & chips', pudding: 'Chocolate sponge' },
  { main: 'Jacket potato & beans', pudding: 'Flapjack' },
  { main: 'Vegetable curry & rice', pudding: 'Banana' },
  { main: 'Sausage & mash', pudding: 'Jelly' },
];

/** Extra catalog choices that are not used in the sample plan. */
const EXTRA_MAINS = ['Chicken wrap', 'Macaroni cheese', 'Veggie burger'];
const EXTRA_PUDDINGS = ['Ice cream', 'Rice pudding', 'Cheese & crackers'];

/** Two weeks of fictional menu choices per child (current + next week). */
function sampleMeals(today: DateKey, childIds: string[]): MealEntry[] {
  const days = mealWeeks(today).slice(0, 2).flatMap(schoolDays);
  return childIds.flatMap((childId, c) =>
    days.map((date, d) => {
      const item = SAMPLE_MENU[(d + c * 2) % SAMPLE_MENU.length]!;
      return { id: `meal_seed_${childId}_${date}`, childId, date, ...item };
    }),
  );
}

/**
 * Build the demo dataset. A few completions are back-dated to the previous
 * two days so the dashboard shows believable point balances from the start.
 */
export function createSampleData(today: DateKey, now: Date = new Date()): FamilyData {
  const children: FamilyData['children'] = [
    { id: 'child_maya', name: 'Maya', avatar: '🦄', color: 'pink' },
    { id: 'child_leo', name: 'Leo', avatar: '🦖', color: 'teal' },
    { id: 'child_ivy', name: 'Ivy', avatar: '🦊', color: 'lavender' },
  ];

  const chores: Chore[] = Object.entries(CHORE_SEEDS).flatMap(([childKey, seeds]) =>
    seeds.map(({ key, ...rest }) => ({ ...rest, id: `chore_${childKey}_${key}`, childId: `child_${childKey}` })),
  );

  const completions: Completion[] = [];
  const history: { daysAgo: number; fraction: number }[] = [
    { daysAgo: 2, fraction: 0.6 },
    { daysAgo: 1, fraction: 0.8 },
  ];
  for (const { daysAgo, fraction } of history) {
    const date = addDays(today, -daysAgo);
    for (const child of children) {
      const scheduled = chores.filter((c) => c.childId === child.id && isScheduledOn(c.schedule, date));
      const count = Math.round(scheduled.length * fraction);
      for (const chore of scheduled.slice(0, count)) {
        completions.push({
          id: `done_seed_${chore.id}_${date}`,
          choreId: chore.id,
          childId: child.id,
          date,
          points: chore.points,
          completedAt: now.toISOString(),
        });
      }
    }
  }

  return {
    version: DATA_VERSION,
    settings: { familyName: 'The Rivera Family', parentPin: DEFAULT_PIN, mealReminderDismissedOn: null },
    children,
    chores,
    rewards: REWARDS.map((r) => ({ ...r })),
    completions,
    redemptions: [],
    meals: sampleMeals(
      today,
      children.map((c) => c.id),
    ),
    foodOptions: foodOptionsFromNames(
      [...SAMPLE_MENU.map((m) => m.main), ...EXTRA_MAINS],
      [...SAMPLE_MENU.map((m) => m.pudding), ...EXTRA_PUDDINGS],
    ),
  };
}
