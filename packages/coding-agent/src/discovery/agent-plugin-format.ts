/**
 * Agent Plugins 1.0.0 format support (https://agent-plugins.org).
 *
 * Pure validation and transformation logic for the portable plugin package
 * format: the closed `plugin.json` manifest (spec §5), the closed `mcp.json`
 * MCP configuration (spec §7.2), `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` placeholder
 * expansion (spec §9.2), and package-boundary containment (spec §4.1).
 *
 * The discovery provider in `./agent-plugins.ts` wires this into the
 * capability registry; `./claude-plugins.ts` and `./omp-plugins.ts` consult
 * {@link classifyAgentPluginRoot} so roots governed by the standard are not
 * double-loaded through legacy conventions.
 */
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { readFile } from "../capability/fs";
import { isContainedResolved, realpathIfExists, resolveContainedPath } from "./contained-path";
import { registerPluginCacheInvalidator } from "./helpers";

/** Canonical `plugin.json` `$schema` identifier for Agent Plugins 1.0.0 (spec §5.2). */
export const AGENT_PLUGIN_MANIFEST_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
/** Canonical `mcp.json` `$schema` identifier for Agent Plugins 1.0.0 (spec §7.2.1). */
export const AGENT_PLUGIN_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
/** Prefix shared by every Agent Plugins canonical schema identifier, across spec versions. */
const AGENT_PLUGIN_SCHEMA_PREFIX = "https://agent-plugins.org/schemas/";

const MANIFEST_FIELDS: Record<string, true> = {
	$schema: true,
	name: true,
	version: true,
	description: true,
	author: true,
	homepage: true,
	repository: true,
	license: true,
	keywords: true,
	extensions: true,
};
const AUTHOR_FIELDS: Record<string, true> = { name: true, email: true, url: true };
const STDIO_FIELDS: Record<string, true> = { type: true, command: true, args: true, env: true, cwd: true };
const REMOTE_FIELDS: Record<string, true> = { type: true, url: true, headers: true };
/** Reserved subprocess environment names the client always supplies itself (spec §9.2). */
const RESERVED_ENV_NAMES: Record<string, true> = { PLUGIN_ROOT: true, PLUGIN_DATA: true };
/** RFC 9110 token characters, the only bytes legal in an HTTP field name. */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Concatenation avoids the noTemplateCurlyInString lint on literal placeholder names.
const PLUGIN_ROOT_VAR = "$" + "{PLUGIN_ROOT}";
const PLUGIN_DATA_VAR = "$" + "{PLUGIN_DATA}";

/** Validated portable manifest fields from a plugin's root `plugin.json` (spec §5). */
export interface AgentPluginManifest {
	name: string;
	version?: string;
	description?: string;
	author?: { name?: string; email?: string; url?: string };
	homepage?: string;
	repository?: string;
	license?: string;
	keywords?: string[];
	/**
	 * Client-owned data keyed by reverse-domain namespace. Member values are
	 * opaque: this client implements no namespace, and §8.1/§11.1 require
	 * ignoring unimplemented namespaces without validating their values.
	 */
	extensions?: Record<string, unknown>;
}

/**
 * Outcome of parsing a candidate `plugin.json`:
 * - `none` — the document does not target Agent Plugins (no recognized `$schema`);
 *   legacy plugin conventions may still apply to the directory.
 * - `valid` — a conformant manifest; `warnings` carries the non-fatal violations
 *   the spec requires reporting (unknown top-level fields, non-object `extensions`).
 * - `invalid` — the document targets Agent Plugins but violates the closed schema
 *   fatally; the plugin must be rejected and none of its components loaded (spec §5.2).
 */
type AgentPluginManifestResult =
	| { status: "none" }
	| { status: "valid"; manifest: AgentPluginManifest; warnings: string[] }
	| { status: "invalid"; reason: string };

