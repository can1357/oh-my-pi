/**
 * Resolve the npm registry `omp update` talks to from the user's own package
 * manager configuration, so a configured feed (corporate proxy, Artifactory,
 * Verdaccio, …) is honored for both the release lookup and the install.
 *
 * Sources, first match wins, per package:
 * 1. `@scope:registry`, then `registry` in the user `.npmrc`
 *    (`npm_config_userconfig` or `~/.npmrc`).
 * 2. `[install.scopes]` in the global `bunfig.toml` for the package's scope.
 * 3. `npm_config_registry` / `BUN_CONFIG_REGISTRY` environment variables.
 * 4. `install.registry` in the global `bunfig.toml`
 *    (`$XDG_CONFIG_HOME/.bunfig.toml`, then `~/.bunfig.toml`).
 * 5. {@link DEFAULT_NPM_REGISTRY}.
 *
 * Project-level config is deliberately ignored: `omp update` modifies a global
 * install, and the working directory it runs from is incidental.
 */
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, isRecord } from "@oh-my-pi/pi-utils";

/** Public npm registry; used when no user configuration names another one. */
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";

/** Registry resolved for one package: where to fetch its metadata and how to authenticate. */
export interface NpmRegistry {
	/**
	 * Registry base URL with a trailing slash, passed to `--registry`. Userinfo
	 * is always stripped so credentials never reach error text or child argv;
	 * they travel in {@link authorization} instead.
	 */
	url: string;
	/** Human-readable origin of {@link url}, for diagnostics. */
	source: string;
	/** `Authorization` header value for metadata requests, when credentials are configured. */
	authorization?: string;
}

/** Maps an npm package name to the registry that serves it. */
export type NpmRegistryResolver = (pkg: string) => NpmRegistry;

type Env = Record<string, string | undefined>;

interface RegistryEntry {
	url: string;
	source: string;
	/** Credentials attached to the entry itself (bunfig `token`/`username`+`password`). */
	authorization?: string;
}

/** Resolver pinned to a single registry; used when no user configuration applies. */
export function fixedNpmRegistry(url: string = DEFAULT_NPM_REGISTRY, source = "default"): NpmRegistryResolver {
	const registry = toRegistry({ url, source });
	return () => registry;
}

/** Test seams for {@link loadNpmRegistryResolver}; production reads the process env and home directory. */
export interface LoadNpmRegistryOptions {
	env?: Env;
	homeDir?: string;
}

/** Read the user's npm/bun registry configuration once and return a per-package resolver. */
export async function loadNpmRegistryResolver(options: LoadNpmRegistryOptions = {}): Promise<NpmRegistryResolver> {
	const env = options.env ?? Bun.env;
	const homeDir = options.homeDir ?? os.homedir();

	const npmrcPath = envLookup(env, "npm_config_userconfig") ?? path.join(homeDir, ".npmrc");
	const npmrcText = await readOptional(npmrcPath);
	const npmrc = npmrcText === undefined ? new Map<string, string>() : parseNpmrc(npmrcText, env, npmrcPath);

	const bunfig = await readGlobalBunfig(env, homeDir);

	let fallback: RegistryEntry = { url: DEFAULT_NPM_REGISTRY, source: "default" };
	if (bunfig?.registry) fallback = bunfig.registry;
	const envRegistry = envLookup(env, "npm_config_registry") ?? envLookup(env, "BUN_CONFIG_REGISTRY");
	if (envRegistry) fallback = { url: envRegistry, source: "environment" };
	const npmrcRegistry = npmrc.get("registry");
	const npmrcDefault = npmrcRegistry ? { url: npmrcRegistry, source: npmrcPath } : undefined;

	const cache = new Map<string, NpmRegistry>();
	return pkg => {
		const scope = pkg.startsWith("@") ? pkg.slice(0, pkg.indexOf("/")) : undefined;
		const key = scope ?? "";
		const cached = cache.get(key);
		if (cached) return cached;
		const scoped = scope ? npmrc.get(`${scope}:registry`) : undefined;
		const entry = scoped
			? { url: scoped, source: npmrcPath }
			: (npmrcDefault ?? (scope ? bunfig?.scopes.get(scope) : undefined) ?? fallback);
		const registry = toRegistry(entry, npmrc);
		cache.set(key, registry);
		return registry;
	};
}

/**
 * Metadata URL for `pkg` at `tag` (a dist-tag or version) on `registry`.
 * Scoped names use npm's escaped `@scope%2fname` form, which every registry
 * implementation accepts.
 */
export function npmRegistryPackageUrl(registry: NpmRegistry, pkg: string, tag?: string): string {
	const escaped = pkg.replace("/", "%2f");
	return `${registry.url}${escaped}${tag === undefined ? "" : `/${tag}`}`;
}

function toRegistry(entry: RegistryEntry, npmrc?: Map<string, string>): NpmRegistry {
	let url: URL;
	try {
		url = new URL(entry.url);
	} catch {
		throw new Error(`Invalid npm registry URL "${entry.url}" (from ${entry.source})`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`Unsupported npm registry protocol "${url.protocol}" (from ${entry.source}); expected http(s)`);
	}
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	let authorization = entry.authorization;
	if (!authorization && url.username) {
		authorization = `Basic ${btoa(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`)}`;
	}
	// Embedded credentials are consumed above; the package manager install
	// authenticates through its own config (npmrc `//host/:_authToken`, bunfig).
	url.username = "";
	url.password = "";
	if (!authorization && npmrc) authorization = npmrcAuthorization(npmrc, url);
	return { url: url.href, source: entry.source, authorization };
}

