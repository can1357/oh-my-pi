/**
 * Settings registry: typed handles for every setting.
 *
 * A setting is declared once with {@link register}, next to the domain that uses it, and read through
 * its handle against a scope — a {@link Settings} instance or anything carrying one (an
 * `AgentSession`, a `ToolSession`). Values are cached per scope and recomputed only when the scope's
 * layers change, so reads are safe on hot paths. {@link Derived.map} and {@link combine} build
 * memoized derivations; {@link Derived.listen} observes changes of a handle or derivation.
 *
 * @example
 * // lsp/settings.ts
 * export const cfgLspDiagnosticsOnWrite = register({
 * 	id: "lsp.diagnosticsOnWrite",
 * 	type: "boolean",
 * 	default: true,
 * 	ui: { tab: "files", group: "LSP", label: "Diagnostics on Write", description: "…" },
 * });
 *
 * // consumer
 * if (cfgLspDiagnosticsOnWrite.get(session)) …
 * cfgLspDiagnosticsOnWrite.listen(session, enabled => …);
 *
 * Declaration order is significant: the settings panel lists a tab's settings in registration order
 * (sections follow `TAB_GROUPS`), and `config/all-settings.ts` imports every domain in that order.
 */
import { logger, parseFlag } from "@oh-my-pi/pi-utils";
import type { AnyUiMetadata, SubmenuOption, UiBase } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import type { SettingProvenance, Settings } from "./settings";

// ═══════════════════════════════════════════════════════════════════════════
// Definitions
// ═══════════════════════════════════════════════════════════════════════════

export interface UiBoolean extends UiBase {}

export interface UiEnum<T extends readonly string[]> extends UiBase {
	/** Submenu options. When omitted, the enum renders as an inline toggle derived from `values`. */
	options?: ReadonlyArray<SubmenuOption<T[number]>>;
}

export interface UiNumber extends UiBase {
	/** Submenu options. Without options, a numeric setting has no UI representation (intentional hide). */
	options?: ReadonlyArray<SubmenuOption>;
}

export interface UiString extends UiBase {
	/** Mask the value in both the settings row and text editor. */
	secret?: boolean;
	/**
	 * Submenu options.
	 *  - Array  → submenu with these choices.
	 *  - "runtime" → submenu populated by the runtime layer (theme registry, etc.).
	 *  - Omitted → renders as a free text input.
	 */
	options?: ReadonlyArray<SubmenuOption> | "runtime";
}

export interface UiArray extends UiBase {
	/** Membership choices. Without options, an array setting has no UI representation (config-file only). */
	options?: ReadonlyArray<SubmenuOption>;
	/** Selection order is meaningful; the editor renders positions and supports reordering. */
	ordered?: boolean;
}

/**
 * Environment variable that, when set, takes precedence over user settings layers but not the
 * machine-managed layer. Default parsing follows the setting's type: booleans follow `parseFlag`
 * (empty is unset; `1`, `y`, `true`, `yes`, `on`, all lower- or upper-case, are true; any other text
 * is false), numbers any finite number, enums a listed value, strings any non-blank text.
 */
export type SettingEnv<T> =
	| string
	| {
			name: string;
			/** Maps the raw variable to a value; `undefined` means "not set". Defaults to the type parser. */
			parse?: (raw: string) => T | undefined;
			/**
			 * The variable only replaces the default (env vars documented as fallbacks of a config key):
			 *  - `true`: any settings layer configuring a non-null value wins over it.
			 *  - `"blank"`: likewise, but a configured empty/whitespace string also yields to the variable.
			 */
			fallback?: true | "blank";
	  };

/** Protocol host that re-applies a setting's default instead of the user's persisted preference. */
export type ProtocolHost = "rpc" | "acp";