/** Enforce the plugin `name` constraints from spec §5.5. */
function isValidAgentPluginName(name: string): boolean {
	if (name.length < 1 || name.length > 64) return false;
	if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name)) return false;
	return !name.includes("--") && !name.includes("..");
}

/** The closed frontmatter field set from the skills-ref reference validator. */
const SKILL_FIELDS: Record<string, true> = {
	name: true,
	description: true,
	license: true,
	"allowed-tools": true,
	metadata: true,
	compatibility: true,
};
/** Skill `name` characters: Unicode letters/digits (Python `str.isalnum`) and hyphens. */
const SKILL_NAME_CHARS_RE = /^[\p{L}\p{N}-]+$/u;

/** Validate the skill `name` per the skills-ref reference rules (NFKC-normalized). */
function validateSkillName(raw: unknown, dirName: string): string | null {
	if (typeof raw !== "string" || raw.trim().length === 0) return `missing required "name"`;
	const name = raw.trim().normalize("NFKC");
	if (Array.from(name).length > 64) return `"name" exceeds 64 characters`;
	if (name !== name.toLowerCase()) return `"name" must be lowercase`;
	if (name.startsWith("-") || name.endsWith("-")) return `"name" cannot start or end with a hyphen`;
	if (name.includes("--")) return `"name" cannot contain consecutive hyphens`;
	if (!SKILL_NAME_CHARS_RE.test(name)) return `invalid "name" ${JSON.stringify(name)}`;
	if (name !== dirName.normalize("NFKC")) {
		return `"name" ${JSON.stringify(name)} does not match directory ${JSON.stringify(dirName)}`;
	}
	return null;
}

/**
 * Validate `SKILL.md` frontmatter against the Agent Skills specification
 * (https://agentskills.io/specification), the source of truth for skill
 * validity under Agent Plugins §7.1, mirroring the official skills-ref
 * reference validator: the frontmatter schema is CLOSED to its six fields and
 * any unexpected key rejects the skill. Returns the first violation, or `null`
 * when the skill conforms. Frontmatter keys must be raw (unnormalized).
 */
export function validateAgentSkillFrontmatter(frontmatter: Record<string, unknown>, dirName: string): string | null {
	for (const key in frontmatter) {
		if (!SKILL_FIELDS[key]) return `unexpected frontmatter field "${key}"`;
	}

	const nameViolation = validateSkillName(frontmatter.name, dirName);
	if (nameViolation !== null) return nameViolation;

	const description = frontmatter.description;
	if (typeof description !== "string" || description.trim().length === 0) {
		return `missing required "description"`;
	}
	if (description.length > 1024) return `"description" exceeds 1024 characters`;

	const license = frontmatter.license;
	if (license !== undefined && typeof license !== "string") return `"license" must be a string`;

	const compatibility = frontmatter.compatibility;
	if (compatibility !== undefined) {
		if (typeof compatibility !== "string") return `"compatibility" must be a string`;
		if (compatibility.length > 500) return `"compatibility" exceeds 500 characters`;
	}

	const metadata = frontmatter.metadata;
	if (metadata !== undefined) {
		if (!isRecord(metadata)) return `"metadata" must be a map of string keys to string values`;
		for (const key in metadata) {
			if (typeof metadata[key] !== "string") return `"metadata.${key}" must be a string`;
		}
	}

	const allowedTools = frontmatter["allowed-tools"];
	if (allowedTools !== undefined && typeof allowedTools !== "string") {
		return `"allowed-tools" must be a string`;
	}

	return null;
}

/**
 * Parse and validate a root `plugin.json` document against the closed
 * Agent Plugins 1.0.0 manifest schema (spec §5.2–§5.5, §8.1).
 */
