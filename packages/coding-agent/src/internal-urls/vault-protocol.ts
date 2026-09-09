import * as fs from "node:fs";
import * as path from "node:path";
import { $which, isEnoent } from "@oh-my-pi/pi-utils";
import { isSettingsInitialized, settings } from "../config/settings";
import { getDefault } from "../config/settings-schema";
import { isMarkdownPath } from "../utils/lang-from-path";
import { parseInternalUrl } from "./parse";
import { validateRelativePath } from "./skill-protocol";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, WriteContext } from "./types";

const DARWIN_OBSIDIAN_BINARY = "/Applications/Obsidian.app/Contents/MacOS/obsidian";
const DEFAULT_OBSIDIAN_TIMEOUT_MS = 30_000;

type ContentType = InternalResource["contentType"];
type VaultParamValue = string | true;
type VaultParams = Record<string, VaultParamValue>;

type FileOp = "outline" | "backlinks" | "links" | "tags" | "properties" | "tasks" | "wordcount" | "history" | "base";

type VaultOp =
	| "search"
	| "daily"
	| "daily-path"
	| "tags"
	| "tag"
	| "tasks"
	| "orphans"
	| "unresolved"
	| "deadends"
	| "bases"
	| "bookmarks"
	| "recents"
	| "templates"
	| "aliases"
	| "properties"
	| "property";

const FILE_OPS: Record<FileOp, true> = {
	outline: true,
	backlinks: true,
	links: true,
	tags: true,
	properties: true,
	tasks: true,
	wordcount: true,
	history: true,
	base: true,
};

const VAULT_OPS: Record<VaultOp, true> = {
	search: true,
	daily: true,
	"daily-path": true,
	tags: true,
	tag: true,
	tasks: true,
	orphans: true,
	unresolved: true,
	deadends: true,
	bases: true,
	bookmarks: true,
	recents: true,
	templates: true,
	aliases: true,
	properties: true,
	property: true,
};

export interface VaultReference {
	vault: string | null;
	active: boolean;
	forwardVault: boolean;
	display: string;
}

export type ParsedVaultUrl =
	| { kind: "list-vaults"; url: string; params: VaultParams }
	| { kind: "vault-info"; url: string; ref: VaultReference; params: VaultParams }
	| { kind: "fs-dir"; url: string; ref: VaultReference; relativePath: string; params: VaultParams }
	| { kind: "fs-file"; url: string; ref: VaultReference; relativePath: string; params: VaultParams }
	| { kind: "file-op"; url: string; ref: VaultReference; relativePath: string; op: FileOp; params: VaultParams }
	| { kind: "vault-op"; url: string; ref: VaultReference; op: VaultOp; params: VaultParams };

export interface ObsidianSpawnResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface VaultProtocolHandlerOptions {
	spawnObsidian?: typeof spawnObsidian;
	resolveObsidianBinary?: () => string | null;
}

interface CliInvocation {
	args: string[];
	contentType: ContentType;
	opLabel: string;
}

interface VaultCounts {
	files: number;
	folders: number;
}

let cachedObsidianBinary: string | null | undefined;
let binaryOverrideForTests: string | null | undefined;
let cachedVaultDirectory: Map<string, string> | undefined;
let cachedActiveVaultPath: string | undefined;
const cachedVaultInfo = new Map<string, string>();

function toVaultValidationError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(message.replace("skill://", "vault://"));
}

function getContentType(filePath: string): ContentType {
	if (isMarkdownPath(filePath)) return "text/markdown";
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".json") return "application/json";
	return "text/plain";
}

function ensureWithinRoot(targetPath: string, rootPath: string): void {
	if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error("vault:// URL escapes vault root");
	}
}

function encodePathComponent(component: string): string {
	return encodeURIComponent(component).replaceAll("%2F", "/");
}

function encodeRelativePath(relativePath: string): string {
	return relativePath
		.split("/")
		.filter(segment => segment.length > 0)
		.map(encodeURIComponent)
		.join("/");
}

