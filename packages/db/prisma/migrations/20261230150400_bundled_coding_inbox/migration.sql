WITH reserved AS (
    INSERT INTO "registry_plugins" ("slug")
    VALUES ('t3-code-inbox')
    ON CONFLICT ("slug") DO NOTHING
    RETURNING "slug"
)
INSERT INTO "registry_plugin_versions"
    ("id", "slug", "version", "manifest", "status", "reviewedAt")
SELECT 'superbot-t3-code-inbox-v1', "slug", 1, $manifest$
{
  "schemaVersion": 1,
  "name": "T3 Code inbox",
  "description": "Propose coding work for an operator to review and start in T3 Code.",
  "parts": [
    {
      "id": "requests",
      "kind": "app",
      "fields": [
        {
          "id": "title",
          "label": "Title",
          "type": "text",
          "required": true
        },
        {
          "id": "brief",
          "label": "Coding brief",
          "type": "text",
          "required": true
        }
      ]
    },
    {
      "id": "dispatches",
      "kind": "app",
      "fields": [
        {
          "id": "request-id",
          "label": "Request ID",
          "type": "text",
          "required": true
        },
        {
          "id": "thread-id",
          "label": "T3 thread ID",
          "type": "text",
          "required": true
        },
        {
          "id": "run-id",
          "label": "T3 run ID",
          "type": "text",
          "required": true
        },
        {
          "id": "thread-link",
          "label": "T3 thread link",
          "type": "text",
          "required": true
        },
        {
          "id": "status",
          "label": "Status at dispatch",
          "type": "text",
          "required": true
        }
      ]
    },
    {
      "id": "request-guide",
      "kind": "skill",
      "instructions": "When asked to propose coding work, add a record to the T3 Code inbox Requests app. Give it a short title and a self-contained brief with the requested outcome and how to verify it. Do not include credentials. Return the request ID. A request is a proposal. Only the operator can select a T3 project and dispatch the request."
    }
  ]
}
$manifest$::jsonb, 'approved', CURRENT_TIMESTAMP
FROM reserved;
