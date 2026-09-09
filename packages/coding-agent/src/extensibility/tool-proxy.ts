/**
 * Defines lazy proxy properties on a wrapper so it forwards to the underlying tool.
 */
import { isArkSchema } from "@oh-my-pi/pi-ai/utils/schema";

export function applyToolProxy<TTool extends object>(tool: TTool, wrapper: object): void {
	const visited = new Set<PropertyKey>();
	let current: object | null = tool;

	while (current && current !== Object.prototype) {
		for (const key of Reflect.ownKeys(current)) {
			if (key === "constructor" || visited.has(key) || key in wrapper) {
				continue;
			}
			visited.add(key);
			Object.defineProperty(wrapper, key, {
				get() {
					const value = (tool as Record<PropertyKey, unknown>)[key];
					if (typeof value !== "function") return value;
					// Callable schema values (ArkType `Type`, e.g. the `parameters` schema)
					// must pass through untouched: `bind()` returns a bare bound function
					// that drops the schema surface (`toJsonSchema`/`assert`/own keys), so a
					// bound schema later stringifies to `undefined` and poisons wire-schema
					// and token accounting. Only genuine methods are bound so `this` is
					// preserved through the wrapper.
					if (isArkSchema(value) || typeof value.bind !== "function") return value;
					return value.bind(tool);
				},
				enumerable: true,
				configurable: true,
			});
		}
		current = Object.getPrototypeOf(current);
	}
}
