import type { ConnectorTool } from "@rakazo/adapter-kit";
import type { RegistryAppPart } from "@rakazo/contracts";
import {
  RegistryAppDateSchema,
  RegistryAppNumberSchema,
  RegistryAppRecordsInputSchema,
  RegistryAppTextSchema,
} from "@rakazo/contracts";
import * as z from "zod";

const fieldSchemas = {
  text: RegistryAppTextSchema,
  number: RegistryAppNumberSchema,
  date: RegistryAppDateSchema,
};

export const LIST_APP_RECORDS = "list_records";
export const ADD_APP_RECORD = "add_record";

export function marketplaceAppTools(part: RegistryAppPart, pluginSlug: string): ConnectorTool[] {
  const app = `${pluginSlug} / ${part.id}`;
  const dateField = part.fields.find(({ type }) => type === "date");
  const { after, limit, date } = RegistryAppRecordsInputSchema.shape;
  const listSchema = z.strictObject({
    after: after.describe("The nextAfter cursor from the previous page."),
    limit,
    ...(dateField && { date: date.describe(`Match ${dateField.label} (YYYY-MM-DD).`) }),
  });
  return [
    {
      name: LIST_APP_RECORDS,
      description: `List records in ${app}, newest first.${part.summaryField ? ` The total sums ${part.summaryField} across all matching records.` : ""}`,
      inputSchema: z.toJSONSchema(listSchema, { io: "input" }),
      readOnly: true,
    },
    {
      name: ADD_APP_RECORD,
      description: `Add a record to ${app}.`,
      inputSchema: z.toJSONSchema(
        z.strictObject({
          values: z.strictObject(
            Object.fromEntries(
              part.fields.map(({ id, label, type, required }) => [
                id,
                (required ? fieldSchemas[type] : fieldSchemas[type].optional()).describe(label),
              ]),
            ),
          ),
        }),
        { io: "input" },
      ),
      readOnly: false,
    },
  ];
}