export function parseAgentPluginManifest(raw: string): AgentPluginManifestResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Unparseable documents carry no $schema, so the package cannot claim
		// Agent Plugins conformance; leave it to legacy conventions.
		return { status: "none" };
	}
	if (!isRecord(parsed)) return { status: "none" };

	const schema = parsed.$schema;
	if (typeof schema !== "string" || !schema.startsWith(AGENT_PLUGIN_SCHEMA_PREFIX)) return { status: "none" };
	if (schema !== AGENT_PLUGIN_MANIFEST_SCHEMA) {
		return { status: "invalid", reason: `unsupported Agent Plugins version ($schema: ${schema})` };
	}

	const warnings: string[] = [];
	// Unknown top-level fields are schema violations, but spec §5.2 requires
	// reporting and ignoring them rather than rejecting the plugin.
	for (const key in parsed) {
		if (!MANIFEST_FIELDS[key]) warnings.push(`Ignoring unknown plugin.json field "${key}"`);
	}

	const name = parsed.name;
	if (typeof name !== "string" || !isValidAgentPluginName(name)) {
		return { status: "invalid", reason: `invalid plugin name ${JSON.stringify(name)}` };
	}

	const manifest: AgentPluginManifest = { name };
	for (const field of ["version", "description", "homepage", "repository", "license"] as const) {
		const value = parsed[field];
		if (value === undefined) continue;
		if (typeof value !== "string") return { status: "invalid", reason: `"${field}" must be a string` };
		manifest[field] = value;
	}

	const keywords = parsed.keywords;
	if (keywords !== undefined) {
		if (!Array.isArray(keywords) || keywords.some(entry => typeof entry !== "string")) {
			return { status: "invalid", reason: `"keywords" must be an array of strings` };
		}
		manifest.keywords = keywords as string[];
	}

	const author = parsed.author;
	if (author !== undefined) {
		if (!isRecord(author)) return { status: "invalid", reason: `"author" must be an object` };
		for (const key in author) {
			if (!AUTHOR_FIELDS[key]) return { status: "invalid", reason: `unknown "author" field "${key}"` };
			if (typeof author[key] !== "string") return { status: "invalid", reason: `"author.${key}" must be a string` };
		}
		manifest.author = author as AgentPluginManifest["author"];
	}

	const extensions = parsed.extensions;
	if (extensions !== undefined) {
		if (!isRecord(extensions)) {
			// Non-object extensions is the second explicitly non-fatal violation (spec §8.1).
			warnings.push(`Ignoring non-object "extensions" field`);
		} else {
			// §8.1/§11.1: unimplemented namespace entries are ignored WITHOUT
			// validating the contents of their values — even non-object values
			// (another client's convention) never reject the plugin.
			manifest.extensions = extensions;
		}
	}

	return { status: "valid", manifest, warnings };
}

/**
 * Expand `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` in a configuration value
 * (spec §9.2). Single non-recursive pass; replacement text is never rescanned,
 * and no other placeholder or environment-variable expansion is performed.
 */
function expandAgentPluginPlaceholders(value: string, pluginRoot: string, pluginData: string): string {
	return value.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_match, which: string) =>
		which === "ROOT" ? pluginRoot : pluginData,
	);
}

/** A validated `mcp.json` server entry, resolved to launch-ready values. */
interface AgentPluginMcpServer {
	name: string;
	transport: "stdio" | "http" | "sse";
	/** Absolute path for `./`-relative commands; bare executable token otherwise. */
	command?: string;
	args?: string[];
	/** Expanded configured env plus the client-supplied `PLUGIN_ROOT`/`PLUGIN_DATA`. */
	env?: Record<string, string>;
	/** Absolute working directory; defaults to the plugin root for stdio servers. */
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
}

/**
 * Outcome of parsing a plugin's `mcp.json`:
 * - `disabled` — the top-level document is invalid, so MCP is disabled for the
 *   plugin while other component types keep loading (spec §7.2.2 rule 2).
 * - `ok` — the document is valid; individually invalid server entries are
 *   skipped with a warning (spec §7.2.2 rule 3).
 */
type AgentPluginMcpResult =
	| { status: "disabled"; reason: string }
	| { status: "ok"; servers: AgentPluginMcpServer[]; warnings: string[] };

