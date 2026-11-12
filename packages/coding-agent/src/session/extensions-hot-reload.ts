/**
 * Live reload of extensions (the TypeScript modules the extension runner loads).
 *
 * {@link ExtensionsReloader} diffs the extensions the session runs against the ones now on disk
 * and applies the difference one extension at a time: a changed extension is re-imported as a fresh
 * module instance and swapped in only if it starts; a new one is added; one whose file is gone is
 * unloaded. Every extension is atomic (fully swapped or untouched) and isolated: one that is
 * malformed, throws from its factory, or throws from `session_start` is reported in
 * {@link ExtensionsRefreshSummary.errors} and leaves its previous instance, and every other
 * extension, running. {@link describeExtensionsRefresh} is the user-visible report.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { ReboundExtension } from "../extensibility/extensions/loader";
import type { Extension } from "../extensibility/extensions/types";
import { collectExtensionSourcePaths } from "../extensibility/plugins/legacy-pi-compat";
import type { HotReloadSubsystem } from "./hot-reload";
import { sourceSignature } from "./tools-hot-reload";

/** Extension paths changed by one refresh, plus the ones that could not be applied. */
export interface ExtensionsRefreshSummary {
	added: string[];
	replaced: string[];
	removed: string[];
	errors: Array<{ path: string; error: string }>;
}

export interface ExtensionsRefreshOptions {
	/**
	 * Re-import only extensions whose source (entry file plus the local modules it imports) differs
	 * from the last time this reloader looked. Default: false, re-import every extension. An
	 * extension with no recorded baseline counts as changed either way.
	 */
	changedOnly?: boolean;
}

/** Re-reads the extension sources and applies the difference to the live session. */
export type ExtensionsRefresher = (options?: ExtensionsRefreshOptions) => Promise<ExtensionsRefreshSummary>;

export interface ExtensionsRefreshNotice {
	level: "info" | "warning";
	message: string;
}

/**
 * The status line for a refresh, e.g. `extensions reloaded: +1 ~2 -0`, one line per changed
 * extension (`+` added, `~` replaced, `-` removed), then one line per failed extension.
 * `undefined` when nothing changed and nothing failed.
 */
export function describeExtensionsRefresh(summary: ExtensionsRefreshSummary): ExtensionsRefreshNotice | undefined {
	const changed = summary.added.length + summary.replaced.length + summary.removed.length > 0;
	if (!changed && summary.errors.length === 0) return undefined;
	const counts = `+${summary.added.length} ~${summary.replaced.length} -${summary.removed.length}`;
	const failures = summary.errors.length > 0 ? `, ${summary.errors.length} failed` : "";
	const lines = [`extensions ${changed ? "reloaded" : "unchanged"}: ${counts}${failures}`];
	for (const extensionPath of summary.added) lines.push(`  + ${path.basename(extensionPath)}`);
	for (const extensionPath of summary.replaced) lines.push(`  ~ ${path.basename(extensionPath)}`);
	for (const extensionPath of summary.removed) lines.push(`  - ${path.basename(extensionPath)}`);
	for (const { path: extensionPath, error } of summary.errors)
		lines.push(`  ${path.basename(extensionPath)}: ${error}`);
	return { level: summary.errors.length > 0 ? "warning" : "info", message: lines.join("\n") };
}

/**
 * A fingerprint of an extension's source: the entry (a file, or a directory down to a few levels)
 * and every local module it imports. Changes when any of it is added, edited, or removed. When the
 * import graph cannot be walked (a syntax error, say) only the entry is covered.
 */
export async function extensionSignature(entryPath: string): Promise<string> {
	let graph: string[] = [];
	try {
		const nodeModules = `${path.sep}node_modules${path.sep}`;
		graph = (await collectExtensionSourcePaths(entryPath)).filter(modulePath => !modulePath.includes(nodeModules));
	} catch {
		// Unwalkable now; the signature changes when it becomes walkable.
	}
	return sourceSignature([entryPath, ...graph.filter(modulePath => modulePath !== entryPath)]);
}

type StartResult = { ok: true } | { ok: false; error: string };

/** What the reloader needs from the live session; the extension runner and the SDK supply it. */
export interface ExtensionsReloaderHost {
	/** Entry paths of the extensions that should be loaded now (discovery, settings, plugins). */
	discoverPaths: () => Promise<readonly string[]>;
	/** Every extension the runner has loaded, suspended ones included. */
	loadedExtensions: () => readonly Extension[];
	/** Import `entryPath` afresh and run its factory against staged state; never throws. */
	load: (entryPath: string) => Promise<{ rebound: ReboundExtension; error: null } | { rebound: null; error: string }>;
	/** Swap `previous` for `next`; `previous` keeps running if `next` fails to start. Never throws. */
	replace: (previous: Extension, next: Extension, commit: () => void) => Promise<StartResult>;
	/** Start `next` as a new extension; it is dropped again if it fails to start. Never throws. */
	add: (next: Extension, commit: () => void) => Promise<StartResult>;
	/** Shut `extension` down and drop it. */
	remove: (extension: Extension) => Promise<void>;
	/**
	 * Bring the session's tool registry in line with the extension tool map for these names after
	 * it changed underneath it (an extension replaced, added, rolled back, or removed).
	 */
	reconcileTools: (names: readonly string[]) => Promise<void>;
}

