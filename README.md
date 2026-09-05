# Better Auth SlateDB adapter

This package stores Better Auth data in SlateDB through the official Node binding.

The package is private and is not published to npm.

## Requirements

- Node.js 20 or later
- Better Auth 1.6.19 or later
- SlateDB Node binding 0.16.0 or later

SlateDB permits one active writer for a database path. Do not open the same path for writing in multiple application processes.

## Install

```bash
npm install better-auth @slatedb/uniffi
npm install git+https://forgejo.example.com/james/better-auth-slate-adapter.git
```

## Use

```ts
import { betterAuth } from "better-auth";
import { DbBuilder, ObjectStore } from "@slatedb/uniffi";
import { slateDbAdapter } from "better-auth-slate-adapter";

const objectStore = ObjectStore.resolve("file:///var/lib/my-app/data");
const builder = new DbBuilder("auth", objectStore);
const db = await builder.build();
builder.dispose();

export const auth = betterAuth({
  database: slateDbAdapter(db),
});
```

The application owns the `Db` and `ObjectStore` objects. Shut down and dispose of them when the application stops.

```ts
await db.shutdown();
db.dispose();
objectStore.dispose();
```

## Behavior

The adapter stores each row as versioned JSON under a binary key. The key contains the model name and the string ID.

All mutations use serializable SlateDB transactions. These transactions prevent lost updates and conflicting guarded writes.

The adapter waits for each write to become durable by default. Set `durable: false` only when the application can accept data loss after a process failure.

The adapter uses point reads for ID predicates. It scans a model for other predicates and unique constraints, so query time grows with the model size.

The adapter does not support numeric IDs. Better Auth generates string IDs and UUIDs before it calls the adapter.

## Configuration

`slateDbAdapter(db, configuration)` accepts these fields:

- `debugLogs`: Enables Better Auth adapter logs.
- `durable`: Waits for durable storage before a mutation returns. The default is `true`.
- `scanBatchSize`: Sets the number of rows in each native scan call. The default is `256`.
- `transactionRetries`: Sets the retry count for an internal transaction conflict. The default is `3`.
- `usePlural`: Uses plural Better Auth model names.

SlateDB does not need SQL migrations. The adapter reads the runtime schema from Better Auth, including fields from plugins.