interface DefinitionBase {
	/** Dotted setting path as written in config files, e.g. `"lsp.diagnosticsOnWrite"`. */
	id: string;
	/**
	 * Marks a credential: never printed or exported without an explicit request. Drives both CLI
	 * redaction and settings-panel masking (together with `ui.secret`, see {@link Setting.isCredential}).
	 */
	credential?: true;
	/**
	 * Array entries may be objects scoping values to working-directory prefixes
	 * (`{ path(s)/pathPrefix(es), values | items | <valuesKey> }`, see `config/settings.ts`);
	 * `valuesKey` names the domain-specific alias for the values list (e.g. `models`).
	 */
	pathScoped?: { valuesKey: string };
	/**
	 * Protocol hosts (RPC/ACP embedders) that start from this setting's default rather than the local
	 * user's interactive preference: at startup the default is pinned as a runtime override unless
	 * the host configured a value itself (caller overrides, project settings, `--config`, global config).
	 */
	protocolDefault?: readonly ProtocolHost[];
	/**
	 * Rejects a malformed configured value with a descriptive error. Runs on every load/reload and
	 * before every write, so a typo fails loudly instead of silently reading as the default.
	 */
	validate?: (raw: unknown) => void;
	/**
	 * Canonicalizes a value on its way in — text parsed by {@link Setting.parse} and every
	 * `set`/`override` — e.g. flooring request limits. May throw like `validate`.
	 */
	normalize?: (value: unknown) => unknown;
}

export interface BooleanDefinition extends DefinitionBase {
	type: "boolean";
	default: boolean | undefined;
	env?: SettingEnv<boolean>;
	ui?: UiBoolean;
}

export interface StringDefinition extends DefinitionBase {
	type: "string";
	default: string | undefined;
	env?: SettingEnv<string>;
	ui?: UiString;
}

export interface NumberDefinition extends DefinitionBase {
	type: "number";
	default: number | undefined;
	env?: SettingEnv<number>;
	ui?: UiNumber;
}

export interface EnumDefinition<T extends readonly string[] = readonly string[]> extends DefinitionBase {
	type: "enum";
	values: T;
	default: T[number];
	env?: SettingEnv<T[number]>;
	ui?: UiEnum<T>;
}

export interface ArrayDefinition<T = unknown> extends DefinitionBase {
	type: "array";
	default: readonly T[];
	env?: SettingEnv<readonly T[]>;
	/**
	 * Closed vocabulary for the entries (`label` names one entry in messages, e.g. "status line
	 * segment"). Writes naming an unknown entry are rejected; configured values that already contain
	 * one load unchanged with a single warning per entry, so a retired id never breaks startup.
	 */
	items?: { values: readonly string[]; label: string };
	ui?: UiArray;
}

export interface RecordDefinition<T = unknown> extends DefinitionBase {
	type: "record";
	default: Readonly<Record<string, T>>;
	env?: SettingEnv<Readonly<Record<string, T>>>;
	ui?: UiBase;
}

/** Any setting definition accepted by {@link register}. */
export type SettingDefinition =
	| BooleanDefinition
	| StringDefinition
	| NumberDefinition
	| EnumDefinition
	| ArrayDefinition
	| RecordDefinition;

/** Value type a definition resolves to. */
export type DefinitionValue<D> = D extends { type: "boolean"; default: undefined }
	? boolean | undefined
	: D extends { type: "boolean" }
		? boolean
		: D extends { type: "string"; default: infer V }
			? undefined extends V
				? string | undefined
				: string
			: D extends { type: "number"; default: undefined }
				? number | undefined
				: D extends { type: "number" }
					? number
					: D extends { type: "enum"; values: infer V }
						? V extends readonly string[]
							? V[number]
							: never
						: D extends { type: "array" | "record"; default: infer V }
							? V
							: never;

// ═══════════════════════════════════════════════════════════════════════════
// Scopes
// ═══════════════════════════════════════════════════════════════════════════

/** Object carrying a settings instance, optionally owning the lifetime of listeners bound to it. */
export interface SettingsScope {
	readonly settings: Settings;
	/** Registers teardown to run when the scope ends (session dispose). */
	addDisposer?(dispose: () => void): void;
}

/** Anything a handle can be read against. */
export type ScopeLike = Settings | SettingsScope;

function settingsOf(scope: ScopeLike): Settings {
	return "settings" in scope ? scope.settings : scope;
}

// ═══════════════════════════════════════════════════════════════════════════
// Handles
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Memoized value of one handle/derivation within one settings instance, stored at
 * `Settings.valueCache[slot]` and updated in place on recompute.
 */
export interface ValueCacheEntry {
	revision: number;
	inputs: readonly unknown[];
	value: unknown;
}

/** Next {@link Derived.slot}; handles and derivations form a closed, module-level set. */
let nextSlot = 0;

/**
 * Read-only value computed from one or more settings. Reads are memoized per scope and recomputed
 * only when an input setting's effective value changes; derivation functions must be pure.
 */