function decodeVaultPath(url: InternalUrl): {
	rawPathname: string;
	relativePath: string;
	hasPath: boolean;
	isDirectory: boolean;
} {
	const rawPathname = url.rawPathname ?? url.pathname;
	const hasPath = rawPathname !== undefined && rawPathname !== "" && rawPathname !== "/";
	const isDirectory = rawPathname === "/" || rawPathname.endsWith("/");
	if (!hasPath) {
		return { rawPathname, relativePath: "", hasPath: false, isDirectory };
	}

	let decoded: string;
	try {
		decoded = decodeURIComponent(rawPathname.slice(1).replaceAll("\\", "/"));
	} catch {
		throw new Error(`Invalid URL encoding in vault:// path: ${url.href}`);
	}

	try {
		validateRelativePath(decoded);
	} catch (error) {
		throw toVaultValidationError(error);
	}

	return { rawPathname, relativePath: decoded.replace(/\/+$/, ""), hasPath: true, isDirectory };
}

function paramsFromUrl(url: InternalUrl): VaultParams {
	const params: VaultParams = {};
	for (const [key, value] of url.searchParams) {
		params[key] = value === "" ? true : value;
	}
	return params;
}

function makeVaultReference(host: string): VaultReference {
	if (!host || host === "_") {
		return { vault: null, active: true, forwardVault: false, display: "_" };
	}
	return { vault: host, active: false, forwardVault: true, display: host };
}

function isFileOp(rawOp: string): rawOp is FileOp {
	return FILE_OPS[rawOp as FileOp] === true;
}

function isVaultOp(rawOp: string): rawOp is VaultOp {
	return VAULT_OPS[rawOp as VaultOp] === true;
}

function parseVaultOp(rawOp: string, hasFilePath: boolean): FileOp | VaultOp {
	if (hasFilePath) {
		if (!isFileOp(rawOp)) {
			throw new Error(`Unsupported vault:// file op: ${rawOp}`);
		}
		return rawOp;
	}
	if (!isVaultOp(rawOp)) {
		throw new Error(`Unsupported vault:// vault op: ${rawOp}`);
	}
	return rawOp;
}

export function parseVaultUrl(input: string | InternalUrl): ParsedVaultUrl {
	const url = typeof input === "string" ? parseInternalUrl(input) : input;
	const host = url.rawHost || url.hostname;
	const params = paramsFromUrl(url);
	const rawOp = typeof params.op === "string" ? params.op : undefined;
	const { rawPathname, relativePath, hasPath, isDirectory } = decodeVaultPath(url);

	if (!host && !hasPath && !rawOp) {
		return { kind: "list-vaults", url: url.href, params };
	}

	const ref = makeVaultReference(host);
	if (rawOp) {
		const op = parseVaultOp(rawOp, relativePath.length > 0);
		if (relativePath.length > 0) {
			return { kind: "file-op", url: url.href, ref, relativePath, op: op as FileOp, params };
		}
		return { kind: "vault-op", url: url.href, ref, op: op as VaultOp, params };
	}

	if (!host && !hasPath) {
		return { kind: "list-vaults", url: url.href, params };
	}

	if (!hasPath && rawPathname !== "/") {
		return { kind: "vault-info", url: url.href, ref, params };
	}

	if (isDirectory) {
		return { kind: "fs-dir", url: url.href, ref, relativePath, params };
	}

	return { kind: "fs-file", url: url.href, ref, relativePath, params };
}

function abortError(): Error {
	return new Error("obsidian command cancelled");
}

