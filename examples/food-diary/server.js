// Server functions. Each runs in Superbot's function sandbox with `(ctx, input)`: `ctx.db`
// reaches only this install's own records, and there is no file, timer or network access beyond
// the hosts app.json lists.

const MEALS = ["breakfast", "lunch", "dinner", "snack"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The most entries one day reads; far more than anyone logs. */
const DAY_MAX = 400;

function dayOf(ctx, given) {
  const date = given === undefined ? ctx.today : given;
  const parsed = DAY.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
    throw new Error(`"${date}" is not a day; write it as YYYY-MM-DD.`);
  return date;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function totalsOf(entries) {
  const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0, grams: 0 };
  for (const entry of entries)
    for (const key of Object.keys(totals)) totals[key] += entry[key] ?? 0;
  for (const key of Object.keys(totals)) totals[key] = round(totals[key]);
  return totals;
}

async function entriesOn(ctx, date) {
  const entries = ctx.db.collection("entries");
  const items = [];
  let cursor;
  do {
    const page = await entries.list({ where: { date }, order: "createdAt", limit: 200, cursor });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && items.length < DAY_MAX);
  return items;
}

function plain(entry) {
  const { id, date, meal, food, grams, kcal, protein, carbs, fat } = entry;
  return { id, date, meal, food, grams, kcal, protein, carbs, fat };
}

export async function day(ctx, input) {
  const date = dayOf(ctx, input.date);
  const entries = (await entriesOn(ctx, date)).map(plain);
  return {
    date,
    totals: totalsOf(entries),
    meals: MEALS.map((meal) => {
      const logged = entries.filter((entry) => entry.meal === meal);
      return { meal, totals: totalsOf(logged), entries: logged };
    }).filter((meal) => meal.entries.length > 0),
    count: entries.length,
  };
}

export async function addEntry(ctx, input) {
  const date = dayOf(ctx, input.date);
  const food = input.food.trim();
  if (!food) throw new Error("Say what the food is.");
  const entry = { date, meal: input.meal ?? "snack", food, grams: round(input.grams) };
  for (const key of ["protein", "carbs", "fat"])
    if (input[key] !== undefined) entry[key] = round(input[key]);
  if (input.kcal !== undefined) entry.kcal = round(input.kcal);
  else if (entry.protein !== undefined || entry.carbs !== undefined || entry.fat !== undefined)
    // Without calories, the macros still give them: 4 kcal a gram of protein or carbs, 9 of fat.
    entry.kcal = Math.round(
      4 * (entry.protein ?? 0) + 4 * (entry.carbs ?? 0) + 9 * (entry.fat ?? 0),
    );
  const saved = await ctx.db.collection("entries").insert(entry);
  return { entry: plain(saved), totals: totalsOf(await entriesOn(ctx, date)) };
}

export async function removeEntry(ctx, input) {
  return ctx.db.collection("entries").remove(input.id);
}
