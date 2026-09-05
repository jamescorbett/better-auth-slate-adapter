import { randomUUID } from "node:crypto";

import { DbBuilder, ObjectStore, type Db } from "@slatedb/uniffi";
import type { BetterAuthOptions } from "better-auth";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { slateDbAdapter } from "../src/index.js";

interface TestUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  count: number;
}

const options = {
  user: {
    additionalFields: {
      count: {
        type: "number",
        defaultValue: 0,
      },
    },
  },
} satisfies BetterAuthOptions;

let db: Db;
let store: ObjectStore;

function userData(email: string, name = email): Omit<TestUser, "id"> {
  const now = new Date();
  return {
    name,
    email,
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
    count: 0,
  };
}

beforeAll(async () => {
  store = ObjectStore.resolve("memory:///");
  const builder = new DbBuilder(`better-auth-${randomUUID()}`, store);
  try {
    db = await builder.build();
  } finally {
    builder.dispose();
  }
});

afterAll(async () => {
  await db.shutdown();
  db.dispose();
  store.dispose();
});

describe("slateDbAdapter", () => {
  test("creates, queries, sorts, updates, and deletes records", async () => {
    const adapter = slateDbAdapter(db)(options);
    const first = await adapter.create<TestUser>({
      model: "user",
      data: userData("one@example.com", "Alpha"),
    });
    const second = await adapter.create<TestUser>({
      model: "user",
      data: userData("two@example.com", "beta"),
    });

    await expect(adapter.findMany<TestUser>({
      model: "user",
      where: [{ field: "name", value: "ALPHA", mode: "insensitive" }],
    })).resolves.toEqual([first]);

    const sorted = await adapter.findMany<TestUser>({
      model: "user",
      sortBy: { field: "email", direction: "desc" },
    });
    expect(sorted.map((user) => user.id)).toEqual([second.id, first.id]);

    const updated = await adapter.update<TestUser>({
      model: "user",
      where: [{ field: "id", value: first.id }],
      update: { name: "Updated" },
    });
    expect(updated?.name).toBe("Updated");

    await adapter.delete({
      model: "user",
      where: [{ field: "id", value: second.id }],
    });
    await expect(adapter.count({ model: "user" })).resolves.toBe(1);
  });

  test("enforces unique fields", async () => {
    const adapter = slateDbAdapter(db)(options);
    const email = `${randomUUID()}@example.com`;
    await adapter.create<TestUser>({ model: "user", data: userData(email) });
    await expect(
      adapter.create<TestUser>({ model: "user", data: userData(email) }),
    ).rejects.toMatchObject({ code: "UNIQUE_CONSTRAINT" });
  });

  test("rejects values that JSON cannot preserve", async () => {
    const adapter = slateDbAdapter(db)(options);
    const data = userData(`${randomUUID()}@example.com`);
    data.count = Number.NaN;
    await expect(adapter.create<TestUser>({ model: "user", data })).rejects.toThrow(
      "records cannot contain non-finite numbers",
    );
  });

  test("rolls back a failed Better Auth transaction", async () => {
    const adapter = slateDbAdapter(db)(options);
    const email = `${randomUUID()}@example.com`;

    await expect(adapter.transaction(async (transaction) => {
      await transaction.create<TestUser>({ model: "user", data: userData(email) });
      throw new Error("stop transaction");
    })).rejects.toThrow("stop transaction");

    await expect(adapter.findOne<TestUser>({
      model: "user",
      where: [{ field: "email", value: email }],
    })).resolves.toBeNull();
  });

  test("serializes parallel operations inside a transaction", async () => {
    const adapter = slateDbAdapter(db)(options);
    const email = `${randomUUID()}@example.com`;

    await expect(adapter.transaction(async (transaction) => {
      await Promise.all([
        transaction.create<TestUser>({ model: "user", data: userData(email) }),
        transaction.create<TestUser>({ model: "user", data: userData(email) }),
      ]);
    })).rejects.toMatchObject({ code: "UNIQUE_CONSTRAINT" });

    await expect(adapter.findOne<TestUser>({
      model: "user",
      where: [{ field: "email", value: email }],
    })).resolves.toBeNull();
  });

  test("lets only one concurrent caller consume a record", async () => {
    const adapter = slateDbAdapter(db)(options);
    const user = await adapter.create<TestUser>({
      model: "user",
      data: userData(`${randomUUID()}@example.com`),
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => adapter.consumeOne<TestUser>({
        model: "user",
        where: [{ field: "id", value: user.id }],
      })),
    );
    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  test("applies concurrent guarded increments without lost updates", async () => {
    const adapter = slateDbAdapter(db)(options);
    const user = await adapter.create<TestUser>({
      model: "user",
      data: userData(`${randomUUID()}@example.com`),
    });

    await Promise.all(
      Array.from({ length: 10 }, () => adapter.incrementOne<TestUser>({
        model: "user",
        where: [
          { field: "id", value: user.id },
          { field: "count", value: 10, operator: "lt" },
        ],
        increment: { count: 1 },
      })),
    );

    const result = await adapter.findOne<TestUser>({
      model: "user",
      where: [{ field: "id", value: user.id }],
    });
    expect(result?.count).toBe(10);
  });
});
