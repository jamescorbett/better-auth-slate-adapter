import { randomUUID } from "node:crypto";

import {
  authFlowTestSuite,
  caseInsensitiveTestSuite,
  joinsTestSuite,
  normalTestSuite,
  testAdapter,
  transactionsTestSuite,
  uuidTestSuite,
} from "@better-auth/test-utils/adapter";
import { DbBuilder, ObjectStore } from "@slatedb/uniffi";

import { slateDbAdapter } from "../src/index.js";

const store = ObjectStore.resolve("memory:///");
const builder = new DbBuilder(`better-auth-conformance-${randomUUID()}`, store);
const db = await builder.build();
builder.dispose();

const { execute } = await testAdapter({
  adapter: () => slateDbAdapter(db, { durable: false }),
  runMigrations: () => undefined,
  tests: [
    normalTestSuite(),
    transactionsTestSuite(),
    authFlowTestSuite(),
    joinsTestSuite(),
    uuidTestSuite(),
    caseInsensitiveTestSuite(),
  ],
  async onFinish() {
    await db.shutdown();
    db.dispose();
    store.dispose();
  },
});

execute();