interface AgentPluginMcpOptions {
	/** Filesystem-resolved plugin root. */
	pluginRoot: string;
	/** Client-managed persistent data directory for this plugin (spec §9.1). */
	pluginData: string;
}

/** Loopback check for plain-HTTP MCP endpoints (spec §7.2.1): `localhost` or a loopback IP literal. */
function isLoopbackHost(hostname: string): boolean {
	if (hostname === "localhost") return true;
	if (hostname === "[::1]" || hostname === "::1") return true;
	const octets = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(hostname);
	return octets !== null && octets[1] === "127";
}

function validateRemoteUrl(rawUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return "url is not an absolute URL";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return "url must use http or https";
	if (url.username || url.password) return "url must not contain user information";
	if (url.hash) return "url must not contain a fragment";
	if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
		return "non-loopback endpoints must use https";
	}
	return null;
}

function validateHeaders(headers: Record<string, unknown>): string | null {
	const seen = new Set<string>();
	for (const name in headers) {
		const value = headers[name];
		if (!HEADER_NAME_RE.test(name)) return `invalid header name "${name}"`;
		if (typeof value !== "string") return `header "${name}" value must be a string`;
		if (/[\0\r\n]/.test(value)) return `header "${name}" value contains control characters`;
		const lower = name.toLowerCase();
		if (seen.has(lower)) return `duplicate header name "${name}"`;
		seen.add(lower);
	}
	return null;
}

/** Per-entry validation result: a resolved server, or the reason the entry is skipped. */
type ServerEntryResult = { server: AgentPluginMcpServer } | { error: string };

async function parseStdioServer(
	name: string,
	cfg: Record<string, unknown>,
	{ pluginRoot, pluginData }: AgentPluginMcpOptions,
): Promise<ServerEntryResult> {
	for (const key in cfg) {
		if (!STDIO_FIELDS[key]) return { error: `unknown field "${key}"` };
	}

	// `command` is one executable token: a bare name resolved by platform search
	// rules, or a plugin-relative `./` path. No placeholder expansion (spec §7.2.1).
	const command = cfg.command;
	if (typeof command !== "string" || command.length === 0) return { error: `"command" must be a non-empty string` };
	let resolvedCommand: string;
	if (command.startsWith("./")) {
		resolvedCommand = path.resolve(pluginRoot, command);
		if (!(await isContainedResolved(pluginRoot, resolvedCommand))) {
			return { error: `"command" resolves outside the plugin root` };
		}
	} else if (command.includes("/") || command.includes("\\")) {
		return { error: `"command" must be a bare executable name or a plugin-relative ./ path` };
	} else {
		resolvedCommand = command;
	}

	const args = cfg.args;
	if (args !== undefined && (!Array.isArray(args) || args.some(entry => typeof entry !== "string"))) {
		return { error: `"args" must be an array of strings` };
	}
	const expandedArgs = (args as string[] | undefined)?.map(arg =>
		expandAgentPluginPlaceholders(arg, pluginRoot, pluginData),
	);

	const env = cfg.env;
	const expandedEnv: Record<string, string> = {};
	if (env !== undefined) {
		if (!isRecord(env)) return { error: `"env" must be an object of strings` };
		for (const key in env) {
			const value = env[key];
			if (typeof value !== "string") return { error: `"env.${key}" must be a string` };
			if (RESERVED_ENV_NAMES[key]) return { error: `"env" must not set reserved variable ${key}` };
			expandedEnv[key] = expandAgentPluginPlaceholders(value, pluginRoot, pluginData);
		}
	}
	// The client supplies the reserved variables itself, after the configured
	// overlay, replacing any equivalently named ambient entries (spec §9.1).
	expandedEnv.PLUGIN_ROOT = pluginRoot;
	expandedEnv.PLUGIN_DATA = pluginData;

	// `cwd` accepts exactly three forms (spec §7.2.1); anything else — or a
	// post-resolution escape from its governing directory — invalidates the entry.
	let resolvedCwd = pluginRoot;
	const cwd = cfg.cwd;
	if (cwd !== undefined) {
		if (typeof cwd !== "string") return { error: `"cwd" must be a string` };
		const dataRooted = cwd === PLUGIN_DATA_VAR || cwd.startsWith(`${PLUGIN_DATA_VAR}/`);
		const rootRooted = cwd === PLUGIN_ROOT_VAR || cwd.startsWith(`${PLUGIN_ROOT_VAR}/`);
		if (!dataRooted && !rootRooted && !cwd.startsWith("./")) {
			return { error: `"cwd" must be plugin-relative or rooted at ${PLUGIN_ROOT_VAR} or ${PLUGIN_DATA_VAR}` };
		}
		const expanded = expandAgentPluginPlaceholders(cwd, pluginRoot, pluginData);
		resolvedCwd = path.resolve(pluginRoot, expanded);
		const base = dataRooted ? pluginData : pluginRoot;
		if (!(await isContainedResolved(base, resolvedCwd))) {
			return { error: `"cwd" resolves outside ${dataRooted ? "the plugin data directory" : "the plugin root"}` };
		}
	}

	return {
		server: {
			name,
			transport: "stdio",
			command: resolvedCommand,
			...(expandedArgs !== undefined && { args: expandedArgs }),
			env: expandedEnv,
			cwd: resolvedCwd,
		},
	};
}

