// Built-in types only. Sharing the cast/OID mapping keeps compilation and live
// metadata checks aligned; domains and protocol-compatible types do not inherit support.
const types = {
  INT16: { cast: "int2", oid: 21 }, INT32: { cast: "int4", oid: 23 }, INT64: { cast: "int8", oid: 20 },
  DECIMAL: { cast: "numeric", oid: 1700 }, BOOL: { cast: "bool", oid: 16 }, STRING: { cast: "text", oid: 25 },
  UUID: { cast: "uuid", oid: 2950 }, DATE: { cast: "date", oid: 1082 }, TIME: { cast: "time", oid: 1083 },
  TIMESTAMP: { cast: "timestamp", oid: 1114 }, TIMESTAMPTZ: { cast: "timestamptz", oid: 1184 },
};
export type PostgresParameterType = keyof typeof types;
export const postgresParameterTypes = Object.freeze(Object.fromEntries(Object.entries(types).map(([k, v]) =>
  [k, Object.freeze(v)]))) as Readonly<typeof types>;

export function postgresText(value: unknown, maximum: number): value is string {
  // Reject UTF-8 replacement rather than hash one value and send another.
  return typeof value === "string" && value.length <= maximum && !value.includes("\0") &&
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value;
}

function date(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const [year, month, day] = value.split("-").map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
}
const time = (value: string) => /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?$/.test(value);
function temporal(type: string, value: string) {
  if (type === "DATE") return date(value);
  if (type === "TIME") return time(value);
  if (type !== "TIMESTAMP" && type !== "TIMESTAMPTZ") return false;
  if (!date(value.slice(0, 10)) || value[10] !== "T") return false;
  if (type === "TIMESTAMP") return time(value.slice(11));
  const match = /^(.*?)(Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/.exec(value.slice(11));
  // RFC 3339 -00:00 means unknown offset, not an asserted instant.
  return !!match && match[2] !== "-00:00" && time(match[1]);
}
const bounds = { INT16: [-32768n, 32767n], INT32: [-2147483648n, 2147483647n],
  INT64: [-9223372036854775808n, 9223372036854775807n] } as const;

export function postgresParameter(type: unknown, value: unknown): { cast: string; value: string | boolean | null } {
  if (typeof type !== "string" || !Object.hasOwn(postgresParameterTypes, type)) throw new Error("Unsupported parameter type");
  const cast = "pg_catalog." + postgresParameterTypes[type as PostgresParameterType].cast;
  if (value === null) return { cast, value };
  if (type === "BOOL" && typeof value === "boolean") return { cast, value };
  if (type === "STRING" && postgresText(value, 4096)) return { cast, value };
  if (Object.hasOwn(bounds, type)) {
    const text = typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) ? String(value) : value;
    const [min, max] = bounds[type as keyof typeof bounds];
    if (typeof text === "string" && /^-?(0|[1-9][0-9]{0,18})$/.test(text) && text !== "-0" &&
        BigInt(text) >= min && BigInt(text) <= max) return { cast, value: text };
  }
  if (type === "DECIMAL" && typeof value === "string" && value.length <= 128 &&
      /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) return { cast, value };
  if (typeof value === "string" && ((type === "UUID" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) || temporal(type, value))) {
    // Never pass temporal strings through Date or the driver's date serializer:
    // their microseconds and explicit offsets must reach PostgreSQL unchanged.
    return { cast, value };
  }
  throw new Error("Invalid PostgreSQL parameter");
}