/** Applies extension source changes to a running session, one atomic extension at a time. */
export class ExtensionsReloader {
	readonly #host: ExtensionsReloaderHost;
	readonly #baseline = new Map<string, string>();

	constructor(host: ExtensionsReloaderHost) {
		this.#host = host;
	}

	/** Records the current source of every loaded extension as the baseline {@link refresh} compares against. */
	async captureBaseline(): Promise<void> {
		for (const extension of this.#host.loadedExtensions()) {
			if (isInline(extension)) continue;
			this.#baseline.set(extension.resolvedPath, await extensionSignature(extension.resolvedPath));
		}
	}

	/** Every extension entry path the loader would pick up now, for watchers. */
	entryPaths(): string[] {
		return this.#host
			.loadedExtensions()
			.filter(extension => !isInline(extension))
			.map(extension => extension.resolvedPath);
	}

	async refresh(options: ExtensionsRefreshOptions = {}): Promise<ExtensionsRefreshSummary> {
		const summary: ExtensionsRefreshSummary = { added: [], replaced: [], removed: [], errors: [] };
		const fail = (extensionPath: string, error: unknown): void => {
			summary.errors.push({ path: extensionPath, error: error instanceof Error ? error.message : String(error) });
		};
		let discovered: readonly string[];
		try {
			discovered = await this.#host.discoverPaths();
		} catch (error) {
			fail("(discovery)", error);
			return summary;
		}
		const loadedByPath = new Map<string, Extension>();
		for (const extension of this.#host.loadedExtensions()) {
			if (!isInline(extension)) loadedByPath.set(extension.resolvedPath, extension);
		}
		const seen = new Set<string>();
		for (const entryPath of discovered) {
			if (seen.has(entryPath)) continue;
			seen.add(entryPath);
			try {
				await this.#refreshOne(entryPath, loadedByPath.get(entryPath), options, summary);
			} catch (error) {
				// The host contract is "never throws"; an extension that breaks it must still not stop the rest.
				fail(entryPath, error);
			}
		}
		for (const [resolvedPath, extension] of loadedByPath) {
			if (seen.has(resolvedPath) || (await exists(resolvedPath))) continue;
			try {
				await this.#host.remove(extension);
				this.#baseline.delete(resolvedPath);
				summary.removed.push(extension.path);
				await this.#host.reconcileTools([...extension.tools.keys()]);
			} catch (error) {
				fail(extension.path, error);
			}
		}
		return summary;
	}

	async #refreshOne(
		entryPath: string,
		loaded: Extension | undefined,
		options: ExtensionsRefreshOptions,
		summary: ExtensionsRefreshSummary,
	): Promise<void> {
		const signature = await extensionSignature(entryPath);
		const unchanged = this.#baseline.get(entryPath) === signature;
		// Both a running extension and one that failed to load last time wait for their source to
		// change under `changedOnly`; an explicit refresh retries everything.
		if (options.changedOnly && unchanged) return;
		this.#baseline.set(entryPath, signature);
		const loadedResult = await this.#host.load(entryPath);
		if (!loadedResult.rebound) {
			summary.errors.push({ path: entryPath, error: loadedResult.error });
			return;
		}
		const { extension: next, commit } = loadedResult.rebound;
		if (!loaded) {
			const added = await this.#host.add(next, commit);
			if (added.ok) summary.added.push(entryPath);
			else summary.errors.push({ path: entryPath, error: added.error });
			return;
		}
		const replaced = await this.#host.replace(loaded, next, commit);
		if (replaced.ok) summary.replaced.push(entryPath);
		else summary.errors.push({ path: entryPath, error: replaced.error });
		// Success or rollback, the tool registry may now name tools of the wrong instance.
		await this.#host.reconcileTools([...new Set([...loaded.tools.keys(), ...next.tools.keys()])]);
	}
}

export function createExtensionsHotReloadSubsystem(options: {
	roots: () => readonly string[];
	enabled?: () => boolean;
	reload: () => Promise<void>;
}): HotReloadSubsystem {
	return {
		id: "extensions",
		source: "extensions",
		enabled: options.enabled,
		signature: () => sourceSignature(options.roots()),
		reload: options.reload,
		deferredMessage: "extension files changed; reload deferred until the current turn ends",
		errorPrefix: "extensions hot reload failed",
	};
}

/** Factory extensions the SDK appends (`<inline-N>`) have no source file to reload. */
function isInline(extension: Extension): boolean {
	return extension.resolvedPath.startsWith("<inline");
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		return true;
	}
}