export abstract class Derived<T> {
	/**
	 * Process-unique index of this handle/derivation: its entry in every `Settings.valueCache`,
	 * and for leaf settings its change-listener bucket.
	 */
	readonly slot = nextSlot++;

	/** Leaf settings this value depends on (change notifications subscribe to these). */
	abstract get sources(): readonly AnySetting[];

	/**
	 * Registry plumbing: current input values for `settings`; the derivation recomputes only when
	 * one changes identity. Read values through {@link get}.
	 */
	abstract inputs(settings: Settings): readonly unknown[];

	/** Registry plumbing: computes the value from `inputs` (as returned by {@link inputs}). */
	abstract compute(inputs: readonly unknown[], settings: Settings): T;

	/** Latest value in `scope`. */
	get(scope: ScopeLike): T {
		const settings = settingsOf(scope);
		const revision = settings.revision;
		const cached = settings.valueCache[this.slot];
		if (cached?.revision === revision) return cached.value as T;
		const inputs = this.inputs(settings);
		if (!cached) {
			const value = this.compute(inputs, settings);
			settings.valueCache[this.slot] = { revision, inputs, value };
			return value;
		}
		if (!sameInputs(cached.inputs, inputs)) {
			const value = this.compute(inputs, settings);
			// Keep identity stable across equal recomputations so downstream derivations and
			// listeners comparing by identity don't churn on unrelated layer rebuilds.
			if (!settingValuesEqual(cached.value, value)) cached.value = value;
			cached.inputs = inputs;
		}
		cached.revision = revision;
		return cached.value as T;
	}

	/** Derives a memoized value from this one. */
	map<U>(fn: (value: T) => U): Derived<U> {
		return new MappedValue(this, fn);
	}

	/**
	 * Calls `onChange(next, previous)` whenever this value changes in `scope`, coalesced per microtask
	 * so a bulk reload touching several inputs fires once. When `scope` owns a lifetime
	 * ({@link SettingsScope.addDisposer}, e.g. an `AgentSession`), the listener is removed with it.
	 * Errors and rejections are logged, never thrown. Returns an unsubscribe function.
	 */
	listen(scope: ScopeLike, onChange: (value: T, previous: T) => void | Promise<void>): () => void {
		const settings = settingsOf(scope);
		const sources = this.sources;
		const run = (next: T, previous: T) => {
			try {
				const result = onChange(next, previous);
				if (result instanceof Promise) result.catch(error => reportListenerError(sources, error));
			} catch (error) {
				reportListenerError(sources, error);
			}
		};
		let current = this.get(settings);
		let queued = false;
		let active = true;
		const stop = settings.onEffectiveChange(sources, () => {
			if (queued) return;
			queued = true;
			// One recompute per microtask, however many inputs a bulk reload touched.
			queueMicrotask(() => {
				queued = false;
				if (!active) return;
				const next = this.get(settings);
				if (settingValuesEqual(next, current)) return;
				const previous = current;
				current = next;
				run(next, previous);
			});
		});
		const unsubscribe = () => {
			active = false;
			stop();
		};
		if ("settings" in scope) scope.addDisposer?.(unsubscribe);
		return unsubscribe;
	}
}

/**
 * Deep equality of setting values that, unlike `Bun.deepEquals`, also compares the key order of
 * plain objects: record order carries precedence (`edit.modelVariants` takes the first match), so a
 * reorder is a change. Values other than plain objects and arrays compare with `Bun.deepEquals`.
 */
export function settingValuesEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (isArray(a) && isArray(b)) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!settingValuesEqual(a[i], b[i])) return false;
		return true;
	}
	if (!isPlainObject(a) || !isPlainObject(b)) return Bun.deepEquals(a, b);
	// Positional key comparison needs `b`'s keys materialized; `a` streams.
	const otherKeys = Object.keys(b);
	let index = 0;
	for (const key in a) {
		if (key !== otherKeys[index++] || !settingValuesEqual(a[key], b[key])) return false;
	}
	return index === otherKeys.length;
}

function isArray(value: unknown): value is readonly unknown[] {
	return Array.isArray(value);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
	return true;
}

function reportListenerError(sources: readonly AnySetting[], error: unknown): void {
	logger.warn("Settings: listener failed", {
		settings: sources.map(source => source.id).join(","),
		error: String(error),
	});
}

class MappedValue<S, T> extends Derived<T> {
	readonly #source: Derived<S>;
	readonly #fn: (value: S) => T;

