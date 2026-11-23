WITH reserved AS (
    INSERT INTO "registry_plugins" ("slug")
    VALUES ('kcal-diary')
    ON CONFLICT ("slug") DO NOTHING
    RETURNING "slug"
)
INSERT INTO "registry_plugin_versions"
    ("id", "slug", "version", "manifest", "status", "reviewedAt")
SELECT 'superbot-kcal-diary-v1', "slug", 1, '{
    "schemaVersion": 1,
    "name": "Calorie diary",
    "description": "Log meals and see the total calories for a day.",
    "parts": [{
        "id": "meals",
        "kind": "app",
        "fields": [
            {"id": "date", "label": "Date", "type": "date", "required": true},
            {"id": "meal", "label": "Meal", "type": "text", "required": true},
            {"id": "kcal", "label": "Calories (kcal)", "type": "number", "required": true}
        ],
        "summaryField": "kcal"
    }]
}'::jsonb, 'approved', CURRENT_TIMESTAMP
FROM reserved;
