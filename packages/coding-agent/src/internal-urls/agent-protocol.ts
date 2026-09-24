/**
 * Protocol handler for agent:// URLs.
 *
 * Resolves agent output IDs against the artifacts directories of every active
 * session. Parents and subagents share outputs via this registry: a subagent
 * can read its parent's output IDs because both sessions are registered in
 * the shared context.
 *
 * URL forms:
 * - agent://<id> - Full output content. Nested subagent outputs are
 *   dot-qualified ids (`agent://Parent.Child` resolves `Parent.Child.md`).
 * - agent://<id>/<path> - JSON extraction: each segment is an object key, or
 *   an array index when the current value is an array
 *   (`agent://Parent.Child/reports/0/data`)
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { executeSend, isIrcEnabled } from "../irc/messaging";
import { artifactsDirsFromRegistry } from "./registry-helpers";
import type {
	InternalResource,
	InternalWriteResult,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	UrlCompletion,
	WriteContext,
} from "./types";

/**
 * Walk `segments` into a JSON value: object segments index by key, array
 * segments by numeric index. Returns `undefined` once a segment misses.
 */
function extractJsonPath(data: unknown, segments: string[]): unknown {
	let current: unknown = data;
	for (const segment of segments) {
		if (current === null || typeof current !== "object") return undefined;
		if (Array.isArray(current)) {
			current = /^\d+$/.test(segment) ? current[Number(segment)] : undefined;
			continue;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/**
 * Handler for agent:// URLs.
 *
 * Resolves output IDs like "reviewer_0" to their artifact files,
 * with optional JSON extraction.
 */
export class AgentProtocolHandler implements ProtocolHandler {
	readonly scheme = "agent";
	readonly immutable = true;

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
		const session = context?.session;
		if (!session) throw new Error("agent:// messaging requires a tool session");
		const registry = session.agentRegistry;
		const senderId = session.getAgentId?.();
		if (
			!registry ||
			!senderId ||
			session.enableIrc === false ||
			!isIrcEnabled(session.settings, session.taskDepth ?? 0)
		) {
			throw new Error("Peer messaging is unavailable in this session.");
		}
		const to = url.rawHost || url.hostname;
		if (!to) throw new Error("agent:// URL requires a recipient: agent://<id>");
		if (url.pathname !== "" && url.pathname !== "/") {
			throw new Error("agent:// message target cannot have a JSON-path suffix.");
		}
		if (!content.trim()) throw new Error("agent:// messages require non-empty content.");
		const result = await executeSend(
			{ registry, senderId, sessionFileHint: session.getSessionFile?.() },
			{ to, message: content },
		);
		return {
			text: result.content.find(item => item.type === "text")?.text ?? "Message delivery failed.",
			details: { message: result.details },
			isError: result.isError,
		};
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const outputId = url.rawHost || url.hostname;
		if (outputId === "all") throw new Error("agent://all is write-only; use it to broadcast a message.");
		if (!outputId) {
			throw new Error("agent:// URL requires an output ID: agent://<id>");
		}

		const urlPath = url.pathname;
		const hasPathExtraction = urlPath && urlPath !== "/" && urlPath !== "";

		const registry = AgentRegistry.global();
		const rootSessionFile = context?.sessionFile
			? await ensurePersistedRoster(registry, context.sessionFile)
			: undefined;
		// The caller root's canonical artifact directory (its session file minus
		// the `.jsonl` suffix) is scanned FIRST, ahead of every process-global
		// registry dir. The roster ref this refresh installs for the caller's
		// parked id contributes only its nested child dir, not the root dir that
		// actually holds `<id>.md` — and with two coexisting roots the global
		// `Main` ref can belong to the other root, whose dir would otherwise win
		// the first-hit id map for a shared id. No caller session file: keep the
		// pre-existing global scan untouched.
		const dirs = artifactsDirsFromRegistry(
			rootSessionFile ? { preferredDir: rootSessionFile.slice(0, -6) } : undefined,
		);
		if (dirs.length === 0) {
			throw new Error("No session - agent outputs unavailable");
		}

		const pathSegments = hasPathExtraction ? urlPath.split("/").filter(Boolean) : [];
		const decodedSegments = pathSegments.map(segment => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		});

		const scan = await this.#findOutput(dirs, outputId);
		if (!scan.anyDirExists) {
			throw new Error("No artifacts directory found");
		}
		if (!scan.foundPath) {
			const availableStr = scan.availableIds.size > 0 ? [...scan.availableIds].join(", ") : "none";
			throw new Error(`Not found: ${outputId}\nAvailable: ${availableStr}`);
		}

		const rawContent = await Bun.file(scan.foundPath).text();
		const notes: string[] = [];
		let content = rawContent;
		let contentType: InternalResource["contentType"] = "text/markdown";

		let extractedFrom = scan.foundPath;
		if (hasPathExtraction) {
			let jsonValue: unknown;
			let parsed = false;
			if (scan.jsonPath) {
				try {
					jsonValue = JSON.parse(await Bun.file(scan.jsonPath).text());
					extractedFrom = scan.jsonPath;
					parsed = true;
				} catch {
					// Corrupt or partially written sidecar: fall back to <id>.md.
				}
			}
			if (!parsed) {
				try {
					jsonValue = JSON.parse(rawContent);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					throw new Error(`Output ${outputId} is not valid JSON: ${message}`);
				}
			}

			const extracted = extractJsonPath(jsonValue, decodedSegments);
			if (typeof extracted === "string") {
				// A string field (e.g. a scout's markdown `report`) reads as prose,
				// not as a JSON-escaped single line.
				content = extracted;
			} else {
				try {
					content = JSON.stringify(extracted, null, 2) ?? "null";
				} catch {
					content = String(extracted);
				}
				contentType = "application/json";
			}
			notes.push(`Extracted: /${decodedSegments.join("/")}`);
			if (parsed) notes.push(`Source: ${path.basename(extractedFrom!)}`);
		}

		return {
			url: url.href,
			content,
			contentType,
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: extractedFrom,
			notes,
		};
	}

	/**
	 * Scan every registered artifacts dir (in priority order) for `<id>.md`.
	 * Returns the resolved path and its same-dir `.json` sidecar, plus the set
	 * of available ids gathered from the scanned dirs for the not-found message.
	 */
	async #findOutput(
		dirs: string[],
		id: string,
	): Promise<{
		foundPath?: string;
		jsonPath?: string;
		anyDirExists: boolean;
		availableIds: Set<string>;
	}> {
		const byId = new Map<string, string>();
		const jsonById = new Map<string, string>();
		let anyDirExists = false;
		for (const dir of dirs) {
			let files: string[];
			try {
				files = await fs.readdir(dir);
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			anyDirExists = true;
			for (const f of files) {
				if (f.endsWith(".json")) {
					const jsonId = f.slice(0, -5);
					if (!jsonById.has(jsonId)) jsonById.set(jsonId, path.join(dir, f));
					continue;
				}
				if (!f.endsWith(".md")) continue;
				const id = f.slice(0, -3);
				if (!byId.has(id)) byId.set(id, path.join(dir, f));
			}
		}
		const availableIds = new Set(byId.keys());
		const foundPath = byId.get(id);
		if (!foundPath) return { anyDirExists, availableIds };
		// Pair the sidecar with the SAME dir as the matched `<id>.md`: two
		// coexisting roots can both hold `Worker`, and a first-hit sidecar
		// from the other root would answer with a foreign agent's payload
		// (see the `preferredDir` comment above and caller-root-ab.test.ts).
		const sidecar = jsonById.get(id);
		const jsonPath = sidecar && path.dirname(sidecar) === path.dirname(foundPath) ? sidecar : undefined;
		return { foundPath, jsonPath, anyDirExists, availableIds };
	}

	async complete(): Promise<UrlCompletion[]> {
		const ids = new Set<string>();
		for (const dir of artifactsDirsFromRegistry()) {
			let files: string[];
			try {
				files = await fs.readdir(dir);
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			for (const f of files) {
				if (f.endsWith(".md")) ids.add(f.slice(0, -3));
			}
		}
		return [...ids].sort().map(value => ({ value }));
	}
}