	constructor(source: Derived<S>, fn: (value: S) => T) {
		super();
		this.#source = source;
		this.#fn = fn;
	}

	get sources(): readonly AnySetting[] {
		return this.#source.sources;
	}

	inputs(settings: Settings): readonly unknown[] {
		return [this.#source.get(settings)];
	}

	compute(inputs: readonly unknown[]): T {
		return this.#fn(inputs[0] as S);
	}
}

/** Value types of a record of derivations. */
export type DerivedValues<R extends Record<string, Derived<unknown>>> = {
	[K in keyof R]: R[K] extends Derived<infer V> ? V : never;
};

class CombinedValue<R extends Record<string, Derived<unknown>>, T> extends Derived<T> {
	readonly #keys: (keyof R & string)[];
	readonly #parts: Derived<unknown>[];
	readonly #fn: (values: DerivedValues<R>) => T;
	readonly #sources: readonly AnySetting[];

	constructor(parts: R, fn: (values: DerivedValues<R>) => T) {
		super();
		this.#keys = Object.keys(parts);
		this.#parts = this.#keys.map(key => parts[key]);
		this.#fn = fn;
		this.#sources = [...new Set(this.#parts.flatMap(part => part.sources))];
	}

	get sources(): readonly AnySetting[] {
		return this.#sources;
	}

	inputs(settings: Settings): readonly unknown[] {
		return this.#parts.map(part => part.get(settings));
	}

	compute(inputs: readonly unknown[]): T {
		const values: Record<string, unknown> = {};
		for (let i = 0; i < this.#keys.length; i++) values[this.#keys[i]] = inputs[i];
		return this.#fn(values as DerivedValues<R>);
	}
}

/**
 * Combines several handles/derivations into one memoized value.
 *
 * @example
 * const cfgLspWritethrough = combine(
 * 	{ format: cfgLspFormatOnWrite, diagnostics: cfgLspDiagnosticsOnWrite },
 * 	({ format, diagnostics }) => (format || diagnostics ? { format, diagnostics } : undefined),
 * );
 */
export function combine<R extends Record<string, Derived<unknown>>>(parts: R): Derived<DerivedValues<R>>;
export function combine<R extends Record<string, Derived<unknown>>, T>(
	parts: R,
	fn: (values: DerivedValues<R>) => T,
): Derived<T>;
export function combine<R extends Record<string, Derived<unknown>>, T>(
	parts: R,
	fn?: (values: DerivedValues<R>) => T,
): Derived<T | DerivedValues<R>> {
	return fn ? new CombinedValue(parts, fn) : new CombinedValue(parts, values => values);
}

/**
 * Handle for one registered setting. Reads resolve, in precedence order: machine policy,
 * the definition's environment variable, runtime override, `--config` overlay, project,
 * global, then the default.
 */
export class Setting<T, Id extends string = string> extends Derived<T> {
	readonly id: Id;
	/** {@link id} split into its dotted path, as addressed within a settings layer. */
	readonly segments: readonly string[];
	readonly definition: SettingDefinition;
	readonly #sources: readonly AnySetting[];
	/** Environment variable supplying this value, if declared (see {@link SettingEnv}). */
	readonly envName: string | undefined;
	/** How {@link envName} yields to configured layers: `false` = it overrides them (see {@link SettingEnv}). */
	readonly envFallback: boolean | "blank";
	readonly #parseEnv: ((raw: string) => unknown) | undefined;
	/** Last raw environment text parsed, and its result: the variable is parsed once per distinct value. */
	#envRaw: string | undefined;
	#envParsed: T | undefined;

	constructor(definition: SettingDefinition & { id: Id }) {
		super();
		this.id = definition.id;
		this.segments = definition.id.split(".");
		this.definition = definition;
		this.#sources = [this];
		const env = definition.env;
		this.envName = typeof env === "string" ? env : env?.name;
		this.#parseEnv =
			typeof env === "object" && env.parse ? env.parse : env ? raw => this.#parseEnvText(raw) : undefined;
		this.envFallback = typeof env === "object" ? (env.fallback ?? false) : false;
	}

	get sources(): readonly AnySetting[] {
		return this.#sources;
	}

	/** Fresh copy of the default value (arrays/records are cloned so callers may mutate). */
	get default(): T {
		const value = this.definition.default;
		return (typeof value === "object" && value !== null ? structuredClone(value) : value) as T;
	}

