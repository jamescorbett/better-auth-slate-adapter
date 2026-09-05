import {
  ErrorTransaction,
  IsolationLevel,
  type Db,
  type DbTransaction,
} from "@slatedb/uniffi";
import type { BetterAuthOptions } from "better-auth";
import {
  createAdapterFactory,
  type CleanedWhere,
  type DBAdapter,
  type DBAdapterDebugLogOption,
  type JoinConfig,
} from "better-auth/adapters";

import {
  decodeRecord,
  encodeRecord,
  modelPrefix,
  rowKey,
  type StoredRecord,
} from "./codec.js";

const FULL_RANGE = {
  start: undefined,
  start_inclusive: false,
  end: undefined,
  end_inclusive: false,
};

type Client = Db | DbTransaction;

interface Context {
  client: Client;
  operationLock?: LockState;
  ownsTransaction: boolean;
}

interface LockState {
  tail: Promise<void>;
}

const writeLocks = new WeakMap<Db, LockState>();

export interface SlateDbAdapterConfig {
  debugLogs?: DBAdapterDebugLogOption;
  durable?: boolean;
  scanBatchSize?: number;
  transactionRetries?: number;
  usePlural?: boolean;
}

export type SlateDbAdapterErrorCode =
  | "INVALID_RECORD"
  | "UNIQUE_CONSTRAINT";

export class SlateDbAdapterError extends Error {
  readonly code: SlateDbAdapterErrorCode;

  constructor(code: SlateDbAdapterErrorCode, message: string) {
    super(message);
    this.name = "SlateDbAdapterError";
    this.code = code;
  }
}

function getLockState(db: Db): LockState {
  let state = writeLocks.get(db);
  if (!state) {
    state = { tail: Promise.resolve() };
    writeLocks.set(db, state);
  }
  return state;
}

