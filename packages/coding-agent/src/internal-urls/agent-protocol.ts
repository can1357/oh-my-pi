/**
 * Protocol handler for agent:// URLs.
 *
 * Resolves agent output IDs against the artifacts directories of every active
 * session. Parents and subagents share outputs via this registry: a subagent
 * can read its parent's output IDs because both sessions are registered in
 * the shared context.
 *
 * An id with no `<id>.md` yet (a running agent, including one that has only
 * submitted non-terminal `yield` sections) resolves through the same agent
 * registry `write agent://<id>` messages: the read returns the agent's status
 * and its progress so far instead of `Not found`.
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
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { fuzzyFilter } from "@oh-my-pi/pi-tui/fuzzy";
import { formatDuration, isEnoent, prompt } from "@oh-my-pi/pi-utils";
import { type AgentRef, AgentRegistry, isMessageablePeer } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { malformedRemoteIdError, REMOTE_ID_PREFIX, remoteNamespaceOf } from "../registry/remote-id";
import { executeSend, isIrcEnabled } from "../irc/messaging";
import agentPromptDoc from "../prompts/internal-urls/agent.md" with { type: "text" };
import agentProgressTemplate from "../prompts/tools/agent-url-progress.md" with { type: "text" };
import agentSupersededTemplate from "../prompts/tools/agent-url-superseded.md" with { type: "text" };
import { loadSessionMessagesReadOnly } from "../session/session-loader";
import { artifactsDirsFromRegistry } from "./registry-helpers";
import type {
	InternalResource,
	InternalWriteResult,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	UrlCompletion,
	WriteContext,
} from "./types";

/** Upper bound on the ids a `Not found` error suggests. */
const MAX_ID_SUGGESTIONS = 5;

/** Result of scanning the caller's artifact dirs for `<id>.md`. */
interface OutputScan {
	foundPath?: string;
	jsonPath?: string;
	anyDirExists: boolean;
	availableIds: Set<string>;
}

/** True when the URL extracts a `/<json-path>` value instead of naming the whole output. */
function hasPathExtraction(url: InternalUrl): boolean {
	return url.pathname !== "" && url.pathname !== "/";
}

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
 * Ids a `Not found: <id>` error offers instead. Every `.md` in every
 * registered artifacts dir plus every registered agent is a candidate, which
 * in a long or resumed process is thousands of ids; only the closest few are
 * worth naming.
 */
function notFoundError(outputId: string, candidates: Iterable<string>): Error {
	const unique = [...new Set(candidates)].filter(id => id !== outputId);
	const suggestions = fuzzyFilter(unique, outputId, id => id).slice(0, MAX_ID_SUGGESTIONS);
	const hint = suggestions.length > 0 ? `Did you mean: ${suggestions.join(", ")}` : "List agents with history://";
	return new Error(`Not found: ${outputId}\n${hint}`);
}

/** One accepted `yield` call recovered from an agent's transcript. */
interface YieldSection {
	labels?: string;
	data: string;
}

/** Accepted `yield` results in transcript order; error results and aborts are skipped. */
function yieldSections(messages: readonly AgentMessage[]): YieldSection[] {
	const sections: YieldSection[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== "yield" || message.isError) continue;
		const details = message.details as { data?: unknown; status?: unknown; type?: unknown } | undefined;
		if (details?.status !== "success" || details.data === undefined) continue;
		const labels = Array.isArray(details.type) ? details.type.join(", ") : details.type;
		let data: string;
		try {
			data = JSON.stringify(details.data, null, 2) ?? "null";
		} catch {
			data = String(details.data);
		}
		sections.push({ labels: typeof labels === "string" && labels ? labels : undefined, data });
	}
	return sections;
}

/** Text of the newest assistant message that has any. */
function lastAssistantText(messages: readonly AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "assistant") continue;
		const text = message.content
			.flatMap(block => (block.type === "text" ? [block.text] : []))
			.join("\n")
			.trim();
		if (text) return text;
	}
	return undefined;
}

/** Whether `<id>`'s published output predates a turn the agent is streaming now. */
function isSuperseded(registry: AgentRegistry, outputId: string): boolean {
	const ref = registry.get(outputId);
	return ref !== undefined && ref.kind !== "advisor" && registry.isRunning(ref);
}