	/** Declared value kind. */
	get type(): SettingDefinition["type"] {
		return this.definition.type;
	}

	/** Allowed values for enum settings. */
	get enumValues(): readonly string[] | undefined {
		return this.definition.type === "enum" ? this.definition.values : undefined;
	}

	/** Settings-panel metadata; `undefined` for config-file-only settings. */
	get ui(): AnyUiMetadata | undefined {
		return this.definition.ui as AnyUiMetadata | undefined;
	}

	/** Whether the value is a credential (explicit marker or legacy `ui.secret`). */
	get isCredential(): boolean {
		return this.definition.credential === true || this.ui?.secret === true;
	}

	/** Value supplied by the environment variable, or `undefined` when unset or unparseable. */
	envValue(): T | undefined {
		if (!this.envName || !this.#parseEnv) return undefined;
		const raw = Bun.env[this.envName];
		if (raw === undefined) return undefined;
		if (raw !== this.#envRaw) {
			this.#envParsed = this.#parseEnv(raw) as T | undefined;
			this.#envRaw = raw;
		}
		return this.#envParsed;
	}

	/** Env value that currently takes effect in `scope`: a fallback env yields to a configured layer. */
	#effectiveEnv(scope: ScopeLike): T | undefined {
		const value = this.envValue();
		if (value === undefined || !this.envFallback) return value;
		const settings = settingsOf(scope);
		if (this.envFallback === true) return settings.isConfigured(this) ? undefined : value;
		const configured = settings.rawValue(this);
		return configured === undefined || (typeof configured === "string" && configured.trim() === "")
			? value
			: undefined;
	}

	override get(scope: ScopeLike): T {
		const settings = settingsOf(scope);
		// Environment variables cannot override managed (machine policy) settings
		if (settings.getProvenance(this) === "managed") return super.get(scope);
		return this.#effectiveEnv(scope) ?? super.get(scope);
	}

	/**
	 * Value from the settings layers alone (runtime, `--config` overlay, project, global, default),
	 * ignoring the environment variable — what the settings panel shows and edits.
	 */
	layered(scope: ScopeLike): T {
		return super.get(scope);
	}

	/**
	 * Parses user- or agent-supplied text (`omp config set`, `write cfg://…`) into a value of this
	 * setting's type. Booleans accept true/false, yes/no, on/off, 1/0; arrays and records take JSON;
	 * strings and enums accept bare text or a JSON-quoted string.
	 *
	 * @throws Error when the text does not fit the type or enum values.
	 */
	parse(text: string): T {
		const value = this.#parseText(text);
		return (this.definition.normalize ? this.definition.normalize(value) : value) as T;
	}

	#parseText(text: string): T {
		const trimmed = text.trim();
		switch (this.definition.type) {
			case "boolean": {
				const lower = trimmed.toLowerCase();
				if (["true", "1", "yes", "on"].includes(lower)) return true as T;
				if (["false", "0", "no", "off"].includes(lower)) return false as T;
				throw new Error(`Invalid boolean value: ${text}. Use true/false, yes/no, on/off, or 1/0`);
			}
			case "number": {
				const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
				if (!Number.isFinite(parsed)) throw new Error(`Invalid number: ${text}`);
				return parsed as T;
			}
			case "array":
			case "record": {
				let parsed: unknown;
				try {
					parsed = JSON.parse(trimmed);
				} catch {
					throw new Error(`Invalid ${this.definition.type} JSON: ${text}`);
				}
				if (!this.accepts(parsed)) throw new Error(`Invalid ${this.definition.type} JSON: ${text}`);
				return parsed as T;
			}
			case "string":
			case "enum": {
				let value = trimmed;
				if (value.startsWith('"')) {
					try {
						const unquoted: unknown = JSON.parse(value);
						if (typeof unquoted === "string") value = unquoted;
					} catch {
						// Not a JSON string literal; keep the bare text.
					}
				}
				const valid = this.enumValues;
				if (valid && !valid.includes(value)) {
					throw new Error(`Invalid value: ${text}. Valid values: ${valid.join(", ")}`);
				}
				return value as T;
			}
		}
	}