export async function spawnObsidian(
	bin: string,
	args: string[],
	signal?: AbortSignal,
	timeoutMs = DEFAULT_OBSIDIAN_TIMEOUT_MS,
): Promise<ObsidianSpawnResult> {
	if (signal?.aborted) throw abortError();

	const proc = Bun.spawn({
		cmd: [bin, ...args],
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(proc.stdout as ReadableStream<Uint8Array>).text();
	const stderr = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
	const aborted = Promise.withResolvers<never>();
	const timedOut = Promise.withResolvers<never>();

	const abortHandler = (): void => {
		proc.kill();
		aborted.reject(abortError());
	};
	if (signal) signal.addEventListener("abort", abortHandler, { once: true });

	const timeout = setTimeout(() => {
		proc.kill();
		timedOut.reject(new Error(`obsidian command timed out after ${timeoutMs}ms`));
	}, timeoutMs);

	const completed = proc.exited.then(async exitCode => ({
		stdout: await stdout,
		stderr: await stderr,
		exitCode,
	}));

	try {
		return await Promise.race([completed, aborted.promise, timedOut.promise]);
	} finally {
		clearTimeout(timeout);
		if (signal) signal.removeEventListener("abort", abortHandler);
	}
}

export function resolveObsidianBinary(): string | null {
	if (binaryOverrideForTests !== undefined) return binaryOverrideForTests;
	if (cachedObsidianBinary !== undefined) return cachedObsidianBinary;

	const onPath = $which("obsidian");
	if (onPath) {
		cachedObsidianBinary = onPath;
		return cachedObsidianBinary;
	}

	if (process.platform === "darwin" && fs.existsSync(DARWIN_OBSIDIAN_BINARY)) {
		cachedObsidianBinary = DARWIN_OBSIDIAN_BINARY;
		return cachedObsidianBinary;
	}

	cachedObsidianBinary = null;
	return cachedObsidianBinary;
}

/**
 * Whether the `vault://` protocol is enabled in the active settings profile.
 *
 * Reads `vault.enabled` from the global settings singleton. Falls back to the
 * schema default when settings are not yet initialized (e.g. during isolated
 * unit tests that exercise the handler before the host calls `Settings.init`).
 */
export function isVaultEnabled(): boolean {
	if (!isSettingsInitialized()) return getDefault("vault.enabled");
	try {
		return settings.get("vault.enabled");
	} catch {
		// Defensive: if the settings proxy throws (e.g. shutdown race), fall back to default.
		return getDefault("vault.enabled");
	}
}

export function hasObsidian(): boolean {
	return isVaultEnabled() && resolveObsidianBinary() !== null;
}

const VAULT_DISABLED_MESSAGE =
	"vault:// is disabled. Enable it by setting `vault.enabled = true` (Settings → Tools → Obsidian Vault).";

export class VaultDisabledError extends Error {
	constructor() {
		super(VAULT_DISABLED_MESSAGE);
		this.name = "VaultDisabledError";
	}
}

function missingBinaryError(): Error {
	return new Error(
		"Obsidian CLI binary not found. Checked PATH entry 'obsidian' and " +
			`${DARWIN_OBSIDIAN_BINARY}. Install Obsidian from https://obsidian.md or add its CLI binary to PATH.`,
	);
}

function requireObsidianBinary(resolveBinary: () => string | null): string {
	const bin = resolveBinary();
	if (bin) return bin;
	throw missingBinaryError();
}

function cliReportedError(result: ObsidianSpawnResult): string | undefined {
	const stderr = result.stderr.trim();
	if (stderr.startsWith("Error:")) return stderr;
	const stdout = result.stdout.trim();
	if (stdout.startsWith("Error:")) return stdout;
	return undefined;
}

function assertCliSuccess(opLabel: string, result: ObsidianSpawnResult): void {
	const reportedError = cliReportedError(result);
	if (result.exitCode === 0 && !reportedError) return;
	const stderr = result.stderr.trim();
	const stdout = result.stdout.trim();
	const detail = reportedError || stderr || stdout || `obsidian exited with code ${result.exitCode}`;
	throw new Error(`vault://${opLabel} failed: ${detail}`);
}

function parseVaultDirectory(stdout: string): Map<string, string> {
	const vaults = new Map<string, string>();
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trimEnd();
		if (!trimmed) continue;
		const tab = trimmed.indexOf("\t");
		if (tab <= 0) continue;
		const name = trimmed.slice(0, tab);
		const vaultPath = trimmed.slice(tab + 1).trim();
		if (!name || !vaultPath) continue;
		vaults.set(name, path.resolve(vaultPath));
	}
	return vaults;
}

function parseActiveVaultPath(stdout: string): string {
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const tab = trimmed.indexOf("\t");
		if (tab > 0 && trimmed.slice(0, tab).toLowerCase() === "path") {
			return trimmed.slice(tab + 1).trim();
		}
		const colon = trimmed.indexOf(":");
		if (colon > 0 && trimmed.slice(0, colon).toLowerCase() === "path") {
			return trimmed.slice(colon + 1).trim();
		}
	}
	const trimmed = stdout.trim();
	return trimmed.includes("\n") ? "" : trimmed;
}

