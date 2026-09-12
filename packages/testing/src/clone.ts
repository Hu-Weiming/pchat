/** Test adapters intentionally accept the same JSON data as the durable ports. */
export function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
