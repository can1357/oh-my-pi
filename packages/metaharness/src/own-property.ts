/**
 * Store `value` under a caller-chosen `key` as an own enumerable property.
 *
 * Plain assignment (`record[key] = value`) with the key `__proto__` replaces the object's
 * prototype instead and the entry disappears from `Object.entries` and `JSON.stringify`,
 * although `env` and `printenv` accept such a variable name.
 */
export function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}