	/** Whether `value` fits this setting's declared type (and enum values). */
	accepts(value: unknown): boolean {
		switch (this.definition.type) {
			case "boolean":
				return typeof value === "boolean";
			case "number":
				return typeof value === "number" && Number.isFinite(value);
			case "string":
				return typeof value === "string";
			case "enum":
				return typeof value === "string" && this.definition.values.includes(value);
			case "array":
				return Array.isArray(value);
			case "record":
				return typeof value === "object" && value !== null && !Array.isArray(value);
		}
	}

	#parseEnvText(raw: string): unknown {
		if (this.definition.type === "boolean") return raw === "" ? undefined : parseFlag(raw);
		if (raw.trim() === "") return undefined;
		try {
			return this.parse(raw);
		} catch {
			return undefined;
		}
	}

	inputs(settings: Settings): readonly unknown[] {
		return [settings.rawValue(this)];
	}

	compute(inputs: readonly unknown[], settings: Settings): T {
		const raw = inputs[0];
		if (raw === undefined || this.accepts(raw)) {
			// A fixed value re-arms this instance's warning, so breaking it again is reported again.
			settings.warnState.invalid.delete(this.id);
			return raw === undefined ? this.default : (raw as T);
		}
		const warned = settings.warnState.invalid;
		if (!warned.has(this.id) || !Bun.deepEquals(warned.get(this.id), raw)) {
			warned.set(this.id, raw);
			logger.warn("Settings: ignoring invalid value, using the default", { setting: this.id, value: raw });
		}
		return this.default;
	}

	/**
	 * Registry plumbing run by `Settings` before every write (handle writes and constructor overrides).
	 *
	 * @throws Error when `value` names an entry outside {@link ArrayDefinition.items}, fails `validate`
	 * (checked first for their specific messages), or does not fit the declared type ({@link accepts}).
	 */
	assertWritable(value: unknown): void {
		const unknown = this.#unknownItems(value);
		if (unknown.length > 0 && this.definition.type === "array" && this.definition.items) {
			const { values, label } = this.definition.items;
			const noun = unknown.length === 1 ? label : `${label}s`;
			throw new Error(`Unknown ${noun}: ${unknown.join(", ")}. Valid ${label}s: ${values.join(", ")}`);
		}
		this.definition.validate?.(value);
		if (!this.accepts(value)) {
			const expected = this.enumValues ? `one of ${this.enumValues.join(", ")}` : `a ${this.definition.type}`;
			throw new Error(`Invalid value for ${this.id}: ${Bun.inspect(value)} (expected ${expected})`);
		}
	}

	/**
	 * Registry plumbing run by `Settings` on every load/reload for the value `settings` configures.
	 *
	 * @throws Error when `raw` fails `validate`. Unknown {@link ArrayDefinition.items} entries only warn,
	 * once each per instance.
	 */
	checkConfigured(settings: Settings, raw: unknown): void {
		this.definition.validate?.(raw);
		const unknown = this.#unknownItems(raw);
		const items = settings.warnState.items;
		let warned = items.get(this.id);
		// Entries no longer configured re-arm, so adding one back is reported again.
		for (const entry of warned ?? []) if (!unknown.includes(entry)) warned?.delete(entry);
		if (unknown.length === 0) return;
		if (!warned) {
			warned = new Set();
			items.set(this.id, warned);
		}
		const label = this.definition.type === "array" ? this.definition.items?.label : undefined;
		for (const entry of unknown) {
			if (warned.has(entry)) continue;
			warned.add(entry);
			logger.warn(`Settings: unknown ${label} ${entry}`, { setting: this.id });
		}
	}

