// One `PostgresDurableStorage.commit()` call in a few statements whatever its number of batches:
// the check state of all its batches read up front (`CommitState`), each batch checked in memory
// against what the batches before it left, and the accepted batches written per table in one
// statement each (`PendingWrites`). The checks and their messages are the harness's SQLite
// storage's, so both refuse the same commits.
import type { DocumentId, DocumentRecord, Seq, StorageWrite } from "@earendil-works/pi-durable";
import type { Prisma } from "@rakazo/db";
import type { AddressColumns, DocumentAction, RecordTable } from "./durable-store-records.js";
import {
  addressColumns,
  addressColumnsKey,
  addressKey,
  claimOf,
  encodeIndexed,
  encodeRecord,
  isCurrentOnly,
  parseRecord,
} from "./durable-store-records.js";

/** The statements a store runs: inside its commit's transaction, or alone for a read. */
export type DurableSql = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;

/**
 * What the checks of one call's batches read: the stored state of every id, document and address
 * the batches touch, read when the call starts, then advanced in memory by each accepted batch.
 */
export class CommitState {
  /** The table of each claimed id; absent: unclaimed. */
  readonly #recordIds: Map<number, RecordTable>;
  /** Each touched document's record; absent: no such document. */
  readonly #documents: Map<number, DocumentRecord>;
  /** The version of each delta-changed document's latest revision; absent: no revision. */
  readonly #versions: Map<number, number>;
  /** The current incarnation of each created address (`addressKey`); `undefined`: none. */
  readonly #current: Map<string, number | undefined>;

  private constructor(
    recordIds: Map<number, RecordTable>,
    documents: Map<number, DocumentRecord>,
    versions: Map<number, number>,
    current: Map<string, number | undefined>,
  ) {
    this.#recordIds = recordIds;
    this.#documents = documents;
    this.#versions = versions;
    this.#current = current;
  }

  /** Reads the stored state the checks of `batches` need: one statement per kind of state. */
  static async read(
    sql: DurableSql,
    storeId: string,
    batches: readonly (readonly StorageWrite[])[],
  ): Promise<CommitState> {
    const ids = new Set<number>();
    const documentIds = new Set<number>();
    const deltaIds = new Set<number>();
    const addresses = new Map<string, AddressColumns>();
    for (const writes of batches) {
      for (const write of writes) {
        const claim = claimOf(write);
        if (claim !== undefined) ids.add(claim.id);
        switch (write.type) {
          case "document.create":
          case "document.copy":
            documentIds.add(write.record.id);
            addresses.set(addressKey(write.record), addressColumns(write.record));
            break;
          case "document.change":
            documentIds.add(write.id);
            if (write.content.kind === "delta") deltaIds.add(write.id);
            break;
          case "document.retire":
            documentIds.add(write.id);
            break;
          default:
            break;
        }
      }
    }
    const recordIds = new Map<number, RecordTable>();
    if (ids.size > 0) {
      const rows = await sql.$queryRawUnsafe<Array<{ id: bigint; recordType: RecordTable }>>(
        `SELECT "id", "recordType" FROM "durable_record_ids"
          WHERE "storeId" = $1::text AND "id" = ANY($2::bigint[])`,
        storeId,
        [...ids],
      );
      for (const row of rows) recordIds.set(Number(row.id), row.recordType);
    }
    const documents = new Map<number, DocumentRecord>();
    if (documentIds.size > 0) {
      const rows = await sql.$queryRawUnsafe<Array<{ record: string }>>(
        `SELECT "record" FROM "durable_documents"
          WHERE "storeId" = $1::text AND "id" = ANY($2::bigint[])`,
        storeId,
        [...documentIds],
      );
      for (const row of rows) {
        const record = parseRecord<DocumentRecord>(row.record);
        documents.set(record.id, record);
      }
    }
    const versions = new Map<number, number>();
    if (deltaIds.size > 0) {
      // Each document's latest revision: one descending probe of the primary key.
      const rows = await sql.$queryRawUnsafe<Array<{ documentId: bigint; version: number }>>(
        `SELECT DISTINCT ON ("documentId") "documentId", "version" FROM "durable_document_revisions"
          WHERE "storeId" = $1::text AND "documentId" = ANY($2::bigint[])
          ORDER BY "documentId", "seq" DESC`,
        storeId,
        [...deltaIds],
      );
      for (const row of rows) versions.set(Number(row.documentId), row.version);
    }
    return new CommitState(
      recordIds,
      documents,
      versions,
      await readCurrent(sql, storeId, addresses),
    );
  }