function parseRemoteServer(name: string, cfg: Record<string, unknown>, transport: "http" | "sse"): ServerEntryResult {
	for (const key in cfg) {
		if (!REMOTE_FIELDS[key]) return { error: `unknown field "${key}"` };
	}
	const url = cfg.url;
	if (typeof url !== "string" || url.length === 0) return { error: `"url" must be a non-empty string` };
	const urlError = validateRemoteUrl(url);
	if (urlError) return { error: urlError };

	const headers = cfg.headers;
	if (headers !== undefined) {
		if (!isRecord(headers)) return { error: `"headers" must be an object of strings` };
		const headerError = validateHeaders(headers);
		if (headerError) return { error: headerError };
	}

	return {
		server: {
			name,
			transport,
			url,
			...(headers !== undefined && { headers: headers as Record<string, string> }),
		},
	};
}

/**
 * Parse and validate a plugin's `mcp.json` against the closed Agent Plugins
 * 1.0.0 MCP configuration (spec §7.2), resolving stdio commands and working
 * directories against the plugin root and expanding plugin variables.
 */
export async function parseAgentPluginMcp(raw: string, options: AgentPluginMcpOptions): Promise<AgentPluginMcpResult> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { status: "disabled", reason: "mcp.json is not valid JSON" };
	}
	if (!isRecord(parsed)) return { status: "disabled", reason: "mcp.json must be a JSON object" };

	// The plugin manifest already pinned Agent Plugins 1.0.0, so the version
	// match rule of spec §10.1 collapses to requiring the exact 1.0.0 identifier.
	if (parsed.$schema !== AGENT_PLUGIN_MCP_SCHEMA) {
		return { status: "disabled", reason: `mcp.json $schema must be ${AGENT_PLUGIN_MCP_SCHEMA}` };
	}
	for (const key in parsed) {
		if (key !== "$schema" && key !== "mcpServers") {
			return { status: "disabled", reason: `mcp.json has unknown top-level field "${key}"` };
		}
	}
	const servers = parsed.mcpServers;
	if (!isRecord(servers)) return { status: "disabled", reason: `"mcpServers" must be an object` };

	const items: AgentPluginMcpServer[] = [];
	const warnings: string[] = [];
	for (const name in servers) {
		const cfg = servers[name];
		let result: ServerEntryResult;
		if (!isRecord(cfg)) {
			result = { error: "server entry must be an object" };
		} else if (cfg.type === "stdio") {
			result = await parseStdioServer(name, cfg, options);
		} else if (cfg.type === "streamable-http") {
			result = parseRemoteServer(name, cfg, "http");
		} else if (cfg.type === "sse") {
			result = parseRemoteServer(name, cfg, "sse");
		} else {
			result = { error: `unknown transport type ${JSON.stringify(cfg.type)}` };
		}
		if ("error" in result) {
			warnings.push(`Skipping MCP server "${name}": ${result.error}`);
			continue;
		}
		items.push(result.server);
	}

	return { status: "ok", servers: items, warnings };
}

