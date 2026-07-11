import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@pk-nerdsaver-ai/pi-utils";
import { getMemoryRoot } from "../memories";
import { AgentRegistry } from "../registry/agent-registry";
import { buildDirectoryResource } from "./filesystem-resource";
import { validateRelativePath } from "./skill-protocol";
import type { InternalResource, InternalUrl, ProtocolHandler, UrlCompletion } from "./types";

const DEFAULT_MEMORY_FILE = "memory_summary.md";
const MEMORY_NAMESPACE = "root";

/**
 * Snapshot of memory roots for every registered session, deduped.
 * Each session has its own cwd (possibly a worktree), so subagents and main
 * may see different roots.
 */
export function memoryRootsFromRegistry(): string[] {
	const agentDir = getAgentDir();
	const roots: string[] = [];
	for (const ref of AgentRegistry.global().list()) {
		const sm = ref.session?.sessionManager;
		if (!sm) continue;
		const root = getMemoryRoot(agentDir, sm.getCwd());
		if (root && !roots.includes(root)) roots.push(root);
	}
	return roots;
}

function ensureWithinRoot(targetPath: string, rootPath: string): void {
	if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error("memory:// URL escapes memory root");
	}
}

function toMemoryValidationError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(message.replace("skill://", "memory://"));
}

/**
 * Resolve a memory:// URL to an absolute filesystem path under memory root.
 */
export function resolveMemoryUrlToPath(url: InternalUrl, memoryRoot: string): string {
	const namespace = url.rawHost || url.hostname;
	if (!namespace) {
		throw new Error("memory:// URL requires a namespace: memory://root");
	}
	if (namespace !== MEMORY_NAMESPACE) {
		throw new Error(`Unknown memory namespace: ${namespace}. Supported: ${MEMORY_NAMESPACE}`);
	}

	const rawPathname = url.rawPathname ?? url.pathname;
	const hasPath = rawPathname && rawPathname !== "/" && rawPathname !== "";
	if (!hasPath) {
		return path.resolve(memoryRoot, DEFAULT_MEMORY_FILE);
	}
	let relativePath: string;
	try {
		relativePath = decodeURIComponent(rawPathname.slice(1));
	} catch {
		throw new Error(`Invalid URL encoding in memory:// path: ${url.href}`);
	}

	try {
		validateRelativePath(relativePath);
	} catch (error) {
		throw toMemoryValidationError(error);
	}

	return path.resolve(memoryRoot, relativePath);
}

async function tryResolveInRoot(url: InternalUrl, memoryRoot: string): Promise<InternalResource | undefined> {
	const resolved = path.resolve(memoryRoot);
	let resolvedRoot: string;
	try {
		resolvedRoot = await fs.realpath(resolved);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}

	const targetPath = resolveMemoryUrlToPath(url, resolvedRoot);
	ensureWithinRoot(targetPath, resolvedRoot);

	const parentDir = path.dirname(targetPath);
	try {
		const realParent = await fs.realpath(parentDir);
		ensureWithinRoot(realParent, resolvedRoot);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	let realTargetPath: string;
	try {
		realTargetPath = await fs.realpath(targetPath);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}

	ensureWithinRoot(realTargetPath, resolvedRoot);

	const stat = await fs.stat(realTargetPath);
	if (stat.isDirectory()) {
		return buildDirectoryResource(url.href, realTargetPath);
	}
	if (!stat.isFile()) {
		throw new Error(`memory:// URL must resolve to a file or directory: ${url.href}`);
	}

	const content = await Bun.file(realTargetPath).text();
	const ext = path.extname(realTargetPath).toLowerCase();
	const contentType: InternalResource["contentType"] = ext === ".md" ? "text/markdown" : "text/plain";

	return {
		url: url.href,
		content,
		contentType,
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: realTargetPath,
		notes: [],
	};
}

/**
 * Protocol handler for memory:// URLs.
 *
 * Walks every active session's memory root. Worktree-based subagents have
 * their own root; first one containing the file wins. Parent and subagent
 * sharing a cwd see the same file regardless of order.
 */
export class MemoryProtocolHandler implements ProtocolHandler {
	readonly scheme = "memory";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const roots = memoryRootsFromRegistry();

		if (roots.length === 0) {
			throw new Error(
				"Memory artifacts are not available for this project yet. Run a session with memories enabled first.",
			);
		}

		let anyExists = false;
		for (const root of roots) {
			try {
				await fs.stat(root);
				anyExists = true;
			} catch (error) {
				if (isEnoent(error)) continue;
				throw error;
			}
			const result = await tryResolveInRoot(url, root);
			if (result) return result;
		}

		if (!anyExists) {
			throw new Error(
				"Memory artifacts are not available for this project yet. Run a session with memories enabled first.",
			);
		}

		throw new Error(`Memory file not found: ${url.href}`);
	}

	async complete(): Promise<UrlCompletion[]> {
		if (memoryRootsFromRegistry().length === 0) return [];
		return [{ value: MEMORY_NAMESPACE, description: "Project memory summary" }];
	}
}