  /** The harness's own checks of one batch that need no copy source: throws the refusal. */
  check(writes: readonly StorageWrite[], actions: Map<DocumentId, DocumentAction>): void {
    this.#checkIds(writes);
    this.#checkDocuments(actions);
  }

  /** Advances the state past an accepted batch stored at `seq`, its copies resolved to their content. */
  apply(writes: readonly StorageWrite[], actions: Map<DocumentId, DocumentAction>, seq: Seq): void {
    for (const write of writes) {
      // An accepted batch claims an id only for its stored table, if it has one (`#checkIds`).
      const claim = claimOf(write);
      if (claim !== undefined) this.#recordIds.set(claim.id, claim.table);
    }
    for (const [id, action] of actions) {
      if (action.create !== undefined) {
        const record = {
          ...action.create,
          createdAt: seq,
          ...(action.retire ? { retiredAt: seq } : {}),
        } as DocumentRecord;
        this.#documents.set(id, record);
        if (!action.retire) this.#current.set(addressKey(record), id);
      } else if (action.retire) {
        const record = { ...this.#documents.get(id)!, retiredAt: seq } as DocumentRecord;
        this.#documents.set(id, record);
        // The batch may have created the address's next incarnation already: only this one leaves.
        const key = addressKey(record);
        if (this.#current.get(key) === id) this.#current.set(key, undefined);
      }
      // A retired document's versions are never read again: every later action on it is refused first.
      if (action.content !== undefined) this.#versions.set(id, action.content.version);
    }
  }

  /** A document's record as the accepted batches left it. */
  document(id: number): DocumentRecord | undefined {
    return this.#documents.get(id);
  }

  #checkIds(writes: readonly StorageWrite[]): void {
    const claimed = new Map<number, RecordTable>();
    for (const write of writes) {
      const claim = claimOf(write);
      if (claim === undefined) continue;
      const { id, table } = claim;
      const existing = this.#recordIds.get(id);
      const earlier = claimed.get(id);
      if (table === "conversation" || table === "entry" || table === "document") {
        if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
        if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
      } else {
        if (existing !== undefined && existing !== table) {
          throw new Error(`ID ${id} already belongs to ${existing}`);
        }
        if (earlier !== undefined && earlier !== table) {
          throw new Error(`ID ${id} is written as two record types`);
        }
      }
      claimed.set(id, table);
    }
  }

  #checkDocuments(actions: Map<DocumentId, DocumentAction>): void {
    const liveCounts = new Map<string, number>();
    for (const [id, action] of actions) {
      if (action.copy !== undefined && actions.has(action.copy.id)) {
        throw new Error(`Document copy ${id} source is changed in the copy batch`);
      }
      const existing = this.#documents.get(id);
      if (action.create === undefined && existing === undefined) {
        throw new Error(`Unknown document: ${id}`);
      }
      if (action.create !== undefined && existing !== undefined) {
        throw new Error(`Document ${id} already exists`);
      }
      if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
      if (action.content?.kind === "delta") {
        const previous = this.#versions.get(id);
        if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
        if (previous !== action.content.version) {
          throw new Error(`Document ${id} version transition requires a base`);
        }
      }
      // A plain change keeps its address's live count: only creations and retirements count.
      if (action.create === undefined && !action.retire) continue;
      const key = addressKey((action.create ?? existing)!);
      let live = liveCounts.get(key);
      // Only created addresses were read: an address no batch creates only loses incarnations.
      if (live === undefined) live = this.#current.get(key) === undefined ? 0 : 1;
      if (action.retire && existing !== undefined) live--;
      if (action.create !== undefined && !action.retire) live++;
      liveCounts.set(key, live);
    }
    for (const live of liveCounts.values()) {
      if (live > 1) throw new Error("Document address already has a current incarnation");
    }
  }
}

/** The current incarnation of each of `addresses`, `undefined` for one without. */
async function readCurrent(
  sql: DurableSql,
  storeId: string,
  addresses: Map<string, AddressColumns>,
): Promise<Map<string, number | undefined>> {
  const current = new Map<string, number | undefined>();
  for (const key of addresses.keys()) current.set(key, undefined);
  if (addresses.size === 0) return current;
  const parts = [...addresses.values()];
  const rows = await sql.$queryRawUnsafe<
    Array<{
      id: bigint;
      kind: string;
      scopeKind: AddressColumns["scopeKind"];
      ownerId: bigint;
      family: boolean;
      keyValue: string;
    }>
  >(
    `SELECT d."id", d."kind", d."scopeKind", d."ownerId", d."family", d."keyValue"
      FROM unnest($2::text[], $3::text[], $4::bigint[], $5::boolean[], $6::text[])
        AS a("kind", "scopeKind", "ownerId", "family", "keyValue")
      JOIN "durable_documents" d ON d."storeId" = $1::text AND d."kind" = a."kind"
        AND d."scopeKind" = a."scopeKind" AND d."ownerId" = a."ownerId"
        AND d."family" = a."family" AND d."keyValue" = a."keyValue"
      WHERE d."retiredSeq" IS NULL`,
    storeId,
    parts.map((part) => part.kind),
    parts.map((part) => part.scopeKind),
    parts.map((part) => part.ownerId),
    parts.map((part) => part.family),
    parts.map((part) => part.keyValue),
  );
  for (const row of rows) {
    const key = addressColumnsKey({
      kind: row.kind,
      scopeKind: row.scopeKind,
      ownerId: Number(row.ownerId),
      family: row.family,
      keyValue: row.keyValue,
    });
    current.set(key, Number(row.id));
  }
  return current;
}

