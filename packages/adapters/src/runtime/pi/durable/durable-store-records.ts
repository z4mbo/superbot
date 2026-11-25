// How a durable harness's records map to the `durable_*` tables: records and indexed strings as
// JSON text, and a document's scope and address as columns. Follows the harness's own SQLite
// storage, so both stores refuse and accept the same commits.
import type {
  DocumentAddress,
  DocumentContent,
  DocumentCopySource,
  DocumentCreate,
  DocumentId,
  DocumentRecord,
  StorageWrite,
} from "@earendil-works/pi-durable";

export type RecordTable = "conversation" | "entry" | "task" | "submission" | "document";

/**
 * A stored record, as JSON text: lossless whatever its strings hold (lone surrogates and NUL are
 * escaped), which `jsonb` is not.
 */
export const encodeRecord = (value: unknown): string => JSON.stringify(value);

export const parseRecord = <T>(text: string): T => JSON.parse(text) as T;

/** An indexed string column, JSON-encoded like the records so any string compares exactly. */
export const encodeIndexed = (value: string): string => JSON.stringify(value);

export type ScopeColumns = { scopeKind: "session" | "conversation" | "task"; ownerId: number };

export function scopeColumns(scope: DocumentRecord["scope"]): ScopeColumns {
  switch (scope.kind) {
    case "session":
      return { scopeKind: "session", ownerId: 0 };
    case "conversation":
      return { scopeKind: "conversation", ownerId: scope.conversationId };
    case "task":
      return { scopeKind: "task", ownerId: scope.taskId };
  }
}

export type AddressColumns = ScopeColumns & { kind: string; family: boolean; keyValue: string };

/** A document address's columns, as `durable_documents` stores and indexes them. */
export function addressColumns(address: DocumentAddress): AddressColumns {
  return {
    kind: encodeIndexed(address.kind),
    ...scopeColumns(address.scope),
    family: address.key !== undefined,
    keyValue: encodeIndexed(address.key ?? ""),
  };
}

/** One string per document address. */
export const addressColumnsKey = (columns: AddressColumns): string =>
  JSON.stringify([
    columns.kind,
    columns.scopeKind,
    columns.ownerId,
    columns.family,
    columns.keyValue,
  ]);

export const addressKey = (address: DocumentAddress): string =>
  addressColumnsKey(addressColumns(address));

/** Whether a document keeps only its current state: its revisions go at each new base and retirement. */
export const isCurrentOnly = (record: DocumentRecord | DocumentCreate): boolean =>
  record.scope.kind !== "conversation" || record.history === "latest";

/** The record id a write claims and its table, if it claims one. */
export function claimOf(write: StorageWrite): { id: number; table: RecordTable } | undefined {
  switch (write.type) {
    case "conversation":
    case "entry":
    case "task":
    case "submission":
      return { id: write.value.id, table: write.type };
    case "document.create":
    case "document.copy":
      return { id: write.record.id, table: "document" };
    case "document.change":
    case "document.retire":
      return undefined;
  }
}

/** What one batch does to one document. */
export type DocumentAction = {
  create?: DocumentCreate;
  /** Set for a copy once its source is read. */
  content?: DocumentContent;
  copy?: DocumentCopySource;
  retire: boolean;
};

/** One batch's writes per document; throws when a document gets two content commands or two retirements. */
export function prepareDocumentActions(
  writes: readonly StorageWrite[],
): Map<DocumentId, DocumentAction> {
  const actions = new Map<DocumentId, DocumentAction>();
  for (const write of writes) {
    if (
      write.type !== "document.create" &&
      write.type !== "document.copy" &&
      write.type !== "document.change" &&
      write.type !== "document.retire"
    ) {
      continue;
    }
    const id =
      write.type === "document.create" || write.type === "document.copy"
        ? write.record.id
        : write.id;
    let action = actions.get(id);
    if (action === undefined) {
      action = { retire: false };
      actions.set(id, action);
    }
    const hasContent =
      action.create !== undefined || action.content !== undefined || action.copy !== undefined;
    switch (write.type) {
      case "document.create":
        if (hasContent) throw new Error(`Document ${id} has more than one content command`);
        action.create = write.record;
        action.content = write.content;
        break;
      case "document.copy":
        if (hasContent) throw new Error(`Document ${id} has more than one content command`);
        action.create = write.record;
        action.copy = write.source;
        break;
      case "document.change":
        if (action.content !== undefined || action.copy !== undefined) {
          throw new Error(`Document ${id} has more than one content command`);
        }
        action.content = write.content;
        break;
      case "document.retire":
        if (action.retire) throw new Error(`Document ${id} is retired more than once`);
        action.retire = true;
        break;
    }
  }
  return actions;
}
