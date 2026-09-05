/**
 * Protocol handler for history:// URLs.
 *
 * Exposes agent transcripts as concise markdown. Live refs render from the
 * in-memory message array; parked refs (session disposed, sessionFile
 * retained) load read-only from the JSONL session file — no writer, no lock.
 *
 * Agents that are no longer in the `AgentRegistry` — one-shot helpers
 * unregistered after `finalizeSubagentLifecycle` (`keepAlive: false`, e.g. the
 * `eval` `agent()` bridge), agents released via the Agent Hub / vibe kill, or
 * any agent after a session resume — remain reachable: `resolve`, `complete`,
 * and the index all fall back to scanning artifacts dirs for `<id>.jsonl`,
 * mirroring how `agent://` reads `.md` outputs straight off disk.
 *
 * URL forms:
 * - history:// - Index of all registry + on-disk agents (id, status, kind, last activity)
 * - history://<agentId> - Concise markdown transcript of that agent
 * - history://current/full - Full, caller-bound current branch history (experimental)
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentRef } from "../registry/agent-registry";
import { AgentRegistry } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";
import {
	bashExecutionToText,
	pythonExecutionToText,
	type BashExecutionMessage,
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	type CustomMessage,
	type FileMentionMessage,
	type HookMessage,
	type PythonExecutionMessage,
} from "../session/messages";
import { loadSessionMessagesReadOnly } from "../session/session-loader";
import type { SessionEntry } from "../session/session-entries";
import { sessionFilesFromDisk } from "./registry-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

/** Humanize a last-activity timestamp as `Ns/Nm/Nh/Nd ago`. */
function formatAgo(timestamp: number): string {
	const diffMs = Math.max(0, Date.now() - timestamp);
	const secs = Math.floor(diffMs / 1000);
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** One row of the history index — either a registered ref or a disk-only transcript. */
interface IndexEntry {
	id: string;
	status: string;
	kind: string;
	parent: string;
	lastActivity: string;
}

function jsonFence(text: string): string {
	let longestBacktickRun = 0;
	for (const match of text.matchAll(/`+/g)) {
		longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
	}
	const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
	return `${fence}json\n${text}\n${fence}`;
}

function appendTextContent(lines: string[], content: string | readonly { type: string; text?: string }[]): void {
	if (typeof content === "string") {
		lines.push(content);
		return;
	}
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") lines.push(block.text);
		else if (block.type === "image") lines.push("[image]");
	}
}

function appendRawMessage(lines: string[], message: AgentMessage): void {
	switch (message.role) {
		case "user":
		case "developer":
			lines.push(`### ${message.role}`);
			appendTextContent(lines, message.content);
			return;
		case "assistant": {
			const assistantMessage = message as AssistantMessage;
			lines.push("### assistant");
			for (const block of assistantMessage.content) {
				if (block.type === "text") lines.push(block.text);
				else if (block.type === "thinking") lines.push("<thinking>", block.thinking, "</thinking>");
				else if (block.type === "toolCall") {
					lines.push(`#### tool call: ${block.name} (${block.id})`);
					lines.push(jsonFence(JSON.stringify(block.arguments, null, 2) ?? "null"));
				}
			}
			return;
		}
		case "toolResult":
			lines.push(`### tool result: ${message.toolName} (${message.toolCallId})${message.isError ? " [error]" : ""}`);
			appendTextContent(lines, message.content);
			return;
		case "bashExecution": {
			const bashMessage = message as BashExecutionMessage;
			lines.push(
				"### bash execution",
				bashExecutionToText(bashMessage),
				jsonFence(
					JSON.stringify(
						{
							exitCode: bashMessage.exitCode,
							cancelled: bashMessage.cancelled,
							truncated: bashMessage.truncated,
							meta: bashMessage.meta,
							imageCount: bashMessage.images?.length ?? 0,
						},
						null,
						2,
					) ?? "null",
				),
			);
			return;
		}
		case "pythonExecution": {
			const pythonMessage = message as PythonExecutionMessage;
			lines.push(
				"### python execution",
				pythonExecutionToText(pythonMessage),
				jsonFence(
					JSON.stringify(
						{
							exitCode: pythonMessage.exitCode,
							cancelled: pythonMessage.cancelled,
							truncated: pythonMessage.truncated,
							meta: pythonMessage.meta,
						},
						null,
						2,
					) ?? "null",
				),
			);
			return;
		}
		case "custom":
		case "hookMessage": {
			const customMessage = message as CustomMessage | HookMessage;
			lines.push(`### ${customMessage.role} (${customMessage.customType})`);
			appendTextContent(lines, customMessage.content);
			return;
		}
		case "branchSummary": {
			const branchSummary = message as BranchSummaryMessage;
			lines.push(`### branch summary (from ${branchSummary.fromId})`, branchSummary.summary);
			return;
		}
		case "compactionSummary": {
			const compactionSummary = message as CompactionSummaryMessage;
			lines.push(
				`### compaction summary (${compactionSummary.tokensBefore} tokens before)`,
				compactionSummary.summary,
			);
			return;
		}
		case "fileMention": {
			const fileMention = message as FileMentionMessage;
			lines.push("### file mention");
			for (const file of fileMention.files) {
				lines.push(`<file path="${file.path}">`);
				if (file.content) lines.push(file.content);
				if (file.image) lines.push("[image]");
				lines.push("</file>");
			}
			return;
		}
		default:
			lines.push(jsonFence(JSON.stringify(message, null, 2) ?? "null"));
			return;
	}
}

function renderRawEntry(lines: string[], entry: SessionEntry): void {
	lines.push(
		`## Entry ${entry.id} · ${entry.type}`,
		"",
		`Parent: ${entry.parentId ?? "root"}`,
		`Timestamp: ${entry.timestamp}`,
		"",
	);
	if (entry.type === "message") {
		appendRawMessage(lines, entry.message);
		return;
	}
	if (entry.type === "compaction") {
		lines.push(
			"> Context window boundary: compaction",
			"",
			`First kept entry: ${entry.firstKeptEntryId}`,
			`Tokens before: ${entry.tokensBefore}`,
			"",
			entry.summary,
		);
		return;
	}
	if (entry.type === "reset_boundary") {
		lines.push("> Context window boundary: reset");
		return;
	}
	if (entry.type === "branch_summary") {
		lines.push(`From entry: ${entry.fromId}`, "", entry.summary);
		return;
	}
	lines.push(jsonFence(JSON.stringify(entry, null, 2) ?? "null"));
}

/**
 * Render every persisted entry on the caller's live branch without the
 * compaction filters that shape model context. Each block begins with the
 * durable session-entry id, making references unambiguous across compactions
 * and branch rewinds.
 */
export function formatCurrentBranchFullHistory(entries: readonly SessionEntry[]): string {
	const lines = [
		"# Current branch — full history",
		"",
		"Source: caller-bound live session branch. Context-window boundaries are retained below; this view never uses a registry or on-disk fallback.",
		"",
	];
	for (const entry of entries) {
		renderRawEntry(lines, entry);
		lines.push("");
	}
	return `${lines.join("\n").trim()}\n`;
}

/**
 * Handler for history:// URLs.
 *
 * Resolves agent ids against the global AgentRegistry, then falls back to
 * on-disk `.jsonl` transcripts, serving read-only history for live, parked,
 * and unregistered agents alike.
 */
export class HistoryProtocolHandler implements ProtocolHandler {
	readonly scheme = "history";
	readonly immutable = false;

	#resolveCurrentFull(url: InternalUrl, context: ResolveContext | undefined): InternalResource {
		if (!context?.experimentalContextManagement) {
			throw new Error(
				"history://current/full is available only when compaction.experimentalContextManagement is enabled",
			);
		}
		const branch = context.getSessionBranch?.();
		if (!branch) {
			throw new Error("history://current/full requires a bound live session branch");
		}
		const content = formatCurrentBranchFullHistory(branch);
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			notes: ["Source: caller-bound live session branch (full, uncompacted)"],
		};
	}
	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const agentId = url.rawHost || url.hostname;
		if (agentId.toLowerCase() === "current" && url.pathname && url.pathname !== "/") {
			if (url.pathname !== "/full" || url.search || url.hash) {
				throw new Error(
					"Invalid history://current route; use exactly history://current/full (selectors may follow it)",
				);
			}
			return this.#resolveCurrentFull(url, context);
		}
		const registry = AgentRegistry.global();
		// A caller resolving a possibly-parked id refreshes its own root's
		// persisted roster first: a same-named parked ref restored by another
		// root's scan must not be served (or listed as known) in its place.
		// The refresh is latched per root, so a settled roster never re-scans.
		let rootSessionFile: string | undefined;
		if (agentId && context?.sessionFile) {
			rootSessionFile = await ensurePersistedRoster(registry, context.sessionFile);
		}
		// On-disk fallbacks below scan the caller root's artifact directory
		// first, so a same-named transcript restored by another root's scan
		// never shadows this caller's own on-disk transcript.
		const preferredArtifactDir = rootSessionFile?.slice(0, -".jsonl".length);
		// Advisor transcripts are observability-only — surfaced in the Agent Hub, never
		// in the agent-facing roster. Hide them from the index, lookup, and completions.
		const visible = registry.list().filter(ref => ref.kind !== "advisor");

		if (!agentId) {
			const content = await this.#renderIndex(visible);
			return {
				url: url.href,
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf-8"),
			};
		}

		let ref = registry.get(agentId);
		if (ref?.kind === "advisor") ref = undefined;
		if (!ref) {
			// Case-insensitive fallback: agent ids are human-typed (e.g. AuthLoader).
			const lower = agentId.toLowerCase();
			ref = visible.find(candidate => candidate.id.toLowerCase() === lower);
		}

		if (!ref) {
			// Registry miss — the agent may have been unregistered or lost on resume.
			// Serve its transcript straight from disk if the session file persists.
			const disk = await this.#resolveFromDisk(agentId, preferredArtifactDir);
			if (disk) return { ...disk, url: url.href };

			const known = visible.map(candidate => candidate.id);
			const knownStr = known.length > 0 ? known.join(", ") : "none";
			throw new Error(`Unknown agent: ${agentId}\nKnown agents: ${knownStr}\nList all with history://`);
		}

		const notes: string[] = [];
		let messages: unknown[];
		if (ref.session) {
			messages = ref.session.messages;
			notes.push("Source: live session");
		} else if (ref.sessionFile) {
			messages = await loadSessionMessagesReadOnly(ref.sessionFile);
			notes.push(`Source: session file (read-only, ${ref.status})`);
		} else {
			// No live session and no retained sessionFile — try the disk scan before
			// giving up, in case the transcript lingers under an artifacts dir.
			const disk = await this.#resolveFromDisk(ref.id, preferredArtifactDir);
			if (disk) return { ...disk, url: url.href };
			throw new Error(`Agent ${ref.id} has no transcript: session is gone and no session file was retained`);
		}

		const content = formatSessionHistoryMarkdown(messages, { title: `${ref.id} (${ref.status})` });
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: ref.sessionFile ?? undefined,
			notes,
		};
	}

	/**
	 * Load a transcript for `agentId` from an on-disk `.jsonl` session file,
	 * matched case-insensitively. Returns `undefined` when no file is found.
	 * `preferredArtifactDir` — the caller root's artifact directory, when
	 * known — is scanned before every registry-derived dir, so a same-id
	 * transcript from another root cannot shadow the caller's own.
	 */
	async #resolveFromDisk(agentId: string, preferredArtifactDir?: string): Promise<InternalResource | undefined> {
		const files = await sessionFilesFromDisk(preferredArtifactDir);
		const lower = agentId.toLowerCase();
		let matchedId: string | undefined;
		let sessionFile: string | undefined;
		for (const [id, file] of files) {
			if (id === agentId || id.toLowerCase() === lower) {
				matchedId = id;
				sessionFile = file;
				if (id === agentId) break;
			}
		}
		if (!matchedId || !sessionFile) return undefined;
		const messages = await loadSessionMessagesReadOnly(sessionFile);
		const content = formatSessionHistoryMarkdown(messages, { title: `${matchedId} (on disk)` });
		return {
			url: "",
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: sessionFile,
			notes: ["Source: session file (read-only, unregistered)"],
		};
	}

	async #renderIndex(refs: AgentRef[]): Promise<string> {
		const entries: IndexEntry[] = refs.map(ref => ({
			id: ref.id,
			status: ref.status,
			kind: ref.kind,
			parent: ref.parentId ?? "—",
			lastActivity: formatAgo(ref.lastActivity),
		}));
		// Merge on-disk transcripts for agents absent from the registry.
		const registered = new Set(refs.map(ref => ref.id));
		const disk = await sessionFilesFromDisk();
		for (const id of disk.keys()) {
			if (registered.has(id)) continue;
			entries.push({ id, status: "on disk", kind: "—", parent: "—", lastActivity: "—" });
		}

		const lines: string[] = ["# Agents", ""];
		if (entries.length === 0) {
			lines.push("No agents registered.");
			return `${lines.join("\n")}\n`;
		}
		lines.push("| id | status | kind | parent | last activity |", "|---|---|---|---|---|");
		for (const entry of entries) {
			lines.push(`| ${entry.id} | ${entry.status} | ${entry.kind} | ${entry.parent} | ${entry.lastActivity} |`);
		}
		lines.push("", "Read a transcript with `read history://<id>`.");
		return `${lines.join("\n")}\n`;
	}

	async complete(): Promise<UrlCompletion[]> {
		const completions: UrlCompletion[] = [];
		const seen = new Set<string>();
		for (const ref of AgentRegistry.global().list()) {
			if (ref.kind === "advisor") continue;
			seen.add(ref.id);
			completions.push({
				value: ref.id,
				description: `${ref.status} · ${ref.kind}${ref.parentId ? ` · parent ${ref.parentId}` : ""}`,
			});
		}
		const disk = await sessionFilesFromDisk();
		for (const id of disk.keys()) {
			if (seen.has(id)) continue;
			seen.add(id);
			completions.push({ value: id, description: "on disk" });
		}
		return completions;
	}
}