type Cell = string | number | boolean | null;

/**
 * The writes of the accepted batches not yet written, per table, as their net effect: a task or
 * submission written twice is written once, as last written; a current-only document's revisions
 * before its latest base or retirement are dropped (and its stored ones deleted).
 */
export class PendingWrites {
  readonly #recordIds = new Map<number, RecordTable>();
  readonly #conversations: Cell[][] = [];
  readonly #entries: Cell[][] = [];
  readonly #tasks = new Map<number, Cell[]>();
  readonly #submissions = new Map<number, Cell[]>();
  /** Each created or retired document's record. */
  readonly #documents = new Map<number, DocumentRecord>();
  /** The documents whose stored revisions go. */
  readonly #cleared = new Set<number>();
  /** Each document's new revisions, in seq order. */
  readonly #revisions = new Map<number, Cell[][]>();

  /** Adds a batch stored at `seq`, after `state` applied it. */
  add(
    writes: readonly StorageWrite[],
    actions: Map<DocumentId, DocumentAction>,
    seq: Seq,
    state: CommitState,
  ): void {
    for (const write of writes) this.#addWrite(write, seq);
    for (const [id, action] of actions) this.#addDocument(id, action, seq, state.document(id)!);
  }

  #addWrite(write: StorageWrite, seq: Seq): void {
    const claim = claimOf(write);
    if (claim !== undefined) this.#recordIds.set(claim.id, claim.table);
    switch (write.type) {
      case "conversation":
        this.#conversations.push([
          write.value.id,
          write.value.owner?.conversationId ?? null,
          write.value.owner?.taskId ?? null,
          encodeRecord(write.value),
        ]);
        break;
      case "entry":
        this.#entries.push([
          write.value.id,
          write.value.conversationId,
          write.value.head ?? null,
          seq,
          encodeRecord(write.value),
        ]);
        break;
      case "task":
        this.#tasks.set(write.value.id, [
          write.value.id,
          write.value.conversationId,
          encodeIndexed(write.value.kind),
          write.value.state.status,
          write.value.abortRequested,
          write.value.background,
          encodeRecord(write.value),
        ]);
        break;
      case "submission":
        this.#submissions.set(write.value.id, [
          write.value.id,
          write.value.conversationId,
          write.value.requestId === undefined ? null : encodeIndexed(write.value.requestId),
          write.value.status,
          encodeRecord(write.value),
        ]);
        break;
      default:
        break;
    }
  }

  #addDocument(id: number, action: DocumentAction, seq: Seq, record: DocumentRecord): void {
    if (action.create !== undefined || action.retire) this.#documents.set(id, record);
    const content = action.content;
    if (content !== undefined) {
      if (content.kind === "base" && isCurrentOnly(record)) this.#clear(id);
      const encoded = encodeRecord(content.kind === "base" ? content.value : content.ops);
      let revisions = this.#revisions.get(id);
      if (revisions === undefined) {
        revisions = [];
        this.#revisions.set(id, revisions);
      }
      revisions.push([id, seq, content.kind, content.version, encoded]);
    }
    if (action.retire && isCurrentOnly(record)) this.#clear(id);
  }

  /** Drops a document's revisions: the pending ones, and the stored ones when written. */
  #clear(id: number): void {
    this.#cleared.add(id);
    this.#revisions.delete(id);
  }

  /** Writes everything pending, one statement per table, and forgets it. */
  async flush(sql: DurableSql, storeId: string): Promise<void> {
    await insertRows(
      sql,
      storeId,
      "durable_record_ids",
      [
        ["id", "bigint"],
        ["recordType", "text"],
      ],
      [...this.#recordIds].map(([id, table]) => [id, table]),
      `ON CONFLICT ("storeId", "id") DO NOTHING`,
    );
    await insertRows(
      sql,
      storeId,
      "durable_conversations",
      [
        ["id", "bigint"],
        ["ownerConversationId", "bigint"],
        ["ownerTaskId", "bigint"],
        ["record", "text"],
      ],
      this.#conversations,
    );
    await insertRows(
      sql,
      storeId,
      "durable_entries",
      [
        ["id", "bigint"],
        ["conversationId", "bigint"],
        ["head", "bigint"],
        ["commitSeq", "bigint"],
        ["record", "text"],
      ],
      this.#entries,
    );
    await insertRows(
      sql,
      storeId,
      "durable_tasks",
      [
        ["id", "bigint"],
        ["conversationId", "bigint"],
        ["kind", "text"],
        ["status", "text"],
        ["abortRequested", "boolean"],
        ["background", "boolean"],
        ["record", "text"],
      ],
      [...this.#tasks.values()],
      `ON CONFLICT ("storeId", "id") DO UPDATE SET "conversationId" = EXCLUDED."conversationId",
        "kind" = EXCLUDED."kind", "status" = EXCLUDED."status",
        "abortRequested" = EXCLUDED."abortRequested", "background" = EXCLUDED."background",
        "record" = EXCLUDED."record"`,
    );
    await insertRows(
      sql,
      storeId,
      "durable_submissions",
      [
        ["id", "bigint"],
        ["conversationId", "bigint"],
        ["requestId", "text"],
        ["status", "text"],
        ["record", "text"],
      ],
      [...this.#submissions.values()],
      `ON CONFLICT ("storeId", "id") DO UPDATE SET "conversationId" = EXCLUDED."conversationId",
        "requestId" = EXCLUDED."requestId", "status" = EXCLUDED."status",
        "record" = EXCLUDED."record"`,
    );
    // A created document is inserted, a stored one retired: one upsert writes both.
    await insertRows(
      sql,
      storeId,
      "durable_documents",
      [
        ["id", "bigint"],
        ["kind", "text"],
        ["family", "boolean"],
        ["keyValue", "text"],
        ["scopeKind", "text"],
        ["ownerId", "bigint"],
        ["createdSeq", "bigint"],
        ["retiredSeq", "bigint"],
        ["record", "text"],
      ],
      [...this.#documents.values()].map(documentRow),
      `ON CONFLICT ("storeId", "id") DO UPDATE SET "retiredSeq" = EXCLUDED."retiredSeq",
        "record" = EXCLUDED."record"`,
    );
    if (this.#cleared.size > 0) {
      await sql.$executeRawUnsafe(
        `DELETE FROM "durable_document_revisions"
          WHERE "storeId" = $1::text AND "documentId" = ANY($2::bigint[])`,
        storeId,
        [...this.#cleared],
      );
    }
    await insertRows(
      sql,
      storeId,
      "durable_document_revisions",
      [
        ["documentId", "bigint"],
        ["seq", "bigint"],
        ["kind", "text"],
        ["version", "integer"],
        ["content", "text"],
      ],
      [...this.#revisions.values()].flat(),
    );
    this.#recordIds.clear();
    this.#conversations.length = 0;
    this.#entries.length = 0;
    this.#tasks.clear();
    this.#submissions.clear();
    this.#documents.clear();
    this.#cleared.clear();
    this.#revisions.clear();
  }
}

/** A document record's row: id, kind, family, key, scope, owner, created and retired seqs, record. */
function documentRow(record: DocumentRecord): Cell[] {
  const columns = addressColumns(record);
  return [
    record.id,
    columns.kind,
    columns.family,
    columns.keyValue,
    columns.scopeKind,
    columns.ownerId,
    record.createdAt,
    record.retiredAt ?? null,
    encodeRecord(record),
  ];
}

/**
 * Inserts `rows` (one cell per column, in order) into `table` for the store, then `conflict`:
 * one statement whatever their number, each column bound as one array.
 */
async function insertRows(
  sql: DurableSql,
  storeId: string,
  table: string,
  columns: ReadonlyArray<readonly [name: string, type: string]>,
  rows: readonly Cell[][],
  conflict = "",
): Promise<void> {
  if (rows.length === 0) return;
  const names = columns.map(([name]) => `"${name}"`).join(", ");
  const arrays = columns.map(([, type], index) => `$${index + 2}::${type}[]`).join(", ");
  await sql.$executeRawUnsafe(
    `INSERT INTO "${table}" ("storeId", ${names})
      SELECT $1::text, * FROM unnest(${arrays}) ${conflict}`,
    storeId,
    ...columns.map((_, index) => rows.map((row) => row[index] ?? null)),
  );
}