	/** Entries of `value` outside the declared {@link ArrayDefinition.items}, formatted for messages. */
	#unknownItems(value: unknown): string[] {
		const items = this.definition.type === "array" ? this.definition.items : undefined;
		if (!items || !Array.isArray(value)) return [];
		const unknown = new Set<string>();
		for (const entry of value) {
			if (!items.values.includes(entry))
				unknown.add(typeof entry === "string" ? JSON.stringify(entry) : String(entry));
		}
		return [...unknown];
	}

	/**
	 * Persists `value` to the global config; `undefined` removes the key ({@link unset}).
	 *
	 * @throws Error when the value does not fit the definition (see {@link assertWritable}).
	 */
	set(scope: ScopeLike, value: T): void {
		if (value === undefined) settingsOf(scope).unsetGlobalValue(this);
		else settingsOf(scope).writeValue(this, this.#normalize(value), "global");
	}

	/**
	 * Runtime-only override (not persisted); `undefined` removes it ({@link clearOverride}).
	 *
	 * @throws Error when the value does not fit the definition (see {@link assertWritable}).
	 */
	override(scope: ScopeLike, value: T): void {
		if (value === undefined) settingsOf(scope).clearOverrideValue(this);
		else settingsOf(scope).writeValue(this, this.#normalize(value), "override");
	}

	/**
	 * Removes the key from the persisted global config: any other layer or environment variable that
	 * configures this setting still applies, otherwise the default.
	 */
	unset(scope: ScopeLike): void {
		settingsOf(scope).unsetGlobalValue(this);
	}

	/**
	 * Holds the default as a runtime override only while no persisted layer — global, project,
	 * `--config` overlay — configures this setting; no-op when the environment or any layer already
	 * configures it, and dropped by a {@link set}/{@link unset} of this setting or when a reload or
	 * re-scope configures it (protocol-host defaults).
	 */
	pinDefault(scope: ScopeLike): void {
		if (this.envValue() === undefined) settingsOf(scope).pinDefaultValue(this);
	}

	#normalize(value: T): unknown {
		return this.definition.normalize ? this.definition.normalize(value) : value;
	}

	/** Removes a runtime override, restoring the persisted/default value. */
	clearOverride(scope: ScopeLike): void {
		settingsOf(scope).clearOverrideValue(this);
	}

	/** Whether the environment or any settings layer (runtime, overlay, project, global) sets this value. */
	isConfigured(scope: ScopeLike): boolean {
		return this.envValue() !== undefined || settingsOf(scope).isConfigured(this);
	}

	/** Layer supplying the effective value. */
	provenance(scope: ScopeLike): SettingProvenance {
		const layeredProvenance = settingsOf(scope).getProvenance(this);
		// If value comes from managed layer, it cannot be overridden by env
		if (layeredProvenance === "managed") return "managed";
		// Otherwise, env can override if set
		return this.#effectiveEnv(scope) !== undefined ? "env" : layeredProvenance;
	}
}

/** Value type of a handle or derivation. */
export type SettingValueOf<H> = H extends Derived<infer T> ? T : never;
/** Handle of any registered setting (runtime/string-keyed surfaces: UI, CLI, `cfg://`). */
export type AnySetting = Setting<unknown>;

// ═══════════════════════════════════════════════════════════════════════════
// Registry
// ═══════════════════════════════════════════════════════════════════════════

const byId = new Map<string, AnySetting>();
const ordered: AnySetting[] = [];

/**
 * Declares a setting and returns its typed handle.
 *
 * @throws Error when `id` is already registered.
 */
export function register<const D extends SettingDefinition>(definition: D): Setting<DefinitionValue<D>, D["id"]> {
	if (byId.has(definition.id)) throw new Error(`Setting "${definition.id}" is registered twice`);
	const handle = new Setting<DefinitionValue<D>, D["id"]>(definition);
	byId.set(definition.id, handle as AnySetting);
	ordered.push(handle as AnySetting);
	return handle;
}

/** Handle for `id`, or `undefined` when no setting has that id. */
export function lookup(id: string): AnySetting | undefined {
	return byId.get(id);
}

/** Every registered setting, in declaration order. */
export function all(): readonly AnySetting[] {
	return ordered;
}

// ═══════════════════════════════════════════════════════════════════════════
// Warn-once diagnostics
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Warn-once diagnostics of one settings instance, stored at `Settings.warnState`: each is re-armed
 * only by that instance's own values, so instances reading different values never re-trigger each other.
 */
export interface WarnState {
	/** Invalid configured value each setting (by id) last warned about; re-armed once the value is fixed. */
	readonly invalid: Map<string, unknown>;
	/** Unknown `items` entries each setting (by id) warned about that are still configured. */
	readonly items: Map<string, Set<string>>;
}

/**
 * Registry plumbing run by `Settings` when it derives `target` from `source` (overlays, cwd clones):
 * `target` takes over `source`'s warn-once diagnostics, so the values it inherits are not reported again.
 */
export function inheritWarnings(target: Settings, source: Settings): void {
	const { invalid, items } = target.warnState;
	invalid.clear();
	items.clear();
	for (const [id, value] of source.warnState.invalid) invalid.set(id, value);
	for (const [id, entries] of source.warnState.items) items.set(id, new Set(entries));
}

// ═══════════════════════════════════════════════════════════════════════════
// Process-wide effects
// ═══════════════════════════════════════════════════════════════════════════

