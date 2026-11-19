/**
 * Validation error containers mirroring ArkType's observable error surface:
 * `result instanceof type.errors` / `instanceof OmpErrors`, lazy `.summary`,
 * array iteration, and per-entry `.path` / `.problem` / `.message`.
 *
 * Failure-path cost matters: schemas reject untrusted input constantly, so
 * construction stores only the path, the expectation, and the offending value.
 * All human-readable strings are built lazily on property access.
 */

/** Context supplied to configurable error formatters. */
export interface ErrorContext {
	readonly code: string;
	readonly path: readonly PropertyKey[];
	readonly propString: string;
	readonly data: unknown;
	readonly expected: string;
	readonly actual: string;
	readonly problem: string;
	readonly description: string;
	readonly rule?: unknown;
}

/** Per-schema overrides for validation error text. */
export interface ErrorConfig {
	readonly expected?: string | ((context: ErrorContext) => string);
	readonly actual?: string | ((data: unknown) => string);
	readonly problem?: string | ((context: ErrorContext) => string);
	readonly message?: string | ((context: ErrorContext) => string);
	/** Internal: custom predicate expectations display the offending value rather than its domain. */
	readonly preserveActual?: boolean;
}

function format(
	override: string | ((context: ErrorContext) => string) | undefined,
	context: ErrorContext,
	fallback: string,
): string {
	return typeof override === "function" ? override(context) : (override ?? fallback);
}

/** A single validation failure at one path. */
export class OmpError {
	#rawExpected: string;
	#config: ErrorConfig | undefined;

	constructor(
		/** Property path from the root to the failing value (empty at root). */
		readonly path: PropertyKey[],
		expected: string,
		/** The value that failed validation. */
		readonly data: unknown,
		config?: ErrorConfig,
	) {
		this.#rawExpected = expected;
		this.#config = config;
	}
	/** Prefix this failure when a nested schema delegates validation. */
	prefix(key: PropertyKey): this {
		this.path.unshift(key);
		return this;
	}

	/** Apply schema-local formatting to this failure. */
	configure(config: ErrorConfig): this {
		this.#config = { ...this.#config, ...config };
		return this;
	}

