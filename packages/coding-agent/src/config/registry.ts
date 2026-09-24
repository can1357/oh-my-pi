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
import { logger } from "@oh-my-pi/pi-utils";
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
 * Environment variable that, when set, takes precedence over every settings layer. Default parsing
 * follows the setting's type: booleans accept `1/true/yes/on` and `0/false/no/off`, numbers any
 * finite number, enums a listed value, strings any non-blank text; other text counts as unset.
 */
export type SettingEnv<T> =
	| string
	| {
			name: string;
			/** Maps the raw variable to a value; `undefined` means "not set". Defaults to the type parser. */
			parse?: (raw: string) => T | undefined;
			/**
			 * The variable only replaces the default: any settings layer that configures the value wins
			 * over it (for env vars documented as fallbacks of a config key).
			 */
			fallback?: true;
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
		: D extends { type: "string" }
			? string | undefined
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

/** Layer a handle write targets: persisted global config, or a runtime-only override. */
export type SettingLayer = "global" | "override";

// ═══════════════════════════════════════════════════════════════════════════
// Handles
// ═══════════════════════════════════════════════════════════════════════════

/** Memoized value of one handle/derivation within one settings instance (see `Settings.valueCache`). */
export interface ValueCacheEntry {
	revision: number;
	inputs: readonly unknown[];
	value: unknown;
}

/** Options for {@link Derived.listen}. */
export interface ListenOptions<T> {
	/** Also invoke the callback once, synchronously, with the current value (as both `value` and `previous`). */
	immediate?: boolean;
	/** Change detection; defaults to `Bun.deepEquals`. */
	equals?: (a: T, b: T) => boolean;
}

/**
 * Read-only value computed from one or more settings. Reads are memoized per scope and recomputed
 * only when an input setting's effective value changes; derivation functions must be pure.
 */
export abstract class Derived<T> {
	/** Leaf settings this value depends on (change notifications subscribe to these ids). */
	abstract get sources(): readonly AnySetting[];

	/** Current input values for `settings`; the derivation recomputes only when one changes identity. */
	protected abstract inputs(settings: Settings): readonly unknown[];

	/** Computes the value from `inputs` (as returned by {@link inputs}). */
	protected abstract compute(inputs: readonly unknown[], settings: Settings): T;

	/** Latest value in `scope`. */
	get(scope: ScopeLike): T {
		const settings = settingsOf(scope);
		const revision = settings.revision;
		const cached = settings.valueCache.get(this);
		if (cached?.revision === revision) return cached.value as T;
		const inputs = this.inputs(settings);
		if (cached && sameInputs(cached.inputs, inputs)) {
			cached.revision = revision;
			return cached.value as T;
		}
		let value: unknown = this.compute(inputs, settings);
		// Keep identity stable across equal recomputations so downstream derivations and
		// listeners comparing by identity don't churn on unrelated layer rebuilds.
		if (cached && typeof value === "object" && value !== null && Bun.deepEquals(cached.value, value)) {
			value = cached.value;
		}
		settings.valueCache.set(this, { revision, inputs, value });
		return value as T;
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
	listen(
		scope: ScopeLike,
		onChange: (value: T, previous: T) => void | Promise<void>,
		options?: ListenOptions<T>,
	): () => void {
		const settings = settingsOf(scope);
		const equals = options?.equals ?? ((a: T, b: T) => Bun.deepEquals(a, b));
		const ids = this.sources.map(source => source.id);
		const inputs = new Set(ids);
		const run = (next: T, previous: T) => {
			try {
				const result = onChange(next, previous);
				if (result instanceof Promise) result.catch(error => reportListenerError(ids, error));
			} catch (error) {
				reportListenerError(ids, error);
			}
		};
		let current = this.get(settings);
		let queued = false;
		let active = true;
		const stop = settings.onEffectiveChange(path => {
			if (queued || !inputs.has(path)) return;
			queued = true;
			// One recompute per microtask, however many inputs a bulk reload touched.
			queueMicrotask(() => {
				queued = false;
				if (!active) return;
				const next = this.get(settings);
				if (equals(next, current)) return;
				const previous = current;
				current = next;
				run(next, previous);
			});
		});
		const unsubscribe = () => {
			active = false;
			stop();
		};
		if (options?.immediate) run(current, current);
		if ("settings" in scope) scope.addDisposer?.(unsubscribe);
		return unsubscribe;
	}
}

function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
	return true;
}

function reportListenerError(ids: readonly string[], error: unknown): void {
	logger.warn("Settings: listener failed", { settings: ids.join(","), error: String(error) });
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

	protected inputs(settings: Settings): readonly unknown[] {
		return [this.#source.get(settings)];
	}

	protected compute(inputs: readonly unknown[]): T {
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

	protected inputs(settings: Settings): readonly unknown[] {
		return this.#parts.map(part => part.get(settings));
	}

	protected compute(inputs: readonly unknown[]): T {
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
export function combine<R extends Record<string, Derived<unknown>>, T = DerivedValues<R>>(
	parts: R,
	fn?: (values: DerivedValues<R>) => T,
): Derived<T> {
	return new CombinedValue(parts, fn ?? (values => values as T));
}

/**
 * Handle for one registered setting. Reads resolve, in precedence order: the definition's
 * environment variable, runtime override, `--config` overlay, project, global, then the default.
 */
export class Setting<T, Id extends string = string> extends Derived<T> {
	readonly id: Id;
	readonly definition: SettingDefinition;
	readonly #sources: readonly AnySetting[];
	/** Environment variable supplying this value, if declared (see {@link SettingEnv}). */
	readonly envName: string | undefined;
	readonly #parseEnv: ((raw: string) => unknown) | undefined;
	readonly #envFallback: boolean;
	#warnedInvalid = false;
	readonly #warnedItems = new Set<string>();

	constructor(definition: SettingDefinition & { id: Id }) {
		super();
		this.id = definition.id;
		this.definition = definition;
		this.#sources = [this];
		const env = definition.env;
		this.envName = typeof env === "string" ? env : env?.name;
		this.#parseEnv =
			typeof env === "object" && env.parse ? env.parse : env ? raw => this.#parseEnvText(raw) : undefined;
		this.#envFallback = typeof env === "object" && env.fallback === true;
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
		return raw === undefined ? undefined : (this.#parseEnv(raw) as T | undefined);
	}

	/** Env value that currently takes effect in `scope`: a fallback env yields to any configured layer. */
	#effectiveEnv(scope: ScopeLike): T | undefined {
		if (this.#envFallback && settingsOf(scope).isConfigured(this.id)) return undefined;
		return this.envValue();
	}

	override get(scope: ScopeLike): T {
		return this.#effectiveEnv(scope) ?? super.get(scope);
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
		if (raw.trim() === "") return undefined;
		try {
			return this.parse(raw);
		} catch {
			return undefined;
		}
	}

	protected inputs(settings: Settings): readonly unknown[] {
		return [settings.rawValue(this.id)];
	}

	protected compute(inputs: readonly unknown[]): T {
		const raw = inputs[0];
		if (raw === undefined) return this.default;
		if (this.accepts(raw)) return raw as T;
		if (!this.#warnedInvalid) {
			this.#warnedInvalid = true;
			logger.warn("Settings: ignoring invalid value, using the default", { setting: this.id, value: raw });
		}
		return this.default;
	}

	/**
	 * Registry plumbing run by `Settings` before every write.
	 *
	 * @throws Error when `value` names an entry outside {@link ArrayDefinition.items} or fails `validate`.
	 */
	assertWritable(value: unknown): void {
		const unknown = this.#unknownItems(value);
		if (unknown.length > 0 && this.definition.type === "array" && this.definition.items) {
			const { values, label } = this.definition.items;
			const noun = unknown.length === 1 ? label : `${label}s`;
			throw new Error(`Unknown ${noun}: ${unknown.join(", ")}. Valid ${label}s: ${values.join(", ")}`);
		}
		this.definition.validate?.(value);
	}

	/**
	 * Registry plumbing run by `Settings` on every load/reload for the configured value.
	 *
	 * @throws Error when `raw` fails `validate`. Unknown {@link ArrayDefinition.items} entries only warn, once each.
	 */
	checkConfigured(raw: unknown): void {
		this.definition.validate?.(raw);
		const label = this.definition.type === "array" ? this.definition.items?.label : undefined;
		for (const entry of this.#unknownItems(raw)) {
			if (this.#warnedItems.has(entry)) continue;
			this.#warnedItems.add(entry);
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

	/** Persists `value` to the global config (or sets a runtime-only override with `{ layer: "override" }`). */
	set(scope: ScopeLike, value: T, options?: { layer?: SettingLayer }): void {
		settingsOf(scope).writeValue(this.id, this.#normalize(value), options?.layer ?? "global");
	}

	/** Runtime-only override (not persisted). */
	override(scope: ScopeLike, value: T): void {
		settingsOf(scope).writeValue(this.id, this.#normalize(value), "override");
	}

	#normalize(value: T): unknown {
		return this.definition.normalize ? this.definition.normalize(value) : value;
	}

	/** Removes a runtime override, restoring the persisted/default value. */
	clearOverride(scope: ScopeLike): void {
		settingsOf(scope).clearOverrideValue(this.id);
	}

	/** Whether the environment or any settings layer (runtime, overlay, project, global) sets this value. */
	isConfigured(scope: ScopeLike): boolean {
		return this.envValue() !== undefined || settingsOf(scope).isConfigured(this.id);
	}

	/** Layer supplying the effective value. */
	provenance(scope: ScopeLike): SettingProvenance {
		return this.#effectiveEnv(scope) !== undefined ? "env" : settingsOf(scope).getProvenance(this.id);
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
// Process-wide effects
// ═══════════════════════════════════════════════════════════════════════════

/** Subscribes one effect to `settings` (applying it once right away); returns the unsubscribe. */
type EffectBinder = (settings: Settings) => () => void;

interface EffectBinding {
	settings: Settings;
	stops: (() => void)[];
}

const effects: EffectBinder[] = [];
let effectBinding: EffectBinding | undefined;

/**
 * Declares a process-wide side effect of a setting (theme, credential redaction, request limits…).
 * It follows the primary settings instance bound with {@link bindEffects}: applied immediately on
 * bind and on every change. Unlike {@link Derived.listen}, application is synchronous — it lands
 * inside the write or reload that caused it, so code reading the affected process state right after
 * `set`/`override` sees the new value. Errors and rejections are logged, never thrown. Subagent
 * overlays and isolated instances never drive effects.
 */
export function effect<T>(value: Derived<T>, apply: (value: T) => void | Promise<void>): void {
	const bind: EffectBinder = settings => {
		const ids = new Set(value.sources.map(source => source.id));
		const run = (next: T) => {
			try {
				const result = apply(next);
				if (result instanceof Promise) result.catch(error => reportListenerError([...ids], error));
			} catch (error) {
				reportListenerError([...ids], error);
			}
		};
		let current = value.get(settings);
		const unsubscribe = settings.onEffectiveChange(path => {
			if (!ids.has(path)) return;
			const next = value.get(settings);
			if (Bun.deepEquals(next, current)) return;
			current = next;
			run(next);
		});
		run(current);
		return unsubscribe;
	};
	effects.push(bind);
	if (effectBinding) effectBinding.stops.push(bind(effectBinding.settings));
}

/**
 * Makes `settings` the instance driving every {@link effect} (the process-global instance, or the
 * top-level session's settings in SDK embeddings). Rebinding replaces the previous binding. Returns
 * a function that ends this binding only — a no-op once another instance has been bound.
 */
export function bindEffects(settings: Settings): () => void {
	const binding = effectBinding?.settings === settings ? effectBinding : startEffectBinding(settings);
	return () => {
		if (effectBinding === binding) unbindEffects();
	};
}

function startEffectBinding(settings: Settings): EffectBinding {
	unbindEffects();
	const binding: EffectBinding = { settings, stops: [] };
	effectBinding = binding;
	for (const bind of effects) binding.stops.push(bind(settings));
	return binding;
}

/** Instance currently driving effects, if any. */
export function effectsSettings(): Settings | undefined {
	return effectBinding?.settings;
}

/** Stops every {@link effect} from following the bound instance (test teardown). */
export function unbindEffects(): void {
	const binding = effectBinding;
	effectBinding = undefined;
	for (const stop of binding?.stops ?? []) stop();
}
