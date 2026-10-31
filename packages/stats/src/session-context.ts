import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type ContextAgentUsage,
	type ContextJournalEntry,
	type ContextTimeline,
	type ContextTimelineLimits,
	foldContextTimeline,
} from "@oh-my-pi/pi-ai/context-insights";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { classifyAgentType, parseAllSessionEntries } from "./parser";
import {
	type ChildTranscript,
	discoverChildTranscripts,
	readTranscript,
	resolveSessionPath,
	transcriptStem,
} from "./trace";

/** Bump when journal projection changes, independently of transcript freshness. */
export const CONTEXT_ETAG_VERSION = 1;

interface JournalView extends ContextJournalEntry {
	cwd?: string;
	additionalDirectories?: string[];
	agent?: string;
	resolvedModel?: string;
}

interface FoldedTranscript {
	timeline: ContextTimeline;
	agent: string | undefined;
	model: string | undefined;
}
function resolveContextFile(file: string): string {
	return resolveSessionPath(path.isAbsolute(file) ? file : path.join(getSessionsDir(), file));
}

/** Mirror SessionManager replay, including captured null/dangling leaves and id-less title slots. */
function activeBranchEntries(entries: readonly JournalView[]): JournalView[] {
	const byId = new Map<string, JournalView>();
	let leaf: string | null | undefined;
	let fallback: string | undefined;
	for (const entry of entries) {
		if (typeof entry.id !== "string") continue;
		byId.set(entry.id, entry);
		leaf = entry.activeLeafId !== undefined ? entry.activeLeafId : entry.id;
		if (leaf === entry.id) fallback = entry.id;
	}
	if (leaf === null || leaf === undefined) return [];
	if (!byId.has(leaf)) leaf = fallback;
	const active = new Set<string>();
	while (typeof leaf === "string" && !active.has(leaf)) {
		const entry = byId.get(leaf);
		if (!entry) break;
		active.add(leaf);
		leaf = entry.parentId;
	}
	return entries.filter(entry => typeof entry.id === "string" && active.has(entry.id));
}

const READ_SELECTOR = /:(?:raw|conflicts|img|[\d.,+-]+)$/i;

async function foldTranscript(file: string, limits?: Partial<ContextTimelineLimits>): Promise<FoldedTranscript> {
	// Stats mirrors the journal structurally; the shared fold validates fields at its boundary.
	const entries = parseAllSessionEntries(await readTranscript(file)) as unknown as JournalView[];
	let sessionId = path.basename(transcriptStem(file));
	let cwd: string | undefined;
	let agent: string | undefined;
	let model: string | undefined;
	for (const entry of entries) {
		if (entry.type === "session") {
			if (typeof entry.id === "string") sessionId = entry.id;
			if (typeof entry.cwd === "string") cwd = entry.cwd;
		}
		if (entry.type === "session_init") {
			if (typeof entry.agent === "string") agent = entry.agent;
			if (typeof entry.resolvedModel === "string") model = entry.resolvedModel;
		}
	}
	const branch = activeBranchEntries(entries);
	const timeline = foldContextTimeline({
		sessionId,
		file,
		cwd,
		source: "journal",
		entries: branch,
		limits,
		agents: [],
		normalizePath(value) {
			let stripped = value.trim();
			while (READ_SELECTOR.test(stripped)) stripped = stripped.replace(READ_SELECTOR, "");
			if (!stripped || /^[a-z][a-z0-9+.-]*:\/\//i.test(stripped)) return "";
			if (path.isAbsolute(stripped)) return path.normalize(stripped);
			// Like the live resolver, cwd wins over additionalDirectories. No journal cwd means no relative path.
			return cwd ? path.resolve(cwd, stripped) : "";
		},
	});
	return { timeline, agent, model };
}

function fleetRow(file: string, trackId: string, folded: FoldedTranscript): ContextAgentUsage {
	const { timeline, agent, model } = folded;
	// Classification operates on the uncompressed name, including advisor markers.
	const status = classifyAgentType(file.endsWith(".gz") ? file.slice(0, -3) : file);
	const last = timeline.steps.at(-1);
	return {
		trackId,
		file,
		label:
			trackId === "main"
				? "Main"
				: status === "advisor"
					? "Advisor"
					: `${agent ?? "agent"} ${path.basename(transcriptStem(file))}`.slice(0, 80),
		agent,
		model: last?.model ?? model,
		status,
		requests: timeline.steps.length + timeline.omittedSteps,
		peakTokens: timeline.peakTokensTotal,
		lastTokens: last?.promptTokens,
		costTotal: timeline.costTotal,
	};
}

export interface ContextFingerprint {
	file: string;
	etag: string;
	children: ChildTranscript[];
}

async function readContextFingerprint(file: string): Promise<ContextFingerprint> {
	const root = await fs.stat(file);
	const children = await discoverChildTranscripts(file);
	const parts = [`${file}|${root.mtimeMs}|${root.size}`, `n=${children.length}`];
	for (const child of [...children].sort((a, b) => a.file.localeCompare(b.file))) {
		try {
			const stat = await fs.stat(child.file);
			parts.push(`${child.file}|${stat.mtimeMs}|${stat.size}`);
		} catch {
			parts.push(`${child.file}|gone`);
		}
	}
	return { file, children, etag: createHash("sha256").update(parts.join("\n")).digest("hex") };
}

/** Cheap conditional-request check; the full build owns 400/404 error mapping. */
export async function contextFingerprintForEtag(file: string): Promise<ContextFingerprint | undefined> {
	try {
		return await readContextFingerprint(resolveContextFile(file));
	} catch {
		return undefined;
	}
}

export interface ContextSessionTimelineResult {
	timeline: ContextTimeline;
	etag: string;
}

export async function buildSessionContextResponse(
	file: string,
	limits?: Partial<ContextTimelineLimits>,
	fingerprint?: ContextFingerprint,
): Promise<ContextSessionTimelineResult> {
	const resolved = resolveContextFile(file);
	const before = fingerprint?.file === resolved ? fingerprint : await readContextFingerprint(resolved);
	const folded = await foldTranscript(resolved, limits);
	folded.timeline.agents.push(fleetRow(resolved, "main", folded));
	for (const child of before.children) {
		try {
			// Fleet summaries use the full API step window, independent of the caller's display limits.
			const childFold = await foldTranscript(child.file);
			folded.timeline.agents.push(fleetRow(child.file, child.key, childFold));
		} catch {
			// A raced removal or corrupt child must not discard the readable root timeline.
		}
	}
	// Never mark an old body with a newer, post-read key. If a writer races this build,
	// retaining the pre-read fingerprint forces the next poll to rebuild (no body memo).
	return { timeline: folded.timeline, etag: before.etag };
}

export async function buildSessionContextTimeline(
	file: string,
	limits?: Partial<ContextTimelineLimits>,
): Promise<ContextTimeline> {
	return (await buildSessionContextResponse(file, limits)).timeline;
}