	/** Stable category for programmatic error handling. */
	get code(): string {
		return errorCode(this.#rawExpected, this.data);
	}

	#context(expected: string, actual: string, problem = ""): ErrorContext {
		const { description, rule } = describeExpectation(this.#rawExpected);
		return {
			code: this.code,
			path: this.path,
			propString: formatPath(this.path),
			data: this.data,
			expected,
			actual,
			problem,
			description,
			...(rule === undefined ? {} : { rule }),
		};
	}

	/** Human-readable expectation, including a configured override. */
	get expected(): string {
		const actual = describeValue(this.data, this.#config?.preserveActual ? "predicate" : this.code);
		const parts = this.#rawExpected.split(" or ");
		const fallback =
			parts.length < 3 ? this.#rawExpected : `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
		return format(this.#config?.expected, this.#context(fallback, actual), fallback);
	}

	/** Short description of the received value, e.g. `"a number"` or `"missing"`. */
	get actual(): string {
		const actual = describeValue(this.data, this.#config?.preserveActual ? "predicate" : this.code);
		const override = this.#config?.actual;
		return typeof override === "function" ? override(this.data) : (override ?? actual);
	}

	/** Path-less problem statement: `must be <expected> (was <actual>)`. */
	get problem(): string {
		const expected = this.expected;
		const actual = this.actual;
		const fallback =
			this.data === MISSING
				? `must be ${expected} (was missing)`
				: actual === ""
					? `must be ${expected}`
					: `must be ${expected} (was ${actual})`;
		return format(this.#config?.problem, this.#context(expected, actual, fallback), fallback);
	}
	get message(): string {
		const expected = this.expected;
		const actual = this.actual;
		const problem = this.problem;
		const at = this.path.length === 0 ? "" : `${formatPath(this.path)} `;
		const messageActual = this.#config?.actual === undefined ? describeKind(this.data) : actual;
		return format(this.#config?.message, this.#context(expected, messageActual, problem), `${at}${problem}`);
	}

	toString(): string {
		return this.message;
	}
}

/** Sentinel for a required key that was absent (distinguishes from `undefined`). */
export const MISSING: unique symbol = Symbol("omptype.missing");
function stringifyValue(data: object): string {
	const seen = new WeakSet<object>();
	return (
		JSON.stringify(data, (_key, value: unknown) => {
			if (typeof value !== "object" || value === null) return value;
			if (seen.has(value)) return "(cycle)";
			seen.add(value);
			return value;
		}) ?? "an object"
	);
}

function describeValue(data: unknown, code: string): string {
	if (data === MISSING) return "missing";
	if (code === "undeclared") return "";
	if (code === "referenceSame") return "";
	if (code === "domain") return describeKind(data);
	if (data === null) return "null";
	if (Array.isArray(data)) return "an array";
	switch (typeof data) {
		case "string":
			return data.length <= 40 ? JSON.stringify(data) : `a string (length ${data.length})`;
		case "number":
			return String(data);
		case "bigint":
			return `${data}n`;
		case "boolean":
			return String(data);
		case "undefined":
			return "undefined";
		case "object":
			return stringifyValue(data);
		case "function":
			return "a function";
		default:
			return "a symbol";
	}
}

function describeKind(data: unknown): string {
	if (data === MISSING) return "missing";
	if (typeof data === "number" && Number.isNaN(data)) return "NaN";
	if (data === null) return "null";
	if (Array.isArray(data)) return "an object";
	switch (typeof data) {
		case "string":
			return "a string";
		case "number":
			return "a number";
		case "bigint":
			return "a bigint";
		case "boolean":
			return "boolean";
		case "undefined":
			return "undefined";
		case "object": {
			const ctor = Object.getPrototypeOf(data)?.constructor;
			return typeof ctor?.name === "string" && ctor.name !== "Object" ? ctor.name : "an object";
		}
		case "function":
			return "a function";
		default:
			return "a symbol";
	}
}

function describeExpectation(expected: string): { description: string; rule?: unknown } {
	const divisor = /divisible by (\d+(?:\.\d+)?)/.exec(expected);
	if (divisor) {
		const rule = Number(divisor[1]);
		return { description: rule === 2 ? "even" : `divisible by ${rule}`, rule };
	}
	return { description: expected.replace(/^(?:an?|the) /, "") };
}

function formatPath(path: readonly PropertyKey[]): string {
	let out = "";
	for (const key of path) {
		if (typeof key === "number") out += `[${key}]`;
		else if (typeof key === "symbol") out += `[${String(key)}]`;
		else out += out.length === 0 ? key : `.${key}`;
	}
	return out;
}

function errorCode(expected: string, data: unknown): string {
	if (data === MISSING) return "required";
	if (expected === "removed") return "undeclared";
	if (expected.includes("serialized to the same value")) return "referenceSame";
	if (expected.includes("divisible by") || expected.includes("integer")) return "divisor";
	if (
		expected === "true" ||
		expected === "false" ||
		expected === "null" ||
		expected === "undefined" ||
		expected === "NaN" ||
		expected === "Infinity" ||
		expected === "-Infinity" ||
		/^-?\d+(?:\.\d+)?n?$/.test(expected) ||
		(expected.includes(" or ") &&
			expected.split(" or ").every(part => /^".*"$|^-?\d+(?:\.\d+)?n?$|^(?:true|false|null|undefined)$/.test(part)))
	) {
		return "unit";
	}
	if (
		expected.includes("at least") ||
		expected.includes("more than") ||
		expected.includes("timestamp after") ||
		expected === "non-negative" ||
		expected === "positive"
	) {
		return "min";
	}
	if (
		expected.includes("at most") ||
		expected.includes("less than") ||
		expected.includes("timestamp before") ||
		expected === "non-positive" ||
		expected === "negative"
	) {
		return "max";
	}
	if (
		expected.includes("matching") ||
		expected.includes("format") ||
		expected.includes("email") ||
		expected.includes("parsable") ||
		expected.includes("only digits")
	) {
		return "pattern";
	}
	if (expected.includes("predicate") || expected.includes("satisfying") || expected.includes("according to"))
		return "predicate";
	if (expected.startsWith('"') || expected.startsWith("the date ")) return "unit";
	if (expected === "an Error" || expected === "a Date" || expected.startsWith("an instance of ")) return "domain";
	if (
		(expected.includes(" or ") && !expected.includes("IPv")) ||
		expected.endsWith(" instance") ||
		expected.startsWith("a number representing") ||
		[
			"a string",
			"a number",
			"a bigint",
			"a symbol",
			"boolean",
			"an object",
			"an array",
			"a tuple",
			"undefined",
			"null",
			"unknown",
			"never",
		].includes(expected)
	)
		return "domain";
	return "predicate";
}

/**
 * Validation failure result. The common single-error case remains lazy;
 * traversal only materializes an entry array when a second error is appended.
 */
type StoredPath = PropertyKey[] | PropertyKey | undefined;

export class OmpErrors implements Iterable<OmpError> {
	#path: StoredPath;
	#expected: string;
	#data: unknown;
	#entry: OmpError | undefined;
	#entries: OmpError[] | undefined;
	#config: ErrorConfig | undefined;
	#separator = "\n";

	constructor(path: StoredPath, expected: string, data: unknown, config?: ErrorConfig) {
		this.#path = path;
		this.#expected = expected;
		this.#data = data;
		this.#config = config;
	}

	get length(): number {
		return this.#entries?.length ?? 1;
	}

	get 0(): OmpError {
		return this.#entries?.[0] ?? this.#getEntry();
	}

	static single(path: PropertyKey[], expected: string, data: unknown, config?: ErrorConfig): OmpErrors {
		return new OmpErrors(path, expected, data, config);
	}

	#getEntry(): OmpError {
		if (this.#entry) return this.#entry;
		const path = this.#path === undefined ? [] : Array.isArray(this.#path) ? [...this.#path] : [this.#path];
		const entry = new OmpError(path, this.#expected, this.#data, this.#config);
		this.#entry = entry;
		return entry;
	}

	/** Append all failures from `other`, preserving traversal order. */
	append(other: OmpErrors): this {
		this.#entries ??= [this.#getEntry()];
		const entries = this.#entries;
		for (const entry of other) entries.push(entry);
		return this;
	}

	/** Prefix every failure path with `key` when nesting sub-schemas. */
	prefix(key: PropertyKey): this {
		if (this.#entries) {
			for (const entry of this.#entries) entry.prefix(key);
		} else {
			const path = this.#path;
			this.#path = path === undefined ? [key] : Array.isArray(path) ? [key, ...path] : [key, path];
			this.#entry = undefined;
		}
		return this;
	}

	/** Apply schema-local message formatting without rebuilding failures. */
	configure(config: ErrorConfig): this {
		if (this.#entries) {
			for (const entry of this.#entries) entry.configure(config);
		} else {
			this.#config = { ...this.#config, ...config };
			this.#entry = undefined;
		}
		return this;
	}

	get byPath(): Readonly<Record<string, OmpError>> {
		const result: Record<string, OmpError> = {};
		for (const entry of this) result[entry.path.map(String).join(".")] = entry;
		return result;
	}

	map<result>(fn: (error: OmpError, index: number, errors: OmpErrors) => result): result[] {
		const result: result[] = [];
		let index = 0;
		for (const entry of this) result.push(fn(entry, index++, this));
		return result;
	}

	filter(fn: (error: OmpError, index: number, errors: OmpErrors) => unknown): OmpError[] {
		const result: OmpError[] = [];
		let index = 0;
		for (const entry of this) {
			if (fn(entry, index++, this)) result.push(entry);
		}
		return result;
	}

	*[Symbol.iterator](): IterableIterator<OmpError> {
		if (this.#entries) {
			yield* this.#entries;
		} else {
			yield this.#getEntry();
		}
	}

	/** @internal Render multiple branch failures as alternatives rather than independent failures. */
	asAlternatives(): this {
		this.#separator = " or ";
		return this;
	}
	get summary(): string {
		const entries = [...this];
		if (
			this.#separator === "\n" &&
			entries.length > 1 &&
			entries.every(
				entry =>
					Object.is(entry.data, entries[0].data) &&
					entry.path.length === entries[0].path.length &&
					entry.path.every((key, index) => key === entries[0].path[index]),
			)
		) {
			const at = formatPath(entries[0].path);
			const actual = typeof entries[0].data === "string" ? JSON.stringify(entries[0].data) : String(entries[0].data);
			return `${at}${at === "" ? "" : " "}(${actual}) must be...\n${entries.map(entry => `  ◦ ${entry.expected}`).join("\n")}`;
		}
		return entries.map(error => error.message).join(this.#separator);
	}

	toString(): string {
		return this.summary;
	}

	throw(): never {
		throw new TraversalError(this);
	}
}

/** Error thrown by `Type.assert` on invalid input. */
export class TraversalError extends Error {
	constructor(readonly errors: OmpErrors) {
		super(errors.summary);
		this.name = "TraversalError";
	}
}

/**
 * Definition/usage error thrown while building a schema — malformed string
 * DSL, unsupported composition, or an illegal builder call. Distinct from
 * validation failures, which are returned as {@link OmpErrors}.
 */
export class OmpTypeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OmpTypeError";
	}
}
