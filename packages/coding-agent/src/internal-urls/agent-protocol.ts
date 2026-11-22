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
import { AgentRegistry, type AgentRegistryApi, MAIN_AGENT_ID } from "../registry/agent-registry";
import { ensurePersistedRoster, sessionFileBelongsToRoot } from "../registry/persisted-agents";
import { IrcBus } from "../irc/bus";
import { executeSend, isIrcEnabled } from "../irc/messaging";
import { agentMesh } from "../irc/mesh";
import { formatPeerAddress, type PeerAddress } from "../irc/mesh-protocol";
import type { AgentSessionHandle } from "../session/agent-session-handle";
import { cfgTaskCrossInstance } from "../task/settings";
import agentPromptDoc from "../prompts/internal-urls/agent.md" with { type: "text" };
import agentProgressTemplate from "../prompts/tools/agent-url-progress.md" with { type: "text" };
import agentSupersededTemplate from "../prompts/tools/agent-url-superseded.md" with { type: "text" };
import { loadSessionMessagesReadOnly } from "../session/session-loader";
import {
	defaultSessionStorage,
	isStoredFile,
	type SessionStorage,
	sessionTreeStorage,
} from "../session/session-storage";
import { artifactsDirsFromRegistry } from "./registry-helpers";
import type {
	InternalResource,
	InternalWriteResult,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeHost,
	SchemeSpec,
	UrlCompletion,
	WriteContext,
} from "./types";

/**
 * A `agent://<pid>[/<id>[/<json-path>]]` URL: an agent of the omp instance
 * with that pid. This process's own pid reads as a local address.
 */
interface PidTarget {
	address: PeerAddress;
	/** JSON-path segments after the agent id. */
	segments: string[];
	local: boolean;
}

function pidTarget(url: InternalUrl): PidTarget | undefined {
	const host = url.rawHost || url.hostname;
	if (!/^\d+$/.test(host)) return undefined;
	const [id, ...segments] = url.pathname.split("/").filter(Boolean).map(decodeSegment);
	if (id && /[/\\\0]/.test(id)) throw new Error("Invalid agent ID in PID-qualified URL.");
	const pid = Number(host);
	return { address: { pid, ...(id ? { id } : {}) }, segments, local: pid === process.pid };
}

function crossInstanceEnabled(context?: ResolveContext): boolean {
	const settings = context?.session?.settings ?? context?.settings;
	return settings !== undefined && cfgTaskCrossInstance.get(settings);
}

function decodeSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

/** What a progress view reads: a live session, else a transcript file. */
interface ProgressSource {
	id: string;
	status: string;
	session: AgentSessionHandle | null;
	sessionFile: string | null;
}

/** Where {@link AgentProtocolHandler.resolve} looks up one output id. */
interface OutputTarget {
	outputId: string;
	segments: string[];
	dirs: string[];
	registry?: AgentRegistryApi;
	/** Last status published by the peer that owns this subagent. */
	remoteStatus?: string;
	/** Transcript-backed progress source for a peer, including retained agents. */
	remoteProgress?: () => Promise<ProgressSource | undefined>;
	/** The caller's session tree storage, which holds a registered agent's retained transcript. */
	storage?: SessionStorage;
}

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

/**
 * The registered agent a message to `named` means: the id itself when
 * registered (or `all`), the sender's parent for `parent`, else the one agent
 * whose id matches ignoring case. Anything else stays as named, and delivery
 * reports it unknown.
 */
function resolveRecipient(registry: AgentRegistryApi, senderId: string, named: string): string {
	if (named === "all" || registry.get(named)) return named;
	if (named.toLowerCase() === "parent") {
		const parentId = registry.get(senderId)?.parentId;
		if (parentId) return parentId;
	}
	const lower = named.toLowerCase();
	const [match, ...others] = registry.list().filter(ref => ref.kind !== "advisor" && ref.id.toLowerCase() === lower);
	return match && others.length === 0 ? match.id : named;
}

/** Largest output still read whole to tell a whitespace-only one from content. */
const BLANK_PROBE_BYTES = 4096;

/** Whether the published output at `file` has no content (empty or whitespace only). */
async function isBlankFile(file: string): Promise<boolean> {
	const blob = Bun.file(file);
	if (blob.size > BLANK_PROBE_BYTES) return false;
	return !(await blob.text()).trim();
}

