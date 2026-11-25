// A durable harness's `Storage` in Postgres, shared by every API and worker process. The harness
// assumes one writer per store, so every commit first checks the writer's fence (its lease) in
// the same transaction: a process that lost its lease fails its commits instead of writing over
// the new holder. Nothing loads this module until a durable runtime is configured.
import type { Context } from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import { apply } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/chord/json";
import type {
  CommitResult,
  ConversationId,
  ConversationQuery,
  ConversationRecord,
  Cursor,
  DocumentAddress,
  DocumentId,
  DocumentPoint,
  DocumentQuery,
  DocumentRecord,
  EntryId,
  EntryQuery,
  EntryRecord,
  Id,
  JsonObject,
  Page,
  ScanOrder,
  Seq,
  Storage,
  StorageWrite,
  StoredDocument,
  SubmissionId,
  SubmissionQuery,
  SubmissionRecord,
  TaskId,
  TaskQuery,
  TaskRecord,
} from "@earendil-works/pi-durable";
import { StorageRequestError } from "@earendil-works/pi-durable";
import type { HeldLease, Prisma, PrismaClient } from "@rakazo/db";
import { assertLeaseHeld, withTransactionRetry } from "@rakazo/db";
import type { DurableSql } from "./durable-store-commit.js";
import { CommitState, PendingWrites } from "./durable-store-commit.js";
import type { DocumentAction } from "./durable-store-records.js";
import {
  addressColumns,
  claimOf,
  encodeIndexed,
  isCurrentOnly,
  parseRecord,
  prepareDocumentActions,
  scopeColumns,
} from "./durable-store-records.js";

/**
 * The record format this release writes. Raise it in the release that upgrades the harness to a
 * version that stores records differently: a store opened by it is then refused by older
 * releases, as the harness's own SQLite storage refuses a newer file, instead of being misread.
 */
export const DURABLE_STORE_FORMAT_VERSION = 1;

/**
 * Throws, in a commit's transaction, unless the committing process still holds the store. It may
 * lock what it checks until the transaction ends, so no new holder starts before the commit lands.
 */
export type DurableStoreFence = (tx: Prisma.TransactionClient) => Promise<void>;

/** The fence of a `withLease` lease: commits land only while the lease is held. */
export const leaseFence =
  (lease: Pick<HeldLease, "key" | "fence">): DurableStoreFence =>
  (tx) =>
    assertLeaseHeld(tx, lease);

export type DurableStoreOptions = {
  /** Names the store: the same id reopens it. */
  storeId: string;
  /** The Space whose content it holds; it is deleted with the Space. */
  spaceId: string;
  fence: DurableStoreFence;
};

export class DurableStoreFormatError extends Error {
  override readonly name = "DurableStoreFormatError";
}

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type StoredEntry = { readonly entry: EntryRecord; readonly commitSeq: Seq };
type Row = { record: string };

const asId = <I extends Id<string>>(value: number | bigint): I => Number(value) as I;
const asSeq = (value: number | bigint): Seq => Number(value) as Seq;

// A commit holds the store's row and its fence until it lands; it writes a few statements.
const COMMIT_TRANSACTION = { timeout: 30_000 };

export class PostgresDurableStorage implements Storage {
  readonly #prisma: PrismaClient;
  readonly #storeId: string;
  readonly #fence: DurableStoreFence;
  #nextId: number;
  #closed = false;
  #closing: Promise<void> | undefined;
  #running = 0;
  #drained: (() => void) | undefined;

  private constructor(
    prisma: PrismaClient,
    storeId: string,
    fence: DurableStoreFence,
    nextId: number,
  ) {
    this.#prisma = prisma;
    this.#storeId = storeId;
    this.#fence = fence;
    this.#nextId = nextId;
  }

