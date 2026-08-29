import * as fs from "node:fs";
import * as path from "node:path";
import { OmpErrors, type Type } from "@oh-my-pi/omptype";
import { getAgentDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { JSONC, YAML } from "bun";

const YAML_MAPPING_HEADER_TRAILING_SPACE = /: +$/gm;

/** Serialize config YAML without Bun's trailing space on block mapping headers. */
export function stringifyYamlConfig(value: unknown): string {
	return YAML.stringify(value, null, 2).replace(YAML_MAPPING_HEADER_TRAILING_SPACE, ":");
}

/** Minimal subset of the AJV ConfigSchemaError shape this module actually relies on. */
interface ConfigSchemaError {
	instancePath: string;
	message: string | undefined;
}

/**
 * Module-private cache of JSON → YAML migrations this process already ran.
 * Prevents `ConfigFile.relocate()` / repeated `tryLoad()` calls from re-running
 * the migration over and over on the boot path.
 */
const migratedPaths = new Set<string>();

function migrationKey(jsonPath: string, ymlPath: string): string {
	return `${jsonPath}\u0000${ymlPath}`;
}

/**
 * Synchronous JSON → YAML migration kept for callers that still want the
 * eager path (settings init, tests that observe migration completion).
 * Idempotent — re-running is a no-op.
 */
function migrateJsonToYml(jsonPath: string, ymlPath: string) {
	const key = migrationKey(jsonPath, ymlPath);
	if (migratedPaths.has(key)) return;
	try {
		if (fs.existsSync(ymlPath)) {
			migratedPaths.add(key);
			return;
		}
		if (!fs.existsSync(jsonPath)) {
			migratedPaths.add(key);
			return;
		}

		const content = fs.readFileSync(jsonPath, "utf-8");
		const parsed = JSONC.parse(content);
		if (!parsed) {
			logger.warn("migrateJsonToYml: invalid json structure", { path: jsonPath });
			migratedPaths.add(key);
			return;
		}
		fs.writeFileSync(ymlPath, stringifyYamlConfig(parsed));
		migratedPaths.add(key);
	} catch (error) {
		logger.warn("migrateJsonToYml: migration failed", { error: String(error) });
	}
}

export type ConfigSchemaSource =
	| { readonly kind: "eager"; readonly schema: Type }
	| { readonly kind: "deferred"; readonly resolve: () => Type };

export interface IConfigFile<T> {
	readonly id: string;
	readonly schema: Type;
	path?(): string;
	load(): T | null;
	invalidate?(): void;
}

export class ConfigError extends Error {
	readonly #message: string;
	constructor(
		public readonly id: string,
		public readonly schemaErrors: ConfigSchemaError[] | null | undefined,
		public readonly other?: { err: unknown; stage: string },
	) {
		let messages: string[] | undefined;
		let cause: Error | undefined;
		let klass: string;

		if (schemaErrors) {
			klass = "Schema";
			messages = schemaErrors.map(e => `${e.instancePath || "root"}: ${e.message}`);
		} else if (other) {
			klass = other.stage;
			if (other.err instanceof Error) {
				messages = [other.err.message];
				cause = other.err;
			} else {
				messages = [String(other.err)];
			}
		} else {
			klass = "Unknown";
		}

		const title = `Failed to load config file ${id}, ${klass} error:`;
		let message: string;
		switch (messages?.length ?? 0) {
			case 0:
				message = title.slice(0, -1);
				break;
			case 1:
				message = `${title} ${messages![0]}`;
				break;
			default:
				message = `${title}\n${messages!.map(m => `  - ${m}`).join("\n")}`;
		}

		super(message, { cause });
		this.name = "LoadError";
		this.#message = message;
	}

	override get message(): string {
		return this.#message;
	}

	override toString(): string {
		return this.message;
	}
}

export type LoadStatus = "ok" | "error" | "not-found";

export type LoadResult<T> =
	| { value?: null; error: ConfigError; status: "error" }
	| { value: T; error?: undefined; status: "ok" }
	| { value?: null; error?: unknown; status: "not-found" };

export class ConfigFile<T> implements IConfigFile<T> {
	readonly #basePath: string;
	readonly #yamlFallbackPath: string | null;
	readonly #jsonMigrationPath: string | null;
	readonly #schemaSource: ConfigSchemaSource;
	#resolvedSchema?: Type;
	#cache?: LoadResult<T>;
	#auxValidate?: (value: T) => void;

	constructor(
		readonly id: string,
		schema: Type | ConfigSchemaSource,
		configPath: string = path.join(getAgentDir(), `${id}.yml`),
	) {
		this.#schemaSource = typeof schema === "function" ? { kind: "eager", schema } : schema;
		this.#basePath = configPath;
		if (configPath.endsWith(".yml")) {
			this.#yamlFallbackPath = `${configPath.slice(0, -4)}.yaml`;
			this.#jsonMigrationPath = `${configPath.slice(0, -4)}.json`;
		} else if (configPath.endsWith(".yaml")) {
			this.#yamlFallbackPath = null;
			this.#jsonMigrationPath = `${configPath.slice(0, -5)}.json`;
		} else if (configPath.endsWith(".json") || configPath.endsWith(".jsonc")) {
			this.#yamlFallbackPath = null;
			// JSON configs are still supported without migration.
			this.#jsonMigrationPath = null;
		} else {
			this.#yamlFallbackPath = null;
			throw new Error(`Invalid config file path: ${configPath}`);
		}
	}

	get schema(): Type {
		if (this.#schemaSource.kind === "eager") return this.#schemaSource.schema;
		if (!this.#resolvedSchema) this.#resolvedSchema = this.#schemaSource.resolve();
		return this.#resolvedSchema;
	}

	/**
	 * Run the JSON → YAML migration synchronously, if applicable. Idempotent.
	 * Sync callers (tests, settings init) hit this implicitly via {@link tryLoad}.
	 */
	#ensureMigrated(): void {
		if (!this.#jsonMigrationPath) return;
		if (this.#yamlFallbackPath && !fs.existsSync(this.#basePath) && fs.existsSync(this.#yamlFallbackPath)) {
			return;
		}
		migrateJsonToYml(this.#jsonMigrationPath, this.#basePath);
	}

	relocate(configPath?: string): ConfigFile<T> {
		if (!configPath || configPath === this.#basePath) return this;
		const result = new ConfigFile<T>(this.id, this.#schemaSource, configPath);
		result.#auxValidate = this.#auxValidate;
		result.#resolvedSchema = this.#resolvedSchema;
		result.#ensureMigrated();
		return result;
	}

	#resolveReadPath(): string {
		if (fs.existsSync(this.#basePath)) {
			return this.#basePath;
		}
		if (this.#yamlFallbackPath && fs.existsSync(this.#yamlFallbackPath)) {
			return this.#yamlFallbackPath;
		}
		return this.#basePath;
	}

	getMtimeMs(): number | null {
		try {
			return fs.statSync(this.#resolveReadPath()).mtimeMs;
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	async getMtimeMsAsync(): Promise<number | null> {
		const file = Bun.file(this.path());
		if (!(await file.exists())) return null;
		const lm = file.lastModified;
		return typeof lm === "number" && Number.isFinite(lm) ? lm : null;
	}

	withValidation(name: string, validate: (value: T) => void): this {
		const prev = this.#auxValidate;
		this.#auxValidate = (value: T) => {
			prev?.(value);
			try {
				validate(value);
			} catch (error) {
				throw new ConfigError(this.id, undefined, { err: error, stage: `Validate(${name})` });
			}
		};
		return this;
	}

	createDefault(): T {
		const parsed = this.schema({});
		if (!(parsed instanceof Error)) return parsed as T;
		const fallback = this.schema(undefined);
		if (!(fallback instanceof Error)) return fallback as T;
		throw new ConfigError(this.id, undefined, {
			err: new Error("Schema produced no default value"),
			stage: "createDefault",
		});
	}

	#storeCache(result: LoadResult<T>): LoadResult<T> {
		this.#cache = result;
		return result;
	}

	#parseContent(content: string): LoadResult<T> {
		try {
			let parsed: unknown;
			const readPath = this.#resolveReadPath();
			if (readPath.endsWith(".json") || readPath.endsWith(".jsonc")) {
				parsed = JSONC.parse(content);
			} else if (readPath.endsWith(".yml") || readPath.endsWith(".yaml")) {
				parsed = YAML.parse(content);
			} else {
				throw new Error(`Invalid config file path: ${readPath}`);
			}

			const checked = this.schema(parsed);
			if (checked instanceof OmpErrors) {
				const schemaErrors: ConfigSchemaError[] = checked.map(error => ({
					instancePath: error.path.length === 0 ? "root" : error.path.join("."),
					message: error.problem,
				}));
				const error = new ConfigError(this.id, schemaErrors);
				logger.warn("Failed to parse config file", { path: this.path(), error });
				return this.#storeCache({ error, status: "error" });
			}
			const value = checked as T;
			try {
				this.#auxValidate?.(value);
			} catch (error) {
				const wrapped =
					error instanceof ConfigError
						? error
						: new ConfigError(this.id, undefined, { err: error, stage: "AuxValidate" });
				return this.#storeCache({ error: wrapped, status: "error" });
			}
			return this.#storeCache({ value, status: "ok" });
		} catch (error) {
			logger.warn("Failed to parse config file", { path: this.path(), error });
			return this.#storeCache({
				error: new ConfigError(this.id, undefined, { err: error, stage: "Unexpected" }),
				status: "error",
			});
		}
	}

	tryLoad(): LoadResult<T> {
		if (this.#cache) return this.#cache;
		this.#ensureMigrated();

		let content: string;
		try {
			content = fs.readFileSync(this.#resolveReadPath(), "utf-8").trim();
		} catch (error) {
			if (isEnoent(error)) {
				return this.#storeCache({ status: "not-found" });
			}
			logger.warn("Failed to read config file", { path: this.path(), error });
			return this.#storeCache({
				error: new ConfigError(this.id, undefined, { err: error, stage: "Read" }),
				status: "error",
			});
		}
		return this.#parseContent(content);
	}

	async tryLoadAsync(): Promise<LoadResult<T>> {
		if (this.#cache) return this.#cache;
		this.#ensureMigrated();

		let content: string;
		try {
			content = (await Bun.file(this.#resolveReadPath()).text()).trim();
		} catch (error) {
			if (isEnoent(error)) {
				return this.#storeCache({ status: "not-found" });
			}
			logger.warn("Failed to read config file", { path: this.path(), error });
			return this.#storeCache({
				error: new ConfigError(this.id, undefined, { err: error, stage: "Read" }),
				status: "error",
			});
		}
		return this.#parseContent(content);
	}

	load(): T | null {
		return this.tryLoad().value ?? null;
	}

	async loadAsync(): Promise<T | null> {
		return (await this.tryLoadAsync()).value ?? null;
	}

	loadOrDefault(): T {
		return this.tryLoad().value ?? this.createDefault();
	}

	async loadOrDefaultAsync(): Promise<T> {
		return (await this.tryLoadAsync()).value ?? this.createDefault();
	}

	path(): string {
		return this.#resolveReadPath();
	}

	invalidate() {
		this.#cache = undefined;
	}
}
