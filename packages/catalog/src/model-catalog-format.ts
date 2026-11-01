import type { Api, Model } from "./types";

// References are distinguished from JSON scalar values by their one-element array.
// -1 represents an explicitly present undefined value.
type EncodedValue = string | number | boolean | null | [number];
type ObjectNode = [0, EncodedValue[], number, number[]];
type ArrayNode = [1, EncodedValue[]];
type Node = ObjectNode | ArrayNode;
type CompatDelta = [number[], EncodedValue];
type ModelRow = [string, EncodedValue, CompatDelta?];
type ProviderRow = [string, EncodedValue, ModelRow[]];

interface CatalogData {
	version: 1;
	keys: string[];
	booleanShapes: number[][];
	nodes: Node[];
	compat: [string, EncodedValue][];
	providers: ProviderRow[];
}

/**
 * Parsed compact catalog. Decoded nested objects and arrays can be shared by
 * multiple models; callers must treat those values as immutable.
 */
export interface ModelCatalog {
	readonly data: CatalogData;
	readonly values: unknown[];
	readonly decoded: boolean[];
	readonly providers: Map<string, Record<string, Model<Api>>>;
	readonly compatBases: Map<string, EncodedValue>;
	readonly compatValues: Map<string, Map<number, Map<string, Record<string, unknown>>>>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// JSON serialization with sorted object keys gives both deterministic ordering
// and value-based interning, independent of the input objects' insertion order.
function canonical(value: unknown): string {
	if (value === undefined) return "u";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isObject(value)) {
		return `{${Object.keys(value)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Encode a model catalog into a deterministic, compact JSON representation. */
export function encodeModelCatalog(models: Record<string, Record<string, Model<Api>>>): string {
	// Match JSON's treatment of undefined and non-finite numbers in generated rows.
	models = JSON.parse(JSON.stringify(models));
	const keys: string[] = [];
	const keyIds = new Map<string, number>();
	const booleanShapes: number[][] = [];
	const shapeIds = new Map<string, number>();
	const nodes: Node[] = [];
	const nodeIds = new Map<string, number>();
	const keyId = (key: string): number => {
		let id = keyIds.get(key);
		if (id === undefined) {
			id = keys.length;
			keys.push(key);
			keyIds.set(key, id);
		}
		return id;
	};
	const encode = (value: unknown): EncodedValue => {
		if (value === undefined) return [-1];
		if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			return value;
		}
		const signature = canonical(value);
		const existing = nodeIds.get(signature);
		if (existing !== undefined) return [existing];
		let node: Node;
		if (Array.isArray(value)) {
			node = [1, value.map(encode)];
		} else if (isObject(value)) {
			const properties: EncodedValue[] = [];
			const boolKeys: number[] = [];
			const masks: number[] = [];
			for (const key of Object.keys(value).sort()) {
				const entry = value[key];
				if (typeof entry === "boolean") {
					const bit = boolKeys.length;
					boolKeys.push(keyId(key));
					const word = Math.floor(bit / 32);
					masks[word] ??= 0;
					if (entry) masks[word] = (masks[word] | (1 << (bit % 32))) >>> 0;
				} else {
					properties.push(keyId(key), encode(entry));
				}
			}
			const shape = boolKeys.join(",");
			let shapeId = shapeIds.get(shape);
			if (shapeId === undefined) {
				shapeId = booleanShapes.length;
				booleanShapes.push(boolKeys);
				shapeIds.set(shape, shapeId);
			}
			node = [0, properties, shapeId, masks];
		} else {
			throw new TypeError("Model catalog values must be JSON-compatible");
		}
		const id = nodes.length;
		nodes.push(node);
		nodeIds.set(signature, id);
		return [id];
	};

	// Select the most common complete compat object for each API. A row's
	// delta records changed properties and explicitly removed base properties.
	const compatCounts = new Map<string, Map<string, { value: Record<string, unknown>; count: number }>>();
	for (const provider of Object.keys(models).sort()) {
		for (const id of Object.keys(models[provider]).sort()) {
			const model = models[provider][id];
			if (typeof model.api !== "string" || !isObject(model.compat)) continue;
			let counts = compatCounts.get(model.api);
			if (!counts) compatCounts.set(model.api, (counts = new Map()));
			const signature = canonical(model.compat);
			const entry = counts.get(signature);
			if (entry) entry.count++;
			else counts.set(signature, { value: model.compat, count: 1 });
		}
	}
	const bases = new Map<string, Record<string, unknown>>();
	for (const api of [...compatCounts.keys()].sort()) {
		const choices = [...compatCounts.get(api)!.entries()].sort(
			(a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
		);
		bases.set(api, choices[0][1].value);
	}
	const compat: [string, EncodedValue][] = [...bases].map(([api, value]) => [api, encode(value)]);
	const providers: ProviderRow[] = [];
	for (const provider of Object.keys(models).sort()) {
		const entries = Object.entries(models[provider]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		const constants: Record<string, unknown> = Object.create(null);
		if (entries.length) {
			const first = entries[0][1] as unknown as Record<string, unknown>;
			for (const key of Object.keys(first).sort()) {
				const value = first[key];
				if (key === "id" || key === "compat" || (value !== null && typeof value === "object")) continue;
				if (
					entries.every(
						([, model]) =>
							Object.hasOwn(model, key) && (model as unknown as Record<string, unknown>)[key] === value,
					)
				) {
					constants[key] = value;
				}
			}
		}
		const encodedConstants = encode(constants);
		const rows: ModelRow[] = [];
		for (const [id, model] of entries) {
			const rest: Record<string, unknown> = Object.create(null);
			const source = model as unknown as Record<string, unknown>;
			const base = typeof model.api === "string" ? bases.get(model.api) : undefined;
			const useBase = base !== undefined && isObject(model.compat);
			for (const key of Object.keys(source).sort()) {
				if (Object.hasOwn(constants, key) || (key === "id" && source.id === id) || (key === "compat" && useBase))
					continue;
				rest[key] = source[key];
			}
			const row: ModelRow = [id, encode(rest)];
			if (useBase) {
				const value = model.compat as Record<string, unknown>;
				const removed = Object.keys(base)
					.filter(key => !Object.hasOwn(value, key))
					.sort()
					.map(keyId);
				const changed: Record<string, unknown> = Object.create(null);
				for (const key of Object.keys(value).sort()) {
					if (!Object.hasOwn(base, key) || canonical(value[key]) !== canonical(base[key]))
						changed[key] = value[key];
				}
				row.push([removed, encode(changed)]);
			}
			rows.push(row);
		}
		providers.push([provider, encodedConstants, rows]);
	}
	return JSON.stringify({ version: 1, keys, booleanShapes, nodes, compat, providers } satisfies CatalogData);
}

/** Open a parsed catalog without materializing its provider models. */
export function openModelCatalog(value: unknown): ModelCatalog {
	const data = value as CatalogData;
	if (data.version !== 1) throw new Error("Unsupported model catalog version");
	return {
		data,
		values: [],
		decoded: [],
		providers: new Map(),
		compatBases: new Map(data.compat),
		compatValues: new Map(),
	};
}

// Assignment is safe for ordinary keys, but __proto__ must remain an own key.
function setProperty(object: Record<string, unknown>, key: string, value: unknown): void {
	if (key === "__proto__") {
		Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
	} else {
		object[key] = value;
	}
}

function decodeObject(catalog: ModelCatalog, object: Record<string, unknown>, node: ObjectNode): void {
	for (let i = 0; i < node[1].length; i += 2) {
		setProperty(object, catalog.data.keys[node[1][i] as number], decode(catalog, node[1][i + 1]));
	}
	const shape = catalog.data.booleanShapes[node[2]];
	for (let i = 0; i < shape.length; i++) {
		setProperty(object, catalog.data.keys[shape[i]], ((node[3][i >>> 5] >>> (i % 32)) & 1) !== 0);
	}
}

function decode(catalog: ModelCatalog, value: EncodedValue): unknown {
	if (!Array.isArray(value)) return value;
	const id = value[0];
	if (id === -1) return undefined;
	if (catalog.decoded[id]) return catalog.values[id];
	const node = catalog.data.nodes[id];
	let result: unknown;
	if (node[0] === 1) {
		result = node[1].map(entry => decode(catalog, entry));
	} else {
		const object: Record<string, unknown> = {};
		decodeObject(catalog, object, node);
		result = object;
	}
	catalog.values[id] = result;
	catalog.decoded[id] = true;
	return result;
}

/** List catalog provider keys in deterministic order. */
export function getCatalogProviders(catalog: ModelCatalog): string[] {
	return catalog.data.providers.map(provider => provider[0]);
}

/** Materialize and cache one provider, or return undefined if it is absent. */
export function getCatalogProvider(catalog: ModelCatalog, provider: string): Record<string, Model<Api>> | undefined {
	const cached = catalog.providers.get(provider);
	if (cached) return cached;
	const entry = catalog.data.providers.find(row => row[0] === provider);
	if (!entry) return undefined;
	const constants = decode(catalog, entry[1]) as Record<string, unknown>;
	const models: Record<string, Model<Api>> = {};
	for (const [id, encoded, delta] of entry[2]) {
		if (!Array.isArray(encoded) || encoded[0] < 0) throw new Error("Invalid compact model row");
		const row = catalog.data.nodes[encoded[0]];
		if (!row || row[0] !== 0) throw new Error("Invalid compact model row");
		const model: Record<string, unknown> = { id, ...constants };
		decodeObject(catalog, model, row);
		if (delta) {
			const api = model.api as string;
			const changeId = (delta[1] as [number])[0];
			const changeNode = catalog.data.nodes[changeId] as ObjectNode;
			const base = decode(catalog, catalog.compatBases.get(api)!) as Record<string, unknown>;
			let compat: Record<string, unknown>;
			if (
				delta[0].length === 0 &&
				changeNode[1].length === 0 &&
				catalog.data.booleanShapes[changeNode[2]].length === 0
			) {
				compat = base;
			} else {
				let byChange = catalog.compatValues.get(api);
				if (!byChange) catalog.compatValues.set(api, (byChange = new Map()));
				let byRemoved = byChange.get(changeId);
				if (!byRemoved) byChange.set(changeId, (byRemoved = new Map()));
				const removedKey = delta[0].join(",");
				const cachedCompat = byRemoved.get(removedKey);
				if (cachedCompat) {
					compat = cachedCompat;
				} else {
					compat = { ...base };
					for (const key of delta[0]) delete compat[catalog.data.keys[key]];
					const changes = decode(catalog, delta[1]) as Record<string, unknown>;
					for (const key in changes) {
						if (Object.hasOwn(changes, key)) setProperty(compat, key, changes[key]);
					}
					byRemoved.set(removedKey, compat);
				}
			}
			model.compat = compat;
		}
		setProperty(models as Record<string, unknown>, id, model);
	}
	catalog.providers.set(provider, models);
	return models;
}
