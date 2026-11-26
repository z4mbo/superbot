# Food Diary

Superbot's first-party example of an app with hosted data: a food log kept by the server for each
install, with server functions a person and a bot both use, and a card a bot shows in chat. See
[Build an app](../../docs/plugin-sdk.md).

- `day {date?}` (read-only): one day's entries by meal and the day's totals. `date` is
  `YYYY-MM-DD`; today in the person's time zone when left out.
- `addEntry {food, grams, meal?, date?, kcal?, protein?, carbs?, fat?}`: logs one food. `meal` is
  `breakfast`, `lunch`, `dinner` or `snack` (the default). Without `kcal`, calories come from the
  macros given.
- `removeEntry {id}`: removes one entry.
- Card `day {date?}`: the day's totals and entries.

```sh
pnpm app:check examples/food-diary
```

Superbot lists this folder in the Store's Apps section as a first-party app, so changing a file
here means raising `version`. Its tests live with the API's first-party apps
(`apps/api/src/app-store/first-party-apps.test.ts`).
