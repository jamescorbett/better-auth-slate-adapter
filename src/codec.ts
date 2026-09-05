const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const ROW_PREFIX = encoder.encode("\0better-auth\0v1\0row\0");
const MAX_KEY_SIZE = 65_535;

export type StoredRecord = Record<string, unknown> & { id: string };

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function encodePart(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length, false);
  return concat(length, bytes);
}

function assertKeySize(key: Uint8Array): Uint8Array {
  if (key.length > MAX_KEY_SIZE) {
    throw new Error(`SlateDB adapter key exceeds ${MAX_KEY_SIZE} bytes`);
  }
  return key;
}

export function modelPrefix(model: string): Uint8Array {
  return assertKeySize(concat(ROW_PREFIX, encodePart(model)));
}

export function rowKey(model: string, id: string): Uint8Array {
  return assertKeySize(concat(modelPrefix(model), encodePart(id)));
}

export function encodeRecord(record: StoredRecord): Uint8Array {
  const json = JSON.stringify(record, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("SlateDB adapter records cannot contain non-finite numbers");
    }
    if (typeof value === "bigint") {
      throw new Error("SlateDB adapter records cannot contain bigint values");
    }
    return value;
  });
  if (json === undefined) {
    throw new Error("SlateDB adapter record is not JSON serializable");
  }
  return encoder.encode(json);
}

export function decodeRecord(value: Uint8Array): StoredRecord {
  let decoded: unknown;
  try {
    decoded = JSON.parse(decoder.decode(value));
  } catch (error) {
    throw new Error("SlateDB adapter found an invalid record", { cause: error });
  }
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    Array.isArray(decoded) ||
    typeof (decoded as Record<string, unknown>).id !== "string"
  ) {
    throw new Error("SlateDB adapter found a record without a string id");
  }
  return decoded as StoredRecord;
}