/**
 * Handler for agent:// URLs.
 *
 * Resolves output IDs like "reviewer_0" to their artifact files,
 * with optional JSON extraction.
 */
export class AgentProtocolHandler implements ProtocolHandler {
	readonly scheme = "agent";
	readonly spec: SchemeSpec = {
		backing: "file",
		selectors: "lines",
		agentIdAuthority: true,
		immutable: true,
		linkable: true,
		write: { via: "handler", payload: "verbatim", scope: "coordination", tier: () => "read" },
	};

	promptDoc(): string {
		return agentPromptDoc.trim();
	}

	/**
	 * The `<id>.md` output file. JSON-path URLs (`/<json-path>`) render a value
	 * rather than the file, so they locate to null, as do missing ids. So does an
	 * output superseded by a running turn: a located file is read directly by
	 * `read`, which would skip the previous-run banner {@link resolve} adds.
	 */
	async locate(url: InternalUrl, context?: ResolveContext): Promise<string | null> {
		const outputId = url.rawHost || url.hostname;
		if (!outputId) throw new Error("agent:// URL requires an output ID: agent://<id>");
		if (outputId === "all" || outputId.startsWith(REMOTE_ID_PREFIX) || hasPathExtraction(url)) return null;
		if (isSuperseded(context?.agentRegistry ?? AgentRegistry.global(), outputId)) return null;
		const dirs = await this.#outputDirs(context);
		if (dirs.length === 0) return null;
		return (await this.#findOutput(dirs, outputId)).foundPath ?? null;
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
		const session = context?.session;
		if (!session) throw new Error("agent:// messaging requires a tool session");
		const registry = session.agentRegistry;
		const senderId = session.getAgentId?.();
		if (
			!registry ||
			!senderId ||
			session.enableIrc === false ||
			!isIrcEnabled(session.settings, session.taskDepth ?? 0, registry)
		) {
			throw new Error("Peer messaging is unavailable in this session.");
		}
		const to = url.rawHost || url.hostname;
		if (!to) throw new Error("agent:// URL requires a recipient: agent://<id>");
		const malformedTo = malformedRemoteIdError(to);
		if (malformedTo) throw malformedTo;
		if (hasPathExtraction(url)) {
			throw new Error("agent:// message target cannot have a JSON-path suffix.");
		}
		if (!content.trim()) throw new Error("agent:// messages require non-empty content.");
		const result = await executeSend(
			{ registry, senderId, sessionFileHint: session.getSessionFile?.() },
			{ to, message: content },
		);
		return {
			content: [
				{
					type: "text",
					text: result.content.find(item => item.type === "text")?.text ?? "Message delivery failed.",
				},
			],
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
		// A remote peer (`@ns/name`) runs in another process: it is a message target, never an output.
		const malformedId = malformedRemoteIdError(outputId);
		if (malformedId) throw malformedId;
		if (remoteNamespaceOf(outputId) !== undefined) {
			throw new Error(
				`${outputId} is a remote peer and has no local output to read. Message it with \`write agent://${outputId}\`; list peers with \`read history://\`.`,
			);
		}

		const extraction = hasPathExtraction(url);

		const dirs = await this.#outputDirs(context);
		const scan = dirs.length > 0 ? await this.#findOutput(dirs, outputId) : undefined;
		const registry = context?.agentRegistry ?? AgentRegistry.global();
		if (!scan?.foundPath) {
			// No published output yet. A registered agent (running, idle after a
			// non-terminal yield, or parked before publishing) is the same
			// registry `write agent://<id>` delivers to: answer with its progress.
			const ref = registry.get(outputId);
			if (ref && ref.kind !== "advisor") return this.#resolveProgress(url, ref, extraction);
			if (!scan) throw new Error("No session - agent outputs unavailable");
			if (!scan.anyDirExists) throw new Error("No artifacts directory found");
			const registered = registry
				.list()
				.filter(candidate => candidate.kind !== "advisor")
				.map(candidate => candidate.id);
			throw notFoundError(outputId, [...scan.availableIds, ...registered]);
		}

		const pathSegments = extraction ? url.pathname.split("/").filter(Boolean) : [];
		const decodedSegments = pathSegments.map(segment => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		});

		const rawContent = await Bun.file(scan.foundPath).text();
		const notes: string[] = [];
		let content = rawContent;
		// A published file belongs to a finished run. If the agent is streaming
		// again (follow-up or IRC wake), the file is the previous run's result;
		// unmarked, a reader takes it as the current state.
		if (!extraction && isSuperseded(registry, outputId)) {
			const publishedAt = (await fs.stat(scan.foundPath)).mtimeMs;
			content = `${prompt.render(agentSupersededTemplate, {
				id: outputId,
				age: formatDuration(Math.max(0, Date.now() - publishedAt)),
			})}${rawContent}`;
			notes.push(`Superseded: ${outputId} is running a newer turn`);
		}
		let contentType: InternalResource["contentType"] = "text/markdown";

		let extractedFrom = scan.foundPath;
		if (extraction) {
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
			shape: extraction ? "value" : "document",
		};
	}

	/**
	 * Progress view of a registered agent that has not published `<id>.md`:
	 * its status, every accepted `yield` (non-terminal sections included), and
	 * its latest assistant text. Reads the live session's messages, else the
	 * retained session file. JSON-path extraction needs the published output.
	 */
	async #resolveProgress(url: InternalUrl, ref: AgentRef, extraction: boolean): Promise<InternalResource> {
		if (extraction) {
			throw new Error(
				`Output ${ref.id} is not published yet (status: ${ref.status}); read agent://${ref.id} for its progress.`,
			);
		}
		let messages: readonly AgentMessage[] = [];
		let source = "no transcript";
		if (ref.session) {
			messages = ref.session.messages;
			source = "live session";
		} else if (ref.sessionFile) {
			messages = await loadSessionMessagesReadOnly(ref.sessionFile);
			source = "session file (read-only)";
		}
		const sections = yieldSections(messages);
		const lastText = lastAssistantText(messages);
		const content = `${prompt.render(agentProgressTemplate, {
			id: ref.id,
			status: ref.status,
			sections,
			lastText,
			empty: sections.length === 0 && !lastText,
		})}\n`;
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [`No published output; progress from ${source} (${ref.status})`],
			shape: "document",
		};
	}

	/**
	 * Artifact dirs to scan for the caller's outputs, in priority order.
	 *
	 * The caller root's canonical artifact directory (its session file minus
	 * the `.jsonl` suffix) is scanned FIRST, ahead of every process-global
	 * registry dir. The roster ref the refresh installs for the caller's
	 * parked id contributes only its nested child dir, not the root dir that
	 * actually holds `<id>.md` — and with two coexisting roots the global
	 * `Main` ref can belong to the other root, whose dir would otherwise win
	 * the first-hit id map for a shared id. No caller session file: keep the
	 * pre-existing global scan untouched.
	 */
	async #outputDirs(context: ResolveContext | undefined): Promise<string[]> {
		const rootSessionFile = context?.sessionFile
			? await ensurePersistedRoster(AgentRegistry.global(), context.sessionFile)
			: undefined;
		return artifactsDirsFromRegistry(rootSessionFile ? { preferredDir: rootSessionFile.slice(0, -6) } : undefined);
	}

	/**
	 * Scan every registered artifacts dir (in priority order) for `<id>.md`.
	 * Returns the resolved path and its same-dir `.json` sidecar, plus the set
	 * of available ids gathered from the scanned dirs for the not-found message.
	 */
	async #findOutput(dirs: string[], id: string): Promise<OutputScan> {
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

	/**
	 * Output ids (readable) plus messageable peers (write targets). Remote peers appear here, not
	 * under history://, because `write agent://@ns/name` is the only thing one can do with them.
	 */
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
		const completions: UrlCompletion[] = [...ids].sort().map(value => ({ value }));
		for (const ref of AgentRegistry.global().list()) {
			if (!isMessageablePeer(ref.kind) || ids.has(ref.id)) continue;
			completions.push({ value: ref.id, description: `${ref.status} · ${ref.kind} · message with write` });
		}
		return completions;
	}
}