function getCachedVaultRoot(ref: VaultReference): string | undefined {
	if (ref.active) return cachedActiveVaultPath ? path.resolve(cachedActiveVaultPath) : undefined;
	if (!ref.vault) return undefined;
	const cached = cachedVaultDirectory?.get(ref.vault);
	return cached ? path.resolve(cached) : undefined;
}

/** Vault roots already resolved by the protocol handler, for native edit policy. */
export function cachedVaultRoots(): Array<{ name: string; root: string }> {
	const roots: Array<{ name: string; root: string }> = [];
	if (cachedActiveVaultPath) roots.push({ name: "_", root: path.resolve(cachedActiveVaultPath) });
	for (const [name, root] of cachedVaultDirectory ?? []) {
		roots.push({ name, root: path.resolve(root) });
	}
	return roots;
}

function findExistingAncestorSync(targetPath: string, rootPath: string): string {
	let current = targetPath;
	while (true) {
		ensureWithinRoot(current, rootPath);
		try {
			return fs.realpathSync(current);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			const parent = path.dirname(current);
			if (parent === current) throw error;
			current = parent;
		}
	}
}

export function resolveVaultUrlToPath(input: string | InternalUrl): string {
	if (!isVaultEnabled()) throw new VaultDisabledError();
	const parsed = parseVaultUrl(input);
	if (parsed.kind !== "fs-file" && parsed.kind !== "fs-dir") {
		throw new Error("vault:// path resolution only supports plain filesystem paths");
	}

	const cachedRoot = getCachedVaultRoot(parsed.ref);
	if (!cachedRoot) {
		throw new Error(
			"vault:// path resolution requires a cached vault root; read vault:// first or use the write tool",
		);
	}

	const resolvedRoot = fs.realpathSync(cachedRoot);
	const targetPath = parsed.relativePath ? path.resolve(resolvedRoot, parsed.relativePath) : resolvedRoot;
	ensureWithinRoot(targetPath, resolvedRoot);

	try {
		const realTarget = fs.realpathSync(targetPath);
		ensureWithinRoot(realTarget, resolvedRoot);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		const realParent = findExistingAncestorSync(path.dirname(targetPath), resolvedRoot);
		ensureWithinRoot(realParent, resolvedRoot);
	}

	return targetPath;
}

async function findExistingAncestor(targetPath: string, rootPath: string): Promise<string> {
	let current = targetPath;
	while (true) {
		ensureWithinRoot(current, rootPath);
		try {
			return await fs.promises.realpath(current);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			const parent = path.dirname(current);
			if (parent === current) throw error;
			current = parent;
		}
	}
}

async function countVaultEntries(rootPath: string): Promise<VaultCounts> {
	const pending = [rootPath];
	let files = 0;
	let folders = 0;
	while (pending.length > 0) {
		const dir = pending.pop();
		if (!dir) continue;
		const entries = await fs.promises.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				folders++;
				pending.push(entryPath);
			} else if (entry.isFile()) {
				files++;
			}
		}
	}
	return { files, folders };
}

function formatVaultPathForLink(ref: VaultReference, relativePath: string, trailingSlash: boolean): string {
	const encodedVault = ref.active ? "_" : encodePathComponent(ref.display);
	const encodedPath = encodeRelativePath(relativePath);
	const suffix = trailingSlash ? "/" : "";
	return encodedPath ? `vault://${encodedVault}/${encodedPath}${suffix}` : `vault://${encodedVault}/`;
}