async function withLock<T>(state: LockState, operation: () => Promise<T>): Promise<T> {
  const previous = state.tail;
  let release = (): void => undefined;
  state.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function withWriteLock<T>(db: Db, operation: () => Promise<T>): Promise<T> {
  return withLock(getLockState(db), operation);
}

function isTransactionError(error: unknown): boolean {
  return error instanceof ErrorTransaction ||
    (typeof error === "object" && error !== null && "tag" in error && error.tag === "Transaction");
}

async function rollback(transaction: DbTransaction): Promise<void> {
  try {
    await transaction.rollback();
  } catch {
    // A failed commit consumes the transaction before it returns the error.
  }
}

async function scanRecords(
  client: Client,
  model: string,
  batchSize: number,
): Promise<StoredRecord[]> {
  const iterator = await client.scan_prefix(modelPrefix(model), FULL_RANGE);
  const records: StoredRecord[] = [];
  try {
    for (;;) {
      const batch = await iterator.next_batch(batchSize);
      for (const entry of batch) {
        records.push(decodeRecord(entry.value));
      }
      if (batch.length < batchSize) {
        return records;
      }
    }
  } finally {
    iterator.dispose();
  }
}

function normalize(value: unknown): unknown {
  return typeof value === "string" ? value.toLowerCase() : value;
}

function equal(left: unknown, right: unknown, insensitive: boolean): boolean {
  if (right === null) {
    return left === null || left === undefined;
  }
  if (insensitive) {
    return normalize(left) === normalize(right);
  }
  return left === right;
}

function matchesClause(record: StoredRecord, clause: CleanedWhere): boolean {
  const left = record[clause.field];
  const right = clause.value;
  const insensitive = clause.mode === "insensitive" &&
    (typeof right === "string" ||
      (Array.isArray(right) && right.every((item) => typeof item === "string")));

  switch (clause.operator) {
    case "eq":
      return equal(left, right, insensitive);
    case "ne":
      return !equal(left, right, insensitive);
    case "lt":
      return right !== null && left !== null && left !== undefined && left < right;
    case "lte":
      return right !== null && left !== null && left !== undefined && left <= right;
    case "gt":
      return right !== null && left !== null && left !== undefined && left > right;
    case "gte":
      return right !== null && left !== null && left !== undefined && left >= right;
    case "in":
      if (!Array.isArray(right)) {
        throw new Error("The value for an in predicate must be an array");
      }
      return right.some((value) => equal(left, value, insensitive));
    case "not_in":
      if (!Array.isArray(right)) {
        throw new Error("The value for a not_in predicate must be an array");
      }
      return !right.some((value) => equal(left, value, insensitive));
    case "contains":
      return typeof left === "string" && typeof right === "string" &&
        (insensitive
          ? left.toLowerCase().includes(right.toLowerCase())
          : left.includes(right));
    case "starts_with":
      return typeof left === "string" && typeof right === "string" &&
        (insensitive
          ? left.toLowerCase().startsWith(right.toLowerCase())
          : left.startsWith(right));
    case "ends_with":
      return typeof left === "string" && typeof right === "string" &&
        (insensitive
          ? left.toLowerCase().endsWith(right.toLowerCase())
          : left.endsWith(right));
    default:
      throw new Error(`Unsupported where operator: ${String(clause.operator)}`);
  }
}

function matchesWhere(record: StoredRecord, where: CleanedWhere[]): boolean {
  if (where.length === 0) {
    return true;
  }
  const andClauses = where.filter((clause) => clause.connector === "AND");
  const orClauses = where.filter((clause) => clause.connector === "OR");
  return andClauses.every((clause) => matchesClause(record, clause)) &&
    (orClauses.length === 0 || orClauses.some((clause) => matchesClause(record, clause)));
}

function idValues(clause: CleanedWhere): string[] | undefined {
  if (clause.field !== "id" || clause.mode !== "sensitive") {
    return undefined;
  }
  if (clause.operator === "eq" && typeof clause.value === "string") {
    return [clause.value];
  }
  if (
    clause.operator === "in" &&
    Array.isArray(clause.value) &&
    clause.value.every((value) => typeof value === "string")
  ) {
    return clause.value;
  }
  return undefined;
}

function getCandidateIds(where: CleanedWhere[]): string[] | undefined {
  const andClauses = where.filter((clause) => clause.connector === "AND");
  for (const clause of andClauses) {
    const values = idValues(clause);
    if (values) {
      return values;
    }
  }
  const orClauses = where.filter((clause) => clause.connector === "OR");
  if (andClauses.length === 0 && orClauses.length > 0) {
    const values = orClauses.map(idValues);
    if (values.every((ids) => ids !== undefined)) {
      return [...new Set(values.flatMap((ids) => ids ?? []))];
    }
  }
  return undefined;
}

function compareValues(left: unknown, right: unknown): number {
  if (left === null || left === undefined) {
    return right === null || right === undefined ? 0 : -1;
  }
  if (right === null || right === undefined) {
    return 1;
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return left === right ? 0 : left ? 1 : -1;
  }
  return String(left).localeCompare(String(right));
}

function sortRecords(
  records: StoredRecord[],
  sortBy: { field: string; direction: "asc" | "desc" } | undefined,
): StoredRecord[] {
  if (!sortBy) {
    return records;
  }
  const direction = sortBy.direction === "asc" ? 1 : -1;
  return records.sort((left, right) => {
    const compared = compareValues(left[sortBy.field], right[sortBy.field]);
    return compared === 0
      ? left.id.localeCompare(right.id) * direction
      : compared * direction;
  });
}

function asStoredRecord(data: Record<string, unknown>): StoredRecord {
  if (typeof data.id !== "string" || data.id.length === 0) {
    throw new SlateDbAdapterError(
      "INVALID_RECORD",
      "SlateDB requires each Better Auth record to have a non-empty string id",
    );
  }
  return data as StoredRecord;
}

function uniqueKey(values: unknown[]): string {
  return JSON.stringify(values.map((value) => [typeof value, value]));
}

function assertUniqueRows(
  model: string,
  rows: StoredRecord[],
  constraints: string[][],
): void {
  for (const fields of constraints) {
    const seen = new Set<string>();
    for (const row of rows) {
      const values = fields.map((field) => row[field]);
      if (values.some((value) => value === null || value === undefined)) {
        continue;
      }
      const key = uniqueKey(values);
      if (seen.has(key)) {
        throw new SlateDbAdapterError(
          "UNIQUE_CONSTRAINT",
          `Unique constraint failed for ${model}.${fields.join(",")}`,
        );
      }
      seen.add(key);
    }
  }
}

async function writeRecord(client: Client, model: string, record: StoredRecord): Promise<void> {
  await client.put(rowKey(model, record.id), encodeRecord(record));
}

async function deleteRecord(client: Client, model: string, record: StoredRecord): Promise<void> {
  await client.delete(rowKey(model, record.id));
}

export function slateDbAdapter(db: Db, config: SlateDbAdapterConfig = {}) {
  const durable = config.durable ?? true;
  const scanBatchSize = config.scanBatchSize ?? 256;
  const transactionRetries = config.transactionRetries ?? 3;
  if (!Number.isInteger(scanBatchSize) || scanBatchSize < 1) {
    throw new Error("scanBatchSize must be a positive integer");
  }
  if (!Number.isInteger(transactionRetries) || transactionRetries < 0) {
    throw new Error("transactionRetries must be a non-negative integer");
  }

  const runInternalTransaction = async <T>(
    operation: (transaction: DbTransaction) => Promise<T>,
  ): Promise<T> => withWriteLock(db, async () => {
    for (let attempt = 0;; attempt += 1) {
      const transaction = await db.begin(IsolationLevel.SerializableSnapshot);
      try {
        const result = await operation(transaction);
        const handle = await transaction.commit();
        if (handle) {
          try {
            if (durable) {
              await handle.await_durable();
            }
          } finally {
            handle.dispose();
          }
        }
        return result;
      } catch (error) {
        await rollback(transaction);
        if (!isTransactionError(error) || attempt >= transactionRetries) {
          throw error;
        }
      } finally {
        transaction.dispose();
      }
    }
  });

  const buildAdapter = (
    options: BetterAuthOptions,
    context: Context,
  ): DBAdapter<BetterAuthOptions> => {
    const access = <T>(operation: () => Promise<T>): Promise<T> =>
      context.operationLock
        ? withLock(context.operationLock, operation)
        : operation();
    const mutate = <T>(operation: (client: Client) => Promise<T>): Promise<T> =>
      context.ownsTransaction
        ? access(() => operation(context.client))
        : runInternalTransaction(operation);

    return createAdapterFactory({
      config: {
        adapterId: "slatedb",
        adapterName: "SlateDB Adapter",
        debugLogs: config.debugLogs ?? false,
        supportsArrays: false,
        supportsBooleans: true,
        supportsDates: false,
        supportsJSON: false,
        supportsNumericIds: false,
        supportsUUIDs: false,
        usePlural: config.usePlural ?? false,
        transaction: context.ownsTransaction
          ? false
          : async <T>(callback: (adapter: Omit<DBAdapter, "transaction">) => Promise<T>) =>
              withWriteLock(db, async () => {
                const transaction = await db.begin(IsolationLevel.SerializableSnapshot);
                try {
                  const adapter = buildAdapter(options, {
                    client: transaction,
                    operationLock: { tail: Promise.resolve() },
                    ownsTransaction: true,
                  });
                  const result = await callback(adapter);
                  const handle = await transaction.commit();
                  if (handle) {
                    try {
                      if (durable) {
                        await handle.await_durable();
                      }
                    } finally {
                      handle.dispose();
                    }
                  }
                  return result;
                } catch (error) {
                  await rollback(transaction);
                  throw error;
                } finally {
                  transaction.dispose();
                }
              }),
      },
      adapter: ({ getDefaultFieldName, getDefaultModelName, schema }) => {
        const getUniqueConstraints = (model: string): string[][] => {
          const defaultModel = getDefaultModelName(model);
          const table = schema[defaultModel];
          if (!table) {
            return [["id"]];
          }
          const constraints: string[][] = [["id"]];
          for (const [fieldName, field] of Object.entries(table.fields)) {
            if (field.unique) {
              constraints.push([field.fieldName ?? fieldName]);
            }
          }
          const indexes = (table as typeof table & {
            indexes?: readonly {
              fields: readonly string[];
              unique?: boolean;
            }[];
          }).indexes ?? [];
          for (const index of indexes) {
            if (index.unique) {
              constraints.push(index.fields.map((fieldName) => {
                const field = table.fields[fieldName];
                return field?.fieldName ?? fieldName;
              }));
            }
          }
          return constraints;
        };

        const query = async (
          client: Client,
          model: string,
          where: CleanedWhere[] | undefined,
        ): Promise<StoredRecord[]> => {
          const candidateIds = where ? getCandidateIds(where) : undefined;
          const records = candidateIds
            ? (await Promise.all(candidateIds.map(async (id) => {
                const value = await client.get(rowKey(model, id));
                return value ? decodeRecord(value) : undefined;
              }))).filter((record): record is StoredRecord => record !== undefined)
            : await scanRecords(client, model, scanBatchSize);
          return where ? records.filter((record) => matchesWhere(record, where)) : records;
        };

        const selectFields = (
          record: StoredRecord,
          model: string,
          select: string[] | undefined,
        ): Record<string, unknown> => {
          if (!select?.length) {
            return record;
          }
          return Object.fromEntries(
            Object.entries(record).filter(([field]) =>
              select.includes(getDefaultFieldName({ model, field })),
            ),
          );
        };

        const replaceAndValidate = (
          model: string,
          records: StoredRecord[],
          replacements: Map<string, StoredRecord>,
        ): StoredRecord[] => {
          const next = records.map((record) => replacements.get(record.id) ?? record);
          assertUniqueRows(model, next, getUniqueConstraints(model));
          return next;
        };

        return {
          create: async <T extends Record<string, any>>({ model, data }: {
            model: string;
            data: T;
            select?: string[] | undefined;
          }): Promise<T> => mutate(async (client) => {
            const record = asStoredRecord(data);
            const records = await scanRecords(client, model, scanBatchSize);
            assertUniqueRows(model, [...records, record], getUniqueConstraints(model));
            await writeRecord(client, model, record);
            return record as T;
          }),
          findOne: async <T>({ model, where, select }: {
            model: string;
            where: CleanedWhere[];
            select?: string[] | undefined;
            join?: JoinConfig | undefined;
          }): Promise<T | null> => {
            const records = await access(() => query(context.client, model, where));
            return records[0]
              ? selectFields(records[0], model, select) as T
              : null;
          },
          findMany: async <T>({ model, where, limit, select, sortBy, offset }: {
            model: string;
            where?: CleanedWhere[] | undefined;
            limit: number;
            select?: string[] | undefined;
            sortBy?: { field: string; direction: "asc" | "desc" } | undefined;
            offset?: number | undefined;
            join?: JoinConfig | undefined;
          }): Promise<T[]> => {
            const records = sortRecords(
              await access(() => query(context.client, model, where)),
              sortBy,
            );
            return records
              .slice(offset ?? 0, (offset ?? 0) + limit)
              .map((record) => selectFields(record, model, select) as T);
          },
          count: async ({ model, where }) =>
            (await access(() => query(context.client, model, where))).length,
          update: async <T>({ model, where, update }: {
            model: string;
            where: CleanedWhere[];
            update: T;
          }): Promise<T | null> => mutate(async (client) => {
            if (where.length === 0) {
              return null;
            }
            const records = await scanRecords(client, model, scanBatchSize);
            const current = records.find((record) => matchesWhere(record, where));
            if (!current) {
              return null;
            }
            const next = asStoredRecord({ ...current, ...update, id: current.id });
            replaceAndValidate(model, records, new Map([[current.id, next]]));
            await writeRecord(client, model, next);
            return next as T;
          }),
          updateMany: async ({ model, where, update }) => mutate(async (client) => {
            const records = await scanRecords(client, model, scanBatchSize);
            const replacements = new Map<string, StoredRecord>();
            for (const record of records) {
              if (matchesWhere(record, where)) {
                replacements.set(
                  record.id,
                  asStoredRecord({ ...record, ...update, id: record.id }),
                );
              }
            }
            replaceAndValidate(model, records, replacements);
            for (const record of replacements.values()) {
              await writeRecord(client, model, record);
            }
            return replacements.size;
          }),
          delete: async ({ model, where }) => mutate(async (client) => {
            if (where.length === 0) {
              return;
            }
            const records = await query(client, model, where);
            if (records[0]) {
              await deleteRecord(client, model, records[0]);
            }
          }),
          deleteMany: async ({ model, where }) => mutate(async (client) => {
            const records = await query(client, model, where);
            for (const record of records) {
              await deleteRecord(client, model, record);
            }
            return records.length;
          }),
          consumeOne: async <T>({ model, where }: {
            model: string;
            where: CleanedWhere[];
          }): Promise<T | null> => mutate(async (client) => {
            if (where.length === 0) {
              return null;
            }
            const records = await query(client, model, where);
            const record = records[0];
            if (!record) {
              return null;
            }
            await deleteRecord(client, model, record);
            return record as T;
          }),
          incrementOne: async <T>({ model, where, increment, set }: {
            model: string;
            where: CleanedWhere[];
            increment: Record<string, number>;
            set?: Record<string, unknown> | undefined;
          }): Promise<T | null> => mutate(async (client) => {
            if (where.length === 0) {
              return null;
            }
            const records = await scanRecords(client, model, scanBatchSize);
            const current = records.find((record) => matchesWhere(record, where));
            if (!current) {
              return null;
            }
            const next: StoredRecord = { ...current, ...set };
            for (const [field, delta] of Object.entries(increment)) {
              const value = current[field];
              if (typeof value !== "number" || !Number.isFinite(value)) {
                throw new SlateDbAdapterError(
                  "INVALID_RECORD",
                  `Cannot increment the non-numeric field ${model}.${field}`,
                );
              }
              const updated = value + delta;
              if (!Number.isFinite(updated)) {
                throw new SlateDbAdapterError(
                  "INVALID_RECORD",
                  `Increment produced a non-finite value for ${model}.${field}`,
                );
              }
              next[field] = updated;
            }
            next.id = current.id;
            replaceAndValidate(model, records, new Map([[current.id, next]]));
            await writeRecord(client, model, next);
            return next as T;
          }),
          options: {
            durable,
            scanBatchSize,
            transactionRetries,
          },
        };
      },
    })(options);
  };

  return (options: BetterAuthOptions): DBAdapter<BetterAuthOptions> =>
    buildAdapter(options, { client: db, ownsTransaction: false });
}