  /**
   * Opens the store, creating it in the Space the first time. Refuses one another Space owns, and
   * one a newer release wrote (`DurableStoreFormatError`).
   */
  static async open(
    prisma: PrismaClient,
    options: DurableStoreOptions,
  ): Promise<PostgresDurableStorage> {
    const { storeId, spaceId } = options;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "durable_stores" ("id", "spaceId", "formatVersion")
        VALUES ($1::text, $2::text, $3::integer) ON CONFLICT ("id") DO NOTHING`,
      storeId,
      spaceId,
      DURABLE_STORE_FORMAT_VERSION,
    );
    const [store] = await prisma.$queryRawUnsafe<
      Array<{ spaceId: string; formatVersion: number; nextId: bigint }>
    >(
      `SELECT "spaceId", "formatVersion", "nextId" FROM "durable_stores" WHERE "id" = $1::text`,
      storeId,
    );
    if (store === undefined || store.spaceId !== spaceId) {
      throw new Error(`Durable store ${storeId} belongs to another Space`);
    }
    if (store.formatVersion > DURABLE_STORE_FORMAT_VERSION) {
      throw new DurableStoreFormatError(
        `Durable store format ${store.formatVersion} is newer than supported version ${DURABLE_STORE_FORMAT_VERSION}`,
      );
    }
    return new PostgresDurableStorage(prisma, storeId, options.fence, Number(store.nextId));
  }

  /**
   * Commits `batches` in one transaction, each with its own seq, after the fence. Each batch is
   * checked before it writes anything, against what the earlier ones left, and the first refused
   * ends the call: the batches before it commit. The store's row is locked first, so commits to
   * one store never interleave even if two processes passed their fences.
   */
  commit(
    batches: readonly (readonly StorageWrite[])[],
    receive: (index: number, seq: Seq) => void,
    _context?: Context,
  ): Promise<CommitResult> {
    return this.#admit(async () => {
      const outcome = await withTransactionRetry(() =>
        this.#prisma.$transaction((tx) => this.#commitIn(tx, batches), COMMIT_TRANSACTION),
      );
      this.#nextId = Math.max(this.#nextId, outcome.nextId);
      // The transaction committed: the stored batches are durable.
      for (const [index, seq] of outcome.seqs.entries()) receive(index, seq);
      return outcome.refused === undefined
        ? { stored: outcome.seqs.length }
        : { stored: outcome.seqs.length, refused: outcome.refused.error };
    });
  }

  async #commitIn(tx: Prisma.TransactionClient, batches: readonly (readonly StorageWrite[])[]) {
    await this.#fence(tx);
    const [store] = await tx.$queryRawUnsafe<Array<{ nextId: bigint; nextSeq: bigint }>>(
      `SELECT "nextId", "nextSeq" FROM "durable_stores" WHERE "id" = $1::text FOR UPDATE`,
      this.#storeId,
    );
    if (store === undefined) throw new Error(`Durable store ${this.#storeId} is missing`);
    let next = Number(store.nextSeq);
    let nextId = Math.max(Number(store.nextId), this.#nextId);
    const seqs: Seq[] = [];
    let refused: { error: unknown } | undefined;
    // A failure of the database rejects the call and rolls back every batch with the transaction.
    const state = await CommitState.read(tx, this.#storeId, batches);
    const pending = new PendingWrites();
    for (const writes of batches) {
      const checked = await this.#checkBatch(tx, state, pending, writes);
      if ("refused" in checked) {
        refused = { error: checked.refused };
        break;
      }
      const seq = asSeq(next++);
      state.apply(writes, checked.actions, seq);
      pending.add(writes, checked.actions, seq, state);
      seqs.push(seq);
      for (const write of writes) {
        const id = claimOf(write)?.id;
        if (id !== undefined) nextId = Math.max(nextId, id + 1);
      }
    }
    await pending.flush(tx, this.#storeId);
    if (seqs.length > 0) {
      await tx.$executeRawUnsafe(
        `UPDATE "durable_stores" SET "nextId" = $2::bigint, "nextSeq" = $3::bigint
          WHERE "id" = $1::text`,
        this.#storeId,
        nextId,
        next,
      );
    }
    return { seqs, refused, nextId };
  }

  /**
   * The harness's own checks of one batch, against what the batches before it left: its document
   * actions, or its refusal. Only these refuse; a failed statement rejects. A copy reads its
   * source from the database, so the batches before it are written first.
   */
  async #checkBatch(
    tx: Prisma.TransactionClient,
    state: CommitState,
    pending: PendingWrites,
    writes: readonly StorageWrite[],
  ): Promise<{ actions: Map<DocumentId, DocumentAction> } | { refused: unknown }> {
    let actions: Map<DocumentId, DocumentAction>;
    try {
      actions = prepareDocumentActions(writes);
      state.check(writes, actions);
    } catch (error) {
      return { refused: error };
    }
    if (![...actions.values()].some((action) => action.copy !== undefined)) return { actions };
    await pending.flush(tx, this.#storeId);
    const failed = { statement: false };
    const watched = watchStatements(tx, failed);
    for (const [id, action] of actions) {
      if (action.copy === undefined) continue;
      try {
        action.content = await this.#copyContent(watched, action);
      } catch (error) {
        // A failed statement rejects the call; anything else about the source refuses the batch.
        if (failed.statement) throw error;
        return { refused: new Error(`Document copy ${id} was rejected`, { cause: error }) };
      }
    }
    return { actions };
  }

  /** A copy's content: a base of its source's state before this batch, which may not change it. */
  async #copyContent(sql: DurableSql, action: DocumentAction) {
    const { id, at } = action.copy!;
    const stored = await this.#materialize(sql, id, at);
    if (stored === undefined) throw new Error(`Fork source document ${id} cannot be read`);
    const create = action.create!;
    const record = stored.record;
    if (
      record.scope.kind !== "conversation" ||
      create.scope.kind !== "conversation" ||
      record.kind !== create.kind ||
      record.key !== create.key ||
      record.history !== create.history ||
      record.fork !== create.fork
    ) {
      throw new Error(`Fork source document ${id} does not match the copied record`);
    }
    return { kind: "base", version: stored.version, value: stored.value } as const;
  }

  async mintId<I extends Id<string>>(): Promise<I> {
    this.#assertOpen();
    if (!Number.isSafeInteger(this.#nextId)) throw new Error("ID space is exhausted");
    return asId<I>(this.#nextId++);
  }

  conversation(id: ConversationId, _context?: Context): Promise<ConversationRecord | undefined> {
    return this.#admit(() => this.#readConversation(id));
  }

  scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context?: Context,
  ): Promise<Page<ConversationRecord, Cursor>> {
    return this.#admit(async () => {
      const start = scanStart(query.order, cursor, "ascending");
      const filters: Filter[] = [];
      if (query.ownerConversationId !== undefined) {
        filters.push(['"ownerConversationId"', "bigint", query.ownerConversationId]);
      }
      if (query.ownerTaskId !== undefined) {
        filters.push(['"ownerTaskId"', "bigint", query.ownerTaskId]);
      }
      return this.#scanTable<ConversationRecord>("durable_conversations", filters, start, limit);
    });
  }

  entry(id: EntryId, context?: Context): Promise<StoredEntry | undefined>;
  entry(
    conversationId: ConversationId,
    id: EntryId,
    context?: Context,
  ): Promise<StoredEntry | undefined>;
  entry(first: number, second?: unknown): Promise<StoredEntry | undefined> {
    return this.#admit(() => this.#readEntry(first, second));
  }

  findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
    _context?: Context,
  ): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    return this.#admit(async () => {
      let conversation = await this.#requireConversation(conversationId);
      let upper: number | undefined = atOrBeforeEntryId;
      for (;;) {
        const [row] = await this.#prisma.$queryRawUnsafe<Row[]>(
          `SELECT "record" FROM "durable_entries"
            WHERE "storeId" = $1::text AND "conversationId" = $2::bigint AND "head" IS NOT NULL
              AND ($3::bigint IS NULL OR "id" <= $3::bigint)
            ORDER BY "id" DESC LIMIT 1`,
          this.#storeId,
          conversation.id,
          upper ?? null,
        );
        if (row !== undefined) {
          return parseRecord<EntryRecord & { readonly head: EntryId }>(row.record);
        }
        if (conversation.parent === undefined) return undefined;
        upper =
          upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
        conversation = await this.#requireConversation(conversation.parent.conversationId);
      }
    });
  }

  scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context?: Context,
  ): Promise<Page<EntryRecord, Cursor>> {
    return this.#admit(() => {
      const { order, after } = scanStart(query.order, cursor, "descending");
      return order === "ascending"
        ? this.#readEntriesAscending(query, limit, after)
        : this.#readEntriesDescending(query, limit, after);
    });
  }

  task(id: TaskId, _context?: Context): Promise<StoredTask | undefined> {
    return this.#admit(() => this.#readRecord<StoredTask>("durable_tasks", id));
  }

  scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context?: Context,
  ): Promise<Page<StoredTask, Cursor>> {
    return this.#admit(async () => {
      const start = scanStart(query.order, cursor, "ascending");
      const filters: Filter[] = [];
      if (query.conversationId !== undefined) {
        filters.push(['"conversationId"', "bigint", query.conversationId]);
      }
      if (query.kind !== undefined) filters.push(['"kind"', "text", encodeIndexed(query.kind)]);
      if (query.status !== undefined) filters.push(['"status"', "text", query.status]);
      if (query.abortRequested !== undefined) {
        filters.push(['"abortRequested"', "boolean", query.abortRequested]);
      }
      if (query.background !== undefined) {
        filters.push(['"background"', "boolean", query.background]);
      }
      return this.#scanTable<StoredTask>("durable_tasks", filters, start, limit);
    });
  }

  submission(id: SubmissionId, _context?: Context): Promise<SubmissionRecord | undefined> {
    return this.#admit(() => this.#readRecord<SubmissionRecord>("durable_submissions", id));
  }

  scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context?: Context,
  ): Promise<Page<SubmissionRecord, Cursor>> {
    return this.#admit(async () => {
      const start = scanStart(query.order, cursor, "ascending");
      const filters: Filter[] = [];
      if (query.conversationId !== undefined) {
        filters.push(['"conversationId"', "bigint", query.conversationId]);
      }
      if (query.status !== undefined) filters.push(['"status"', "text", query.status]);
      return this.#scanTable<SubmissionRecord>("durable_submissions", filters, start, limit);
    });
  }

  submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
    _context?: Context,
  ): Promise<SubmissionRecord | undefined> {
    return this.#admit(async () => {
      const [row] = await this.#prisma.$queryRawUnsafe<Row[]>(
        `SELECT "record" FROM "durable_submissions"
          WHERE "storeId" = $1::text AND "conversationId" = $2::bigint AND "requestId" = $3::text
          LIMIT 1`,
        this.#storeId,
        conversationId,
        encodeIndexed(requestId),
      );
      return row === undefined ? undefined : parseRecord<SubmissionRecord>(row.record);
    });
  }

  findDocument(
    address: DocumentAddress,
    at: DocumentPoint,
    _context?: Context,
  ): Promise<DocumentRecord | undefined> {
    return this.#admit(async () => {
      const columns = addressColumns(address);
      const [row] = await this.#prisma.$queryRawUnsafe<Row[]>(
        `SELECT "record" FROM "durable_documents"
          WHERE "storeId" = $1::text AND "kind" = $2::text AND "scopeKind" = $3::text
            AND "ownerId" = $4::bigint AND "family" = $5::boolean AND "keyValue" = $6::text
            AND ${aliveAt("$7")}
          ORDER BY "createdSeq" DESC LIMIT 1`,
        this.#storeId,
        columns.kind,
        columns.scopeKind,
        columns.ownerId,
        columns.family,
        columns.keyValue,
        at === "current" ? null : at,
      );
      return row === undefined ? undefined : parseRecord<DocumentRecord>(row.record);
    });
  }

  document(
    id: DocumentId,
    at: DocumentPoint,
    _context?: Context,
  ): Promise<StoredDocument | undefined> {
    // The record and its revisions must come from one committed state: a commit between them
    // can replace the base.
    return this.#admit(() =>
      withTransactionRetry(() =>
        this.#prisma.$transaction((tx) => this.#materialize(tx, id, at), {
          isolationLevel: "RepeatableRead",
        }),
      ),
    );
  }

  scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context?: Context,
  ): Promise<Page<DocumentRecord, Cursor>> {
    return this.#admit(async () => {
      const scope = scopeColumns(query.scope);
      const after = cursorAfter(cursor);
      const rows = await this.#prisma.$queryRawUnsafe<Row[]>(
        `SELECT "record" FROM "durable_documents"
          WHERE "storeId" = $1::text AND "scopeKind" = $2::text AND "ownerId" = $3::bigint
            AND "id" > $4::bigint AND ($5::text IS NULL OR "kind" = $5::text)
            AND ${aliveAt("$6")}
          ORDER BY "id" LIMIT $7::bigint`,
        this.#storeId,
        scope.scopeKind,
        scope.ownerId,
        after ?? -1,
        query.kind === undefined ? null : encodeIndexed(query.kind),
        query.at === "current" ? null : query.at,
        limit + 1,
      );
      return page(
        rows.map((row) => parseRecord<DocumentRecord>(row.record)),
        limit,
        "ascending",
      );
    });
  }

  /** Refuses new calls and waits for those underway; the database client stays open (the app's). */
  close(_context?: Context): Promise<void> {
    if (this.#closing === undefined) {
      this.#closed = true;
      this.#closing =
        this.#running === 0
          ? Promise.resolve()
          : new Promise((resolve) => {
              this.#drained = resolve;
            });
    }
    return this.#closing;
  }

  /** Runs one call unless the store is closed; close waits for it, so it never runs after. */
  async #admit<T>(call: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    this.#running++;
    try {
      return await call();
    } finally {
      if (--this.#running === 0) this.#drained?.();
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("PostgresDurableStorage is closed");
  }

  async #readRecord<T>(table: string, id: number, sql: DurableSql = this.#prisma) {
    const [row] = await sql.$queryRawUnsafe<Row[]>(
      `SELECT "record" FROM "${table}" WHERE "storeId" = $1::text AND "id" = $2::bigint`,
      this.#storeId,
      id,
    );
    return row === undefined ? undefined : parseRecord<T>(row.record);
  }

  #readConversation(id: number) {
    return this.#readRecord<ConversationRecord>("durable_conversations", id);
  }

  async #requireConversation(id: number): Promise<ConversationRecord> {
    const conversation = await this.#readConversation(id);
    if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${id}`);
    return conversation;
  }

  async #scanTable<T extends { readonly id: number }>(
    table: string,
    filters: Filter[],
    start: ScanStart,
    limit: number,
  ): Promise<Page<T, Cursor>> {
    const ascending = start.order === "ascending";
    const clauses = [
      `"storeId" = $1::text`,
      ascending ? `"id" > $2::bigint` : `"id" < $2::bigint`,
      ...filters.map(([column, type], index) => `${column} = $${index + 3}::${type}`),
    ];
    const rows = await this.#prisma.$queryRawUnsafe<Row[]>(
      `SELECT "record" FROM "${table}" WHERE ${clauses.join(" AND ")}
        ORDER BY "id" ${ascending ? "ASC" : "DESC"} LIMIT $${filters.length + 3}::bigint`,
      this.#storeId,
      start.after ?? (ascending ? -1 : Number.MAX_SAFE_INTEGER),
      ...filters.map(([, , value]) => value),
      limit + 1,
    );
    return page(
      rows.map((row) => parseRecord<T>(row.record)),
      limit,
      start.order,
    );
  }

  async #readEntry(first: number, second: unknown): Promise<StoredEntry | undefined> {
    // `entry(id, context)` or `entry(conversationId, id, context)`.
    const scoped = typeof second === "number";
    const id = scoped ? second : first;
    let conversation = scoped ? await this.#requireConversation(first) : undefined;
    const [row] = await this.#prisma.$queryRawUnsafe<Array<{ record: string; commitSeq: bigint }>>(
      `SELECT "record", "commitSeq" FROM "durable_entries"
        WHERE "storeId" = $1::text AND "id" = $2::bigint`,
      this.#storeId,
      id,
    );
    if (row === undefined) return undefined;
    const entry = parseRecord<EntryRecord>(row.record);
    if (conversation !== undefined) {
      let upper = Number.POSITIVE_INFINITY;
      while (conversation.id !== entry.conversationId) {
        if (conversation.parent === undefined) return undefined;
        upper = Math.min(upper, conversation.parent.at);
        conversation = await this.#requireConversation(conversation.parent.conversationId);
      }
      if (entry.id > upper) return undefined;
    }
    return { entry, commitSeq: asSeq(row.commitSeq) };
  }

  /** Newest first: the conversation's entries, then each fork parent's up to its fork point. */
  async #readEntriesDescending(query: EntryQuery, limit: number, after: number | undefined) {
    let conversation = await this.#requireConversation(query.conversationId);
    let upper: number | undefined = query.maxEntryId;
    if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
    const values: EntryRecord[] = [];
    for (;;) {
      values.push(
        ...(await this.#entrySegment(
          conversation.id,
          query.minEntryId,
          upper,
          "DESC",
          limit + 1 - values.length,
        )),
      );
      if (values.length > limit || conversation.parent === undefined) break;
      upper =
        upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
      if (query.minEntryId !== undefined && upper < query.minEntryId) break;
      conversation = await this.#requireConversation(conversation.parent.conversationId);
    }
    return page(values, limit, "descending");
  }

  /** Oldest first: the fork chain's segments from the root conversation forward, each up to its fork point. */
  async #readEntriesAscending(query: EntryQuery, limit: number, after: number | undefined) {
    const segments: Array<{ conversationId: number; upper: number | undefined }> = [];
    let conversation = await this.#requireConversation(query.conversationId);
    let upper: number | undefined = query.maxEntryId;
    for (;;) {
      segments.push({ conversationId: conversation.id, upper });
      if (conversation.parent === undefined) break;
      upper =
        upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
      if (query.minEntryId !== undefined && upper < query.minEntryId) break;
      conversation = await this.#requireConversation(conversation.parent.conversationId);
    }
    let lower: number | undefined = query.minEntryId;
    if (after !== undefined) lower = Math.max(lower ?? after + 1, after + 1);
    const values: EntryRecord[] = [];
    for (const segment of segments.reverse()) {
      values.push(
        ...(await this.#entrySegment(
          segment.conversationId,
          lower,
          segment.upper,
          "ASC",
          limit + 1 - values.length,
        )),
      );
      if (values.length > limit) break;
    }
    return page(values, limit, "ascending");
  }

  async #entrySegment(
    conversationId: number,
    lower: number | undefined,
    upper: number | undefined,
    direction: "ASC" | "DESC",
    limit: number,
  ): Promise<EntryRecord[]> {
    const rows = await this.#prisma.$queryRawUnsafe<Row[]>(
      `SELECT "record" FROM "durable_entries"
        WHERE "storeId" = $1::text AND "conversationId" = $2::bigint
          AND ($3::bigint IS NULL OR "id" >= $3::bigint)
          AND ($4::bigint IS NULL OR "id" <= $4::bigint)
        ORDER BY "id" ${direction} LIMIT $5::bigint`,
      this.#storeId,
      conversationId,
      lower ?? null,
      upper ?? null,
      limit,
    );
    return rows.map((row) => parseRecord<EntryRecord>(row.record));
  }

  async #materialize(
    sql: DurableSql,
    id: number,
    at: DocumentPoint,
  ): Promise<StoredDocument | undefined> {
    const record = await this.#readRecord<DocumentRecord>("durable_documents", id, sql);
    if (record === undefined) return undefined;
    if (at !== "current" && isCurrentOnly(record)) {
      throw new StorageRequestError(`Document ${id} does not retain historical content`);
    }
    if (!isAliveAtPoint(record, at)) return undefined;
    const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
    const [base] = await sql.$queryRawUnsafe<Revision[]>(
      `SELECT "seq", "kind", "version", "content" FROM "durable_document_revisions"
        WHERE "storeId" = $1::text AND "documentId" = $2::bigint AND "kind" = 'base'
          AND "seq" <= $3::bigint
        ORDER BY "seq" DESC LIMIT 1`,
      this.#storeId,
      id,
      upper,
    );
    if (base === undefined) throw new Error(`Document ${id} is missing a required base`);
    const tail = await sql.$queryRawUnsafe<Revision[]>(
      `SELECT "seq", "kind", "version", "content" FROM "durable_document_revisions"
        WHERE "storeId" = $1::text AND "documentId" = $2::bigint
          AND "seq" > $3::bigint AND "seq" <= $4::bigint
        ORDER BY "seq"`,
      this.#storeId,
      id,
      base.seq,
      upper,
    );
    let value = parseRecord<JsonObject>(base.content);
    for (const revision of tail) {
      if (revision.kind !== "delta" || revision.version !== base.version) {
        throw new Error(`Document ${id} crosses a stored version boundary without a base`);
      }
      value = apply(value, parseRecord<Op[]>(revision.content));
    }
    return { record, version: base.version, value, deltasSinceBase: tail.length };
  }
}

type Revision = { seq: bigint; kind: string; version: number; content: string };
type Filter = [column: string, type: string, value: string | number | boolean];
type ScanStart = { order: ScanOrder; after: number | undefined };

/** `sql`, noting in `failed` when one of its statements fails. */
function watchStatements(sql: DurableSql, failed: { statement: boolean }): DurableSql {
  const watch = async <T>(statement: Promise<T>): Promise<T> => {
    try {
      return await statement;
    } catch (error) {
      failed.statement = true;
      throw error;
    }
  };
  return {
    $queryRawUnsafe: (query, ...values) => watch(sql.$queryRawUnsafe(query, ...values)),
    $executeRawUnsafe: (query, ...values) => watch(sql.$executeRawUnsafe(query, ...values)),
  } as DurableSql;
}

/** The SQL condition that a document is alive at the seq in `param`, or now when it is null. */
const aliveAt = (param: string) =>
  `(CASE WHEN ${param}::bigint IS NULL THEN "retiredSeq" IS NULL
    ELSE "createdSeq" <= ${param}::bigint AND ("retiredSeq" IS NULL OR "retiredSeq" > ${param}::bigint) END)`;

function isAliveAtPoint(record: DocumentRecord, at: DocumentPoint): boolean {
  if (at === "current") return record.retiredAt === undefined;
  return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
}

function page<T extends { id: number }>(
  values: readonly T[],
  limit: number,
  order: ScanOrder,
): Page<T, Cursor> {
  const items = values.slice(0, limit);
  if (values.length <= limit) return { items };
  return { items, next: { after: items.at(-1)!.id, order } };
}

function cursorAfter(cursor: Cursor | undefined): number | undefined {
  const after = cursor?.after;
  if (after === undefined) return undefined;
  if (typeof after !== "number" || !Number.isSafeInteger(after)) {
    throw new StorageRequestError("Invalid storage cursor");
  }
  return after;
}

/**
 * A scan's order and position. A cursor continues in the order it was made with, whether the
 * query repeats that order or omits it; a different `order` is refused. A cursor without an order
 * continues in the scan's default order.
 */
function scanStart(
  requested: ScanOrder | undefined,
  cursor: Cursor | undefined,
  fallback: ScanOrder,
): ScanStart {
  if (requested !== undefined && requested !== "ascending" && requested !== "descending") {
    throw new StorageRequestError(`Invalid scan order: ${String(requested)}`);
  }
  if (cursor === undefined) return { order: requested ?? fallback, after: undefined };
  const after = cursorAfter(cursor);
  if (after === undefined) throw new StorageRequestError("Invalid storage cursor");
  const stored = cursor.order;
  if (stored !== undefined && stored !== "ascending" && stored !== "descending") {
    throw new StorageRequestError("Invalid storage cursor");
  }
  const order = (stored as ScanOrder | undefined) ?? fallback;
  if (requested !== undefined && requested !== order) {
    throw new StorageRequestError(
      `The cursor continues a ${order} scan; the query asks for ${requested}`,
    );
  }
  return { order, after };
}