/** Whether `<id>`'s published output predates the run the agent has open now. */
function isSuperseded(registry: AgentRegistryApi, outputId: string): boolean {
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
		immutable: true,
		linkable: true,
		write: { via: "handler", payload: "verbatim", scope: "coordination", tier: () => "read" },
	};

	promptDoc(host: SchemeHost): string {
		return prompt
			.render(agentPromptDoc, {
				subagent: host.subagent,
				crossInstanceAgents: host.crossInstanceAgents,
			})
			.trim();
	}

	/**
	 * The `<id>.md` output file. JSON-path URLs (`/<json-path>`) render a value
	 * rather than the file, so they locate to null, as do missing ids. So does an
	 * output superseded by a running turn, or an empty one: a located file is
	 * read directly by `read`, which would skip what {@link resolve} adds (the
	 * previous-run banner, the status of a run that published nothing).
	 */
	async locate(url: InternalUrl, context?: ResolveContext): Promise<string | null> {
		const outputId = url.rawHost || url.hostname;
		if (!outputId) throw new Error("agent:// URL requires an output ID: agent://<id>");
		if (outputId === "all" || hasPathExtraction(url)) return null;
		if (crossInstanceEnabled(context) && (outputId === "peers" || /^\d+$/.test(outputId))) return null;
		if (isSuperseded(context?.agentRegistry ?? AgentRegistry.global(), outputId)) return null;
		const dirs = await this.#outputDirs(context);
		if (dirs.length === 0) return null;
		const foundPath = (await this.#findOutput(dirs, outputId)).foundPath;
		return foundPath && !(await isBlankFile(foundPath)) ? foundPath : null;
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
			!isIrcEnabled(session.settings, session.taskDepth ?? 0)
		) {
			throw new Error("Peer messaging is unavailable in this session.");
		}
		const pid = cfgTaskCrossInstance.get(session.settings) ? pidTarget(url) : undefined;
		const named = pid
			? pid.local
				? (pid.address.id ?? MAIN_AGENT_ID)
				: formatPeerAddress(pid.address)
			: url.rawHost || url.hostname;
		if (!named) throw new Error("agent:// URL requires a recipient: agent://<id>");
		if (pid ? pid.segments.length > 0 : hasPathExtraction(url)) {
			throw new Error("agent:// message target cannot have a JSON-path suffix.");
		}
		const to = pid && !pid.local ? named : resolveRecipient(registry, senderId, named);
		const progress = url.searchParams.has("progress");
		if (progress && to === "all") throw new Error("agent://all broadcasts cannot be ?progress updates.");
		if (!content.trim()) throw new Error("agent:// messages require non-empty content.");
		// A spawn waiting for a slot (or still opening its session) has a job but
		// no live session yet: hold the message for its run to take on start.
		const recipient = registry.get(to);
		const startingJob =
			recipient?.session || (recipient && recipient.status !== "running")
				? undefined
				: session.asyncJobManager?.getJob(to);
		if (startingJob?.agentId === to && startingJob.status === "running") {
			IrcBus.global().park({ from: senderId, to, body: content, ...(progress ? { progress: true } : {}) });
			return {
				content: [{ type: "text", text: `Queued for ${to} (not started yet; delivered when it starts).` }],
				details: { message: { op: "send", from: senderId, to } },
			};
		}
		const result = await executeSend(
			{ registry, senderId, sessionFileHint: session.getSessionFile?.(), storage: sessionTreeStorage(session) },
			{ to, message: content, progress, remote: pid !== undefined && !pid.local },
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
		const crossInstance = crossInstanceEnabled(context);
		if (crossInstance && outputId === "peers") return this.#resolvePeers(url);
		const registry = context?.agentRegistry ?? AgentRegistry.global();
		const pid = crossInstance ? pidTarget(url) : undefined;
		if (pid && !pid.local) return this.#resolvePeer(url, pid);
		return this.#resolveOutput(url, {
			outputId: pid ? (pid.address.id ?? MAIN_AGENT_ID) : outputId,
			segments: pid ? pid.segments : url.pathname.split("/").filter(Boolean).map(decodeSegment),
			dirs: await this.#outputDirs(context),
			registry,
			storage: context?.storage,
		});
	}

	/** Roster of the other omp instances in this project. */
	#resolvePeers(url: InternalUrl): InternalResource {
		const peers = agentMesh()?.peers() ?? [];
		const content =
			peers.length === 0
				? "No other omp instances in this project.\n"
				: `${peers.map(peer => `- agent://${peer.pid} (${peer.status})`).join("\n")}\n\nRead agent://<pid>/<id> for a subagent's output; write agent://<pid> to message its main agent.\n`;
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [`This instance: ${process.pid}`],
			shape: "document",
		};
	}

	/** An agent of another omp instance, read from that instance's transcripts in this process's session storage. */
	async #resolvePeer(url: InternalUrl, target: PidTarget): Promise<InternalResource> {
		const { pid, id } = target.address;
		const peer = agentMesh()?.peer(pid);
		if (!peer) throw new Error(`No omp instance with pid ${pid} in this project. List them with agent://peers`);
		const sessionFile = peer.sessionFile;
		if (!sessionFile) throw new Error(`Instance ${pid} has no session file; its agents cannot be read.`);
		// The instances of one project share a configuration, so the peer keeps
		// its transcripts where this process does: files, or `session.storage: sql` rows.
		const storage = defaultSessionStorage();
		// The peer writes through its own client: a shared store holds rows it
		// committed after this process last loaded its view.
		await storage.refresh?.();
		if (!id) {
			if (target.segments.length > 0) throw new Error(`agent://${pid} is a main agent; it has no JSON output.`);
			return this.#resolveProgress(
				url,
				{ id: String(pid), status: peer.status, session: null, sessionFile },
				false,
				storage,
			);
		}
		const dir = sessionFile.slice(0, -".jsonl".length);
		const agent = peer.agents.find(agent => agent.id === id);
		const transcript =
			agent && sessionFileBelongsToRoot(agent.sessionFile, sessionFile)
				? agent.sessionFile
				: path.join(dir, `${id}.jsonl`);
		return this.#resolveOutput(url, {
			outputId: id,
			segments: target.segments,
			dirs: [dir],
			remoteStatus: agent?.status,
			storage,
			remoteProgress: async () => {
				const exists = isStoredFile(transcript, storage);
				if (!exists && !agent) return undefined;
				return {
					id: formatPeerAddress(target.address),
					status: agent?.status ?? "not registered",
					session: null,
					sessionFile: exists ? transcript : null,
				};
			},
		});
	}

	async #resolveOutput(url: InternalUrl, target: OutputTarget): Promise<InternalResource> {
		const { outputId, dirs, registry } = target;
		const extraction = target.segments.length > 0;
		const scan = dirs.length > 0 ? await this.#findOutput(dirs, outputId) : undefined;
		if (!scan?.foundPath) {
			// No published output yet. A registered agent (running, idle after a
			// non-terminal yield, or parked before publishing) is the same
			// registry `write agent://<id>` delivers to: answer with its progress.
			const ref = registry?.get(outputId);
			const progress = ref && ref.kind !== "advisor" ? ref : await target.remoteProgress?.();
			if (progress)
				return this.#resolveProgress(url, progress, extraction, target.storage ?? defaultSessionStorage());
			if (!scan) throw new Error("No session - agent outputs unavailable");
			if (!scan.anyDirExists) throw new Error("No artifacts directory found");
			const registered =
				registry
					?.list()
					.filter(candidate => candidate.kind !== "advisor")
					.map(candidate => candidate.id) ?? [];
			throw notFoundError(outputId, [...scan.availableIds, ...registered]);
		}

		const decodedSegments = target.segments;

		const rawContent = await Bun.file(scan.foundPath).text();
		// A run that failed or was cancelled can publish an empty output; a blank
		// read would pass for success, so show what the agent did instead.
		if (!extraction && !rawContent.trim()) {
			const ref = registry?.get(outputId);
			const progress = ref && ref.kind !== "advisor" ? ref : await target.remoteProgress?.();
			if (progress)
				return this.#resolveProgress(url, progress, false, target.storage ?? defaultSessionStorage(), true);
		}
		const notes: string[] = target.remoteStatus === undefined ? [] : [`Status: ${target.remoteStatus}`];
		let content = rawContent.trim()
			? rawContent
			: `${outputId} published an empty output. Transcript: history://${outputId}\n`;
		// A published file belongs to a finished run. If the agent is streaming
		// again (follow-up or IRC wake), the file is the previous run's result;
		// unmarked, a reader takes it as the current state.
		if (!extraction && (registry ? isSuperseded(registry, outputId) : target.remoteStatus === "running")) {
			const publishedAt = (await fs.stat(scan.foundPath)).mtimeMs;
			content = `${prompt.render(agentSupersededTemplate, {
				id: outputId,
				age: formatDuration(Math.max(0, Date.now() - publishedAt)),
			})}${rawContent}`;
			notes.push(`Superseded: ${outputId} is running a newer turn`);
		}
		let contentType: InternalResource["contentType"] = "text/markdown";

		let extractedFrom = scan.foundPath;
		const shape: InternalResource["shape"] = extraction ? "value" : "document";
		let absent: true | undefined;
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
			if (extracted === undefined) absent = true;
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
			if (absent) notes.push("JSON path not found");
		}

		return {
			url: url.href,
			content,
			contentType,
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: extractedFrom,
			notes,
			shape,
			...(absent ? { absent } : {}),
		};
	}

	/**
	 * Progress view of a registered agent that has not published `<id>.md`:
	 * its status, every accepted `yield` (non-terminal sections included), and
	 * its latest assistant text. Reads the live session's messages, else the
	 * retained session file in the caller's session tree `storage`. JSON-path
	 * extraction needs the published output.
	 */
	async #resolveProgress(
		url: InternalUrl,
		ref: ProgressSource,
		extraction: boolean,
		storage: SessionStorage,
		publishedEmpty = false,
	): Promise<InternalResource> {
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
			messages = await loadSessionMessagesReadOnly(ref.sessionFile, storage);
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
			publishedEmpty,
		})}\n`;
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [`${publishedEmpty ? "Empty" : "No"} published output; progress from ${source} (${ref.status})`],
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
			? await ensurePersistedRoster(AgentRegistry.global(), context.sessionFile, context.storage)
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