/**
 * Classification of a plugin root directory against the Agent Plugins standard:
 * - `none` — no Agent Plugins manifest; legacy plugin conventions govern.
 * - `standard` — a valid Agent Plugin; the standard governs its portable
 *   components (skills and MCP servers). `realRoot` is the filesystem-resolved
 *   plugin root every package path is contained within.
 * - `invalid` — the root claims Agent Plugins conformance but its manifest is
 *   fatally invalid; no component may be discovered or executed (spec §11.3).
 */
type AgentPluginRootStatus =
	| { kind: "none" }
	| { kind: "standard"; manifest: AgentPluginManifest; warnings: string[]; realRoot: string }
	| { kind: "invalid"; reason: string };

const rootStatusCache = new Map<string, Promise<AgentPluginRootStatus>>();
registerPluginCacheInvalidator(() => rootStatusCache.clear());

/** Drop cached classifications (tests, or after plugin installs outside the shared registry flow). */
export function clearAgentPluginRootCache(): void {
	rootStatusCache.clear();
}

async function classifyUncached(rootPath: string): Promise<AgentPluginRootStatus> {
	const realRoot = await realpathIfExists(rootPath);
	if (realRoot === null) return { kind: "none" };

	// Spec §4.1 failure boundary 1: resolve plugin.json and prove containment
	// BEFORE reading it — an escaping manifest is rejected without consuming a
	// single byte from outside the package.
	const manifest = await resolveContainedPath(realRoot, path.join(realRoot, "plugin.json"));
	if (manifest.status === "missing") return { kind: "none" };
	if (manifest.status === "outside") {
		return { kind: "invalid", reason: "plugin.json resolves outside the plugin root" };
	}

	const raw = await readFile(manifest.realPath);
	if (raw === null) return { kind: "none" };
	const parsed = parseAgentPluginManifest(raw);
	if (parsed.status === "none") return { kind: "none" };
	if (parsed.status === "invalid") return { kind: "invalid", reason: parsed.reason };
	return { kind: "standard", manifest: parsed.manifest, warnings: parsed.warnings, realRoot };
}

/**
 * Determine whether a plugin root is governed by the Agent Plugins standard.
 * Results are cached per root path; the cache clears with the shared plugin
 * roots cache and via {@link clearAgentPluginRootCache}.
 */
export function classifyAgentPluginRoot(rootPath: string): Promise<AgentPluginRootStatus> {
	let cached = rootStatusCache.get(rootPath);
	if (!cached) {
		cached = classifyUncached(rootPath);
		rootStatusCache.set(rootPath, cached);
	}
	return cached;
}

/**
 * Whether a legacy plugin provider (claude-plugins, omp-plugins) may process a
 * root for the given surface. Roots governed by the Agent Plugins standard keep
 * their portable components (`skills`, `mcp`) exclusive to the standard loader,
 * while client-specific surfaces (commands, hooks, tools, …) still load from
 * hybrid packages. Fatally invalid Agent Plugins packages are rejected entirely.
 */
export async function legacyProviderAllowed(rootPath: string, surface: "skills" | "mcp" | "other"): Promise<boolean> {
	const status = await classifyAgentPluginRoot(rootPath);
	if (status.kind === "none") return true;
	if (status.kind === "invalid") return false;
	return surface === "other";
}
