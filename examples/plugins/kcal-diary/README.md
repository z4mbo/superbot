# Calorie diary record app

A plugin with one app part: a form for meals with a date, a description and
calories. Superbot keeps each installation's records and totals the calories
for the day you pick. Nothing runs on your side; the manifest is the whole
plugin.

Start your own copy with the plugin toolkit, then check it before you submit:

```sh
superbot-plugin init my-diary --template kcal-diary
superbot-plugin validate
```

Uninstalling the plugin deletes every record saved in it. Records belong to the
version they were saved in, so switching to another version shows that
version's records instead.