/**
 * npm's credential lookup: `//host/path/:_authToken` (or `_auth`,
 * `username` + `_password`) keyed by the registry URL minus protocol, walking
 * up the path so a token for `//host/` also covers `//host/npm/feed/`.
 */
function npmrcAuthorization(npmrc: Map<string, string>, url: URL): string | undefined {
	const segments = url.pathname.split("/").filter(Boolean);
	for (let n = segments.length; n >= 0; n--) {
		const prefix = `//${url.host}/${segments
			.slice(0, n)
			.map(s => `${s}/`)
			.join("")}`;
		const token = npmrc.get(`${prefix}:_authToken`);
		if (token) return `Bearer ${token}`;
		const basic = npmrc.get(`${prefix}:_auth`);
		if (basic) return `Basic ${basic}`;
		const username = npmrc.get(`${prefix}:username`);
		const password = npmrc.get(`${prefix}:_password`);
		if (username && password) return `Basic ${btoa(`${username}:${atob(password)}`)}`;
	}
	return undefined;
}

/** Parse `.npmrc` ini: `key = value` lines, `;`/`#` comments, npm-style `${VAR}` expansion. */
export function parseNpmrc(text: string, env: Env, source = ".npmrc"): Map<string, string> {
	const config = new Map<string, string>();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith(";") || line.startsWith("#") || line.startsWith("[")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = expandNpmrcEnv(line.slice(0, eq).trim(), env, source);
		let value = line.slice(eq + 1).trim();
		if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
			value = value.slice(1, -1);
		}
		config.set(key, expandNpmrcEnv(value, env, source));
	}
	return config;
}

/** npm semantics: `${VAR}` must be set, `${VAR?}` expands to "" when unset, `\${` stays literal. */
function expandNpmrcEnv(value: string, env: Env, source: string): string {
	return value.replace(/(\\*)\$\{([^${}?]+)(\?)?\}/g, (match, slashes: string, name: string, optional?: string) => {
		if (slashes.length % 2 === 1) return match.slice(1);
		const resolved = envLookup(env, name);
		if (resolved !== undefined) return slashes + resolved;
		if (optional) return slashes;
		throw new Error(`Failed to replace env in config: \${${name}} (${source})`);
	});
}

interface BunfigRegistries {
	registry?: RegistryEntry;
	scopes: Map<string, RegistryEntry>;
}

async function readGlobalBunfig(env: Env, homeDir: string): Promise<BunfigRegistries | undefined> {
	const candidates: string[] = [];
	const xdg = envLookup(env, "XDG_CONFIG_HOME");
	if (xdg) candidates.push(path.join(xdg, ".bunfig.toml"));
	candidates.push(path.join(homeDir, ".bunfig.toml"));
	for (const file of candidates) {
		const text = await readOptional(file);
		if (text === undefined) continue;
		let parsed: unknown;
		try {
			parsed = Bun.TOML.parse(text);
		} catch (err) {
			throw new Error(`Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
		const install = isRecord(parsed) && isRecord(parsed.install) ? parsed.install : undefined;
		const scopes = new Map<string, RegistryEntry>();
		if (install && isRecord(install.scopes)) {
			for (const [name, value] of Object.entries(install.scopes)) {
				const entry = bunfigRegistryEntry(value, env, file);
				if (entry) scopes.set(name.startsWith("@") ? name : `@${name}`, entry);
			}
		}
		return { registry: install ? bunfigRegistryEntry(install.registry, env, file) : undefined, scopes };
	}
	return undefined;
}

/** bunfig registries are a URL string or `{ url, token }` / `{ url, username, password }`. */
function bunfigRegistryEntry(value: unknown, env: Env, source: string): RegistryEntry | undefined {
	if (typeof value === "string") return value ? { url: expandBunfigEnv(value, env), source } : undefined;
	if (!isRecord(value) || typeof value.url !== "string") return undefined;
	const entry: RegistryEntry = { url: expandBunfigEnv(value.url, env), source };
	if (typeof value.token === "string" && value.token) {
		entry.authorization = `Bearer ${expandBunfigEnv(value.token, env)}`;
	} else if (typeof value.username === "string" && typeof value.password === "string") {
		entry.authorization = `Basic ${btoa(`${expandBunfigEnv(value.username, env)}:${expandBunfigEnv(value.password, env)}`)}`;
	}
	return entry;
}

/** Bun expands `$VAR` and `${VAR}` in bunfig strings; unset variables become "". */
function expandBunfigEnv(value: string, env: Env): string {
	return value.replace(
		/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
		(_match, braced?: string, bare?: string) => envLookup(env, (braced ?? bare) as string) ?? "",
	);
}

/** npm treats `npm_config_*` names case-insensitively; exact matches win. */
function envLookup(env: Env, name: string): string | undefined {
	const exact = env[name];
	if (exact) return exact;
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(env)) {
		if (value && key.toLowerCase() === lower) return value;
	}
	return undefined;
}

async function readOptional(file: string): Promise<string | undefined> {
	try {
		return await Bun.file(file).text();
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}