interface EffectEntry {
	/** Subscribes the effect to `settings`, applying the current value right away; returns the unsubscribe. */
	bind(settings: Settings): () => void;
	/** Applies the value `defaults` yields when the process last applied a different one (test reset). */
	reset(defaults: Settings): void;
}

interface EffectBinding {
	settings: Settings;
	stops: Map<EffectEntry, () => void>;
}

const effects = new Set<EffectEntry>();
/** Outstanding {@link bindEffects} holds, oldest first; the last one drives effects. */
const effectHolds: { settings: Settings }[] = [];
let effectBinding: EffectBinding | undefined;

/**
 * Declares a process-wide side effect of a setting (theme, credential redaction, request limits…).
 * It follows the settings instance bound with {@link bindEffects}: applied immediately on bind and
 * on every change. Unlike {@link Derived.listen}, application is synchronous — it lands inside the
 * write or reload that caused it, so code reading the affected process state right after
 * `set`/`override` sees the new value. Errors and rejections are logged, never thrown. Subagent
 * overlays and isolated instances never drive effects. Returns a function removing the effect
 * (module-level declarations never call it; test-scoped effects do).
 */
export function effect<T>(value: Derived<T>, apply: (value: T) => void | Promise<void>): () => void {
	let applied: { value: T } | undefined;
	const run = (next: T) => {
		applied = { value: next };
		try {
			const result = apply(next);
			if (result instanceof Promise) result.catch(error => reportListenerError(value.sources, error));
		} catch (error) {
			reportListenerError(value.sources, error);
		}
	};
	const entry: EffectEntry = {
		bind: settings => {
			let current = value.get(settings);
			const unsubscribe = settings.onEffectiveChange(value.sources, () => {
				const next = value.get(settings);
				if (settingValuesEqual(next, current)) return;
				current = next;
				run(next);
			});
			run(current);
			return unsubscribe;
		},
		reset: defaults => {
			if (!applied) return;
			const next = value.get(defaults);
			if (!settingValuesEqual(next, applied.value)) run(next);
		},
	};
	effects.add(entry);
	effectBinding?.stops.set(entry, entry.bind(effectBinding.settings));
	return () => {
		effects.delete(entry);
		effectBinding?.stops.get(entry)?.();
		effectBinding?.stops.delete(entry);
	};
}

/**
 * Makes `settings` drive every {@link effect} (the process-global instance, the top-level session's
 * settings in SDK embeddings, an ACP session's workspace settings) until the returned release is
 * called. Holds stack: the most recent outstanding hold drives effects, and releasing it hands them
 * back to the previous hold (re-applying its values). Holding the same instance twice takes two
 * holds; the release is idempotent and never ends another holder's hold.
 */
export function bindEffects(settings: Settings): () => void {
	const hold = { settings };
	effectHolds.push(hold);
	syncEffectBinding();
	return () => {
		const index = effectHolds.indexOf(hold);
		if (index === -1) return;
		effectHolds.splice(index, 1);
		syncEffectBinding();
	};
}

/** Points effects at the newest hold's instance, re-subscribing only when that instance changed. */
function syncEffectBinding(): void {
	const settings = effectHolds.at(-1)?.settings;
	if (effectBinding?.settings === settings) return;
	stopEffectBinding();
	if (!settings) return;
	const binding: EffectBinding = { settings, stops: new Map() };
	effectBinding = binding;
	// An effect declared while binding binds itself (see `effect`); the guard skips it here.
	for (const entry of effects) {
		if (!binding.stops.has(entry)) binding.stops.set(entry, entry.bind(settings));
	}
}

function stopEffectBinding(): void {
	const binding = effectBinding;
	effectBinding = undefined;
	for (const stop of binding?.stops.values() ?? []) stop();
}

/** Instance currently driving effects, if any. */
export function effectsSettings(): Settings | undefined {
	return effectBinding?.settings;
}

/** Drops every {@link bindEffects} hold, so no instance drives effects (test teardown). */
export function unbindEffects(): void {
	effectHolds.length = 0;
	stopEffectBinding();
}

/**
 * Test reset: drops every effect hold and re-applies each effect whose last applied value differs
 * from the one `defaults` yields (restoring process state an earlier test changed).
 */
export function resetRegistryForTest(defaults: Settings): void {
	unbindEffects();
	for (const entry of effects) entry.reset(defaults);
}
