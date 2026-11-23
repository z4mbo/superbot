import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  AddRegistryAppRecordInputSchema,
  RegistryAppPartSchema,
  RegistryAppRecordSchema,
  RegistryAppRecordsInputSchema,
} from "./plugin-registry.js";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const pin = RegistryAppRecordsInputSchema.pick({ installationId: true, partId: true }).extend({
  versionId: id,
  grantId: id,
});
const app = z.strictObject({
  pin,
  pluginName: z.string().max(120),
  part: RegistryAppPartSchema,
});
const contextInput = z.strictObject({ botId: id, app: pin });

export const LOCAL_APP_PAGE_SIZE = 20;
export const LOCAL_APP_RECORD_LIMIT = 5;

export const localAppRecordsRpc = {
  localAppRecords: {
    list: oc
      .input(z.strictObject({ botId: id, after: id.optional() }))
      .output(
        z.strictObject({ items: z.array(app).max(LOCAL_APP_PAGE_SIZE), nextAfter: id.nullable() }),
      ),
    context: oc
      .input(contextInput.extend(RegistryAppRecordsInputSchema.pick({ date: true }).shape))
      .output(
        z.strictObject({
          app,
          items: z.array(RegistryAppRecordSchema).max(LOCAL_APP_RECORD_LIMIT),
          total: z.number().nullable(),
          hasMore: z.boolean(),
        }),
      ),
    add: oc
      .input(
        contextInput.extend(
          AddRegistryAppRecordInputSchema.pick({ operationId: true, values: true }).shape,
        ),
      )
      .output(RegistryAppRecordSchema),
  },
};
