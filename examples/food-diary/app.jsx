const MEALS = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snacks" };

function amount(value, unit) {
  return `${Math.round(value ?? 0)} ${unit}`;
}

function shift(date, days) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function Totals({ totals }) {
  return (
    <Metrics
      metrics={[
        { label: "Calories", value: amount(totals?.kcal, "kcal") },
        { label: "Protein", value: amount(totals?.protein, "g") },
        { label: "Carbs", value: amount(totals?.carbs, "g") },
        { label: "Fat", value: amount(totals?.fat, "g") },
      ]}
    />
  );
}

function entryDetail(entry) {
  const macros = [
    entry.protein !== undefined ? `P ${Math.round(entry.protein)} g` : null,
    entry.carbs !== undefined ? `C ${Math.round(entry.carbs)} g` : null,
    entry.fat !== undefined ? `F ${Math.round(entry.fat)} g` : null,
  ].filter(Boolean);
  return [`${Math.round(entry.grams)} g`, ...macros].join(" · ");
}

function Meals({ day, editable }) {
  const meals = day?.meals ?? [];
  if (!meals.length) return <Text>Nothing logged yet.</Text>;
  return meals.map((meal) => (
    <Section
      key={meal.meal}
      heading={MEALS[meal.meal] ?? meal.meal}
      actions={<Status>{amount(meal.totals?.kcal, "kcal")}</Status>}
    >
      <Rows
        rows={meal.entries.map((entry) => ({
          title: entry.food,
          detail: entryDetail(entry),
          meta: entry.kcal !== undefined ? amount(entry.kcal, "kcal") : "",
        }))}
      />
      {editable ? (
        <div className="rk-actions">
          {meal.entries.map((entry) => (
            <ActionButton
              key={entry.id}
              action="removeEntry"
              input={{ id: entry.id }}
              label={`Remove ${entry.food}`}
            />
          ))}
        </div>
      ) : null}
    </Section>
  ));
}

/** The card a bot shows in chat: one day's totals and what was eaten. */
function DayCard({ date }) {
  const day = useQuery("day", date ? { date } : {});
  return (
    <Page title="Food Diary" summary={day.data?.date ?? date ?? "Today"}>
      {day.error ? <Callout tone="warning">{day.error}</Callout> : null}
      <Totals totals={day.data?.totals} />
      <Meals day={day.data} editable={false} />
    </Page>
  );
}

export default function FoodDiary() {
  const card = useCard();
  const [picked, setPicked] = useState(null);
  const asked = picked ?? (typeof card.input.date === "string" ? card.input.date : null);
  const day = useQuery("day", asked ? { date: asked } : {});
  if (card.name === "day") return <DayCard date={asked} />;
  const date = day.data?.date ?? asked;
  return (
    <Page title="Food Diary" summary={date ?? "Today"}>
      <Section
        heading="Day"
        actions={
          date ? (
            <div className="rk-actions">
              <Button label="Previous day" onClick={() => setPicked(shift(date, -1))} />
              <Button label="Next day" onClick={() => setPicked(shift(date, 1))} />
            </div>
          ) : null
        }
      >
        {day.error ? <Callout tone="warning">{day.error}</Callout> : null}
        <Totals totals={day.data?.totals} />
      </Section>
      <Section heading="Add food">
        <ActionForm action="addEntry" label="Add" fixed={date ? { date } : {}} />
      </Section>
      <Meals day={day.data} editable />
    </Page>
  );
}