function paramString(params: VaultParams, name: string): string | undefined {
	const value = params[name];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireParam(params: VaultParams, name: string, op: string): string {
	const value = paramString(params, name);
	if (value) return value;
	throw new Error(`vault://${op} requires '${name}' query parameter`);
}

function validateQueryPath(params: VaultParams, name: string): string | undefined {
	const value = paramString(params, name);
	if (!value) return undefined;
	try {
		validateRelativePath(value.replaceAll("\\", "/"));
	} catch (error) {
		throw toVaultValidationError(error);
	}
	return value;
}

export function buildObsidianCliInvocation(
	parsed: Extract<ParsedVaultUrl, { kind: "file-op" | "vault-op" }>,
): CliInvocation {
	if (parsed.kind === "file-op") {
		const pathArg = `path=${parsed.relativePath}`;
		switch (parsed.op) {
			case "outline":
				return { args: ["outline", pathArg, "format=md"], contentType: "text/markdown", opLabel: "outline" };
			case "backlinks":
				return {
					args: ["backlinks", pathArg, "counts", "format=tsv"],
					contentType: "text/plain",
					opLabel: "backlinks",
				};
			case "links":
				return { args: ["links", pathArg], contentType: "text/plain", opLabel: "links" };
			case "tags":
				return {
					args: ["tags", pathArg, "counts", "format=json"],
					contentType: "application/json",
					opLabel: "tags",
				};
			case "properties":
				return {
					args: ["properties", pathArg, "format=yaml"],
					contentType: "text/markdown",
					opLabel: "properties",
				};
			case "tasks":
				return {
					args: ["tasks", pathArg, "verbose", "format=json"],
					contentType: "application/json",
					opLabel: "tasks",
				};
			case "wordcount":
				return { args: ["wordcount", pathArg], contentType: "text/plain", opLabel: "wordcount" };
			case "history":
				return { args: ["history", pathArg], contentType: "text/plain", opLabel: "history" };
			case "base": {
				const view = requireParam(parsed.params, "view", "base");
				return {
					args: ["base:query", pathArg, `view=${view}`, "format=md"],
					contentType: "text/markdown",
					opLabel: "base",
				};
			}
		}
	}

	switch (parsed.op) {
		case "search": {
			const query = requireParam(parsed.params, "q", "search");
			const args = ["search:context", `query=${query}`];
			const pathFilter = validateQueryPath(parsed.params, "path");
			if (pathFilter) args.push(`path=${pathFilter}`);
			const limit = paramString(parsed.params, "limit");
			if (limit) args.push(`limit=${limit}`);
			if (parsed.params.case !== undefined) args.push("case");
			args.push("format=json");
			return { args, contentType: "application/json", opLabel: "search" };
		}
		case "daily":
			return { args: ["daily:read"], contentType: "text/markdown", opLabel: "daily" };
		case "daily-path":
			return { args: ["daily:path"], contentType: "text/plain", opLabel: "daily-path" };
		case "tags":
			return {
				args: ["tags", "counts", "format=json"],
				contentType: "application/json",
				opLabel: "tags",
			};
		case "tag": {
			const tag = paramString(parsed.params, "name") ?? requireParam(parsed.params, "tag", "tag");
			return { args: ["tag", `name=${tag}`, "verbose"], contentType: "text/plain", opLabel: "tag" };
		}
		case "tasks":
			return {
				args: ["tasks", "todo", "verbose", "format=json"],
				contentType: "application/json",
				opLabel: "tasks",
			};
		case "orphans":
			return { args: ["orphans"], contentType: "text/plain", opLabel: "orphans" };
		case "unresolved":
			return {
				args: ["unresolved", "counts", "verbose", "format=json"],
				contentType: "application/json",
				opLabel: "unresolved",
			};
		case "deadends":
			return { args: ["deadends"], contentType: "text/plain", opLabel: "deadends" };
		case "bases":
			return { args: ["bases"], contentType: "text/plain", opLabel: "bases" };
		case "bookmarks":
			return {
				args: ["bookmarks", "verbose", "format=json"],
				contentType: "application/json",
				opLabel: "bookmarks",
			};
		case "recents":
			return { args: ["recents"], contentType: "text/plain", opLabel: "recents" };
		case "templates":
			return { args: ["templates"], contentType: "text/plain", opLabel: "templates" };
		case "aliases":
			return {
				args: ["aliases", "verbose", "format=json"],
				contentType: "application/json",
				opLabel: "aliases",
			};
		case "properties":
			return {
				args: ["properties", "counts", "format=yaml"],
				contentType: "text/markdown",
				opLabel: "properties",
			};
		case "property": {
			const name = requireParam(parsed.params, "name", "property");
			const propertyPath = requireParam(parsed.params, "path", "property");
			validateQueryPath(parsed.params, "path");
			return {
				args: ["property:read", `name=${name}`, `path=${propertyPath}`],
				contentType: "text/plain",
				opLabel: "property",
			};
		}
	}
}

export class VaultProtocolHandler implements ProtocolHandler {
	readonly scheme = "vault";
	readonly immutable = false;

	readonly #spawnObsidian: typeof spawnObsidian;
	readonly #resolveObsidianBinary: () => string | null;

	constructor(options: VaultProtocolHandlerOptions = {}) {
		this.#spawnObsidian = options.spawnObsidian ?? spawnObsidian;
		this.#resolveObsidianBinary = options.resolveObsidianBinary ?? resolveObsidianBinary;
	}

	static resetForTests(): void {
		cachedObsidianBinary = undefined;
		binaryOverrideForTests = undefined;
		cachedVaultDirectory = undefined;
		cachedActiveVaultPath = undefined;
		cachedVaultInfo.clear();
	}

	static setObsidianBinaryForTests(value: string | null | undefined): void {
		binaryOverrideForTests = value;
		cachedObsidianBinary = undefined;
	}

	static setVaultDirectoryForTests(entries: ReadonlyMap<string, string> | Record<string, string> | undefined): void {
		if (!entries) {
			cachedVaultDirectory = undefined;
			return;
		}
		if (entries instanceof Map) {
			cachedVaultDirectory = new Map(entries);
			return;
		}
		const record = entries as Record<string, string>;
		cachedVaultDirectory = new Map<string, string>();
		for (const name in record) {
			cachedVaultDirectory.set(name, record[name]);
		}
	}

	static setActiveVaultPathForTests(vaultPath: string | undefined): void {
		cachedActiveVaultPath = vaultPath;
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (!isVaultEnabled()) throw new VaultDisabledError();
		const parsed = parseVaultUrl(url);
		switch (parsed.kind) {
			case "list-vaults":
				return this.#listVaults(parsed, context);
			case "vault-info":
				return this.#vaultInfo(parsed, context);
			case "fs-dir":
				return this.#listDir(parsed, context);
			case "fs-file":
				return this.#readFile(parsed, context);
			case "file-op":
			case "vault-op":
				return this.#runCli(parsed, context);
		}
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		if (!isVaultEnabled()) throw new VaultDisabledError();
		const parsed = parseVaultUrl(url);
		if (parsed.kind !== "fs-file") {
			throw new Error("vault:// write only supports plain file paths");
		}
		await this.#writeFile(parsed, content, context);
	}

	async #spawn(args: string[], context?: ResolveContext | WriteContext): Promise<ObsidianSpawnResult> {
		const bin = requireObsidianBinary(this.#resolveObsidianBinary);
		return this.#spawnObsidian(bin, args, context?.signal, DEFAULT_OBSIDIAN_TIMEOUT_MS);
	}

	async #loadVaultDirectory(context?: ResolveContext | WriteContext): Promise<Map<string, string>> {
		if (cachedVaultDirectory) return cachedVaultDirectory;
		const result = await this.#spawn(["vaults", "verbose"], context);
		assertCliSuccess("vaults", result);
		cachedVaultDirectory = parseVaultDirectory(result.stdout);
		return cachedVaultDirectory;
	}

	async #resolveVaultRoot(ref: VaultReference, context?: ResolveContext | WriteContext): Promise<string> {
		const cached = getCachedVaultRoot(ref);
		if (cached) return cached;

		if (ref.active) {
			const result = await this.#spawn(["vault", "info", "path"], context);
			assertCliSuccess("vault info path", result);
			const activePath = parseActiveVaultPath(result.stdout);
			if (!activePath) {
				throw new Error("vault:// active vault path was empty");
			}
			cachedActiveVaultPath = path.resolve(activePath);
			return cachedActiveVaultPath;
		}

		if (!ref.vault) {
			throw new Error("vault:// URL requires a vault name or '_' for the active vault");
		}
		const vaults = await this.#loadVaultDirectory(context);
		const root = vaults.get(ref.vault);
		if (!root) {
			const available = Array.from(vaults.keys()).sort().join(", ") || "none";
			throw new Error(`Unknown Obsidian vault: ${ref.vault}\nAvailable: ${available}`);
		}
		return path.resolve(root);
	}

	#vaultCliArg(ref: VaultReference): string[] {
		return ref.forwardVault && ref.vault ? [`vault=${ref.vault}`] : [];
	}

	async #listVaults(
		parsed: Extract<ParsedVaultUrl, { kind: "list-vaults" }>,
		context?: ResolveContext,
	): Promise<InternalResource> {
		const vaults = await this.#loadVaultDirectory(context);
		const entries = Array.from(vaults.keys()).sort((a, b) => a.localeCompare(b));
		const listing =
			entries.length === 0
				? "(none)"
				: entries.map(name => `- [${name}](vault://${encodePathComponent(name)}/)`).join("\n");
		const content = `# Obsidian Vaults\n\n${entries.length} vault${entries.length === 1 ? "" : "s"} available:\n\n${listing}\n`;
		return {
			url: parsed.url,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			immutable: true,
		};
	}

	async #vaultInfo(
		parsed: Extract<ParsedVaultUrl, { kind: "vault-info" }>,
		context?: ResolveContext,
	): Promise<InternalResource> {
		const root = await this.#resolveVaultRoot(parsed.ref, context);
		const cacheKey = parsed.ref.active ? "_" : (parsed.ref.vault ?? "_");
		let cliInfo = cachedVaultInfo.get(cacheKey);
		if (cliInfo === undefined) {
			const result = await this.#spawn([...this.#vaultCliArg(parsed.ref), "vault", "info"], context);
			assertCliSuccess("vault info", result);
			cliInfo = result.stdout.trim();
			cachedVaultInfo.set(cacheKey, cliInfo);
		}
		const counts = await countVaultEntries(root);
		const payload = {
			name: parsed.ref.display,
			rootPath: root,
			files: counts.files,
			folders: counts.folders,
			info: cliInfo,
		};
		const content = `${JSON.stringify(payload, null, 2)}\n`;
		return {
			url: parsed.url,
			content,
			contentType: "application/json",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: root,
			immutable: true,
		};
	}

	async #resolveFsTarget(
		parsed: Extract<ParsedVaultUrl, { kind: "fs-dir" | "fs-file" }>,
		context?: ResolveContext | WriteContext,
	): Promise<{ root: string; targetPath: string }> {
		const root = await this.#resolveVaultRoot(parsed.ref, context);
		const resolvedRoot = await fs.promises.realpath(root);
		const targetPath = parsed.relativePath ? path.resolve(resolvedRoot, parsed.relativePath) : resolvedRoot;
		ensureWithinRoot(targetPath, resolvedRoot);
		return { root: resolvedRoot, targetPath };
	}

	async #listDir(
		parsed: Extract<ParsedVaultUrl, { kind: "fs-dir" | "fs-file" }>,
		context?: ResolveContext,
	): Promise<InternalResource> {
		const { root, targetPath } = await this.#resolveFsTarget(parsed, context);
		const realTargetPath = await fs.promises.realpath(targetPath);
		ensureWithinRoot(realTargetPath, root);
		const stat = await fs.promises.stat(realTargetPath);
		if (!stat.isDirectory()) {
			throw new Error(`vault:// URL must resolve to a directory: ${parsed.url}`);
		}
		const entries = await fs.promises.readdir(realTargetPath, { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		const baseRelative = parsed.relativePath ? `${parsed.relativePath}/` : "";
		const lines = entries.map(entry => {
			const entryRelativePath = `${baseRelative}${entry.name}`;
			const isDir = entry.isDirectory();
			const href = formatVaultPathForLink(parsed.ref, entryRelativePath, isDir);
			return `- [${entry.name}${isDir ? "/" : ""}](${href})`;
		});
		const listing = lines.length === 0 ? "(empty)" : lines.join("\n");
		const titlePath = parsed.relativePath ? `/${parsed.relativePath}/` : "/";
		const content = `# Vault ${parsed.ref.display}${titlePath}\n\n${entries.length} entr${entries.length === 1 ? "y" : "ies"}:\n\n${listing}\n`;
		return {
			url: parsed.url,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: realTargetPath,
			immutable: true,
		};
	}

	async #readFile(
		parsed: Extract<ParsedVaultUrl, { kind: "fs-file" }>,
		context?: ResolveContext,
	): Promise<InternalResource> {
		const { root, targetPath } = await this.#resolveFsTarget(parsed, context);
		const parentDir = path.dirname(targetPath);
		try {
			const realParent = await fs.promises.realpath(parentDir);
			ensureWithinRoot(realParent, root);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}

		let realTargetPath: string;
		try {
			realTargetPath = await fs.promises.realpath(targetPath);
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`Vault file not found: ${parsed.url}`);
			}
			throw error;
		}
		ensureWithinRoot(realTargetPath, root);
		const stat = await fs.promises.stat(realTargetPath);
		if (stat.isDirectory()) {
			return this.#listDir(parsed, context);
		}
		if (!stat.isFile()) {
			throw new Error(`vault:// URL must resolve to a file or directory: ${parsed.url}`);
		}

		const content = await Bun.file(realTargetPath).text();
		return {
			url: parsed.url,
			content,
			contentType: getContentType(realTargetPath),
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: realTargetPath,
		};
	}

	async #writeFile(
		parsed: Extract<ParsedVaultUrl, { kind: "fs-file" }>,
		content: string,
		context?: WriteContext,
	): Promise<void> {
		const { root, targetPath } = await this.#resolveFsTarget(parsed, context);
		try {
			const realTargetPath = await fs.promises.realpath(targetPath);
			ensureWithinRoot(realTargetPath, root);
			const stat = await fs.promises.stat(realTargetPath);
			if (stat.isDirectory()) {
				throw new Error(`vault:// URL must resolve to a file: ${parsed.url}`);
			}
		} catch (error) {
			if (!isEnoent(error)) throw error;
			const parentDir = path.dirname(targetPath);
			const existingAncestor = await findExistingAncestor(parentDir, root);
			ensureWithinRoot(existingAncestor, root);
			await fs.promises.mkdir(parentDir, { recursive: true });
			const realParent = await fs.promises.realpath(parentDir);
			ensureWithinRoot(realParent, root);
		}
		await Bun.write(targetPath, content);
	}

	async #runCli(
		parsed: Extract<ParsedVaultUrl, { kind: "file-op" | "vault-op" }>,
		context?: ResolveContext,
	): Promise<InternalResource> {
		const invocation = buildObsidianCliInvocation(parsed);
		const args = [...this.#vaultCliArg(parsed.ref), ...invocation.args];
		const result = await this.#spawn(args, context);
		assertCliSuccess(invocation.opLabel, result);
		return {
			url: parsed.url,
			content: result.stdout,
			contentType: invocation.contentType,
			size: Buffer.byteLength(result.stdout, "utf-8"),
			immutable: true,
		};
	}
}
