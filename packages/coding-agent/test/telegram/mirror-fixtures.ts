/**
 * Fakes and fixtures for the mirror slice: an in-memory {@link TopicRegistry},
 * a recording {@link TelegramTopics}, a capturing timer factory, presence
 * builders and temp session files written in omp's own JSONL format.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionPresence, SessionPresenceKind } from "../../src/session/session-presence";
import { createMirror } from "../../src/telegram/mirror";
import type {
	Clock,
	MirrorDeps,
	MirrorService,
	TelegramChatId,
	TelegramTopics,
	TopicEntry,
	TopicEntryDraft,
	TopicEntryPatch,
	TopicRegistry,
} from "../../src/telegram/types";

export const CHAT: TelegramChatId = -100123;
export const SESSION_ID = "01a0dc64-f85e-70b5-a192-8fa3e2eed533";
export const OTHER_ID = "01a0dc65-0000-7000-8000-000000000001";
export const AT = "2026-09-26T07:15:06.353Z";
const STAMP = "2026-09-26T06-26-39-838Z";
const CLOCK = 1_700_000_000_000;

// ── registry ───────────────────────────────────────────────────────────────

class FakeRegistry implements TopicRegistry {
	readonly path = "/tmp/omp-mirror-registry.json";
	readonly entries = new Map<number, TopicEntry>();

	list(): TopicEntry[] {
		return [...this.entries.values()];
	}

	get(threadId: number): TopicEntry | null {
		return this.entries.get(threadId) ?? null;
	}

	byName(name: string): TopicEntry | null {
		const wanted = name.toLowerCase();
		const matches = this.list().filter(entry => entry.name.toLowerCase() === wanted);
		return matches.find(entry => entry.status !== "closed") ?? matches[0] ?? null;
	}

	bySessionFile(sessionFile: string): TopicEntry | null {
		return this.list().find(entry => entry.sessionFile === sessionFile) ?? null;
	}

	put(draft: TopicEntryDraft): TopicEntry {
		if (this.entries.has(draft.threadId)) throw new Error(`thread ${draft.threadId} already exists`);
		const open = this.list().filter(entry => entry.status !== "closed");
		if (draft.name !== "" && open.some(entry => entry.name.toLowerCase() === draft.name.toLowerCase())) {
			throw new Error(`name taken: ${draft.name}`);
		}
		const now = draft.createdAt ?? CLOCK;
		const entry: TopicEntry = { ...draft, createdAt: now, updatedAt: draft.updatedAt ?? now };
		this.entries.set(entry.threadId, entry);
		return entry;
	}

	update(threadId: number, patch: TopicEntryPatch): TopicEntry {
		const existing = this.entries.get(threadId);
		if (existing === undefined) throw new Error(`unknown thread ${threadId}`);
		const entry: TopicEntry = { ...existing, ...patch, updatedAt: CLOCK };
		this.entries.set(threadId, entry);
		return entry;
	}

	remove(threadId: number): TopicEntry | null {
		const existing = this.entries.get(threadId) ?? null;
		this.entries.delete(threadId);
		return existing;
	}

	freeName(base: string): string {
		const taken = new Set(
			this.list()
				.filter(entry => entry.status !== "closed")
				.map(entry => entry.name.toLowerCase()),
		);
		if (!taken.has(base.toLowerCase())) return base;
		for (let at = 2; ; at += 1) {
			const candidate = `${base} ${at}`;
			if (!taken.has(candidate.toLowerCase())) return candidate;
		}
	}

	async flush(): Promise<void> {
		// Mutations land in the map immediately; there is no file to wait for.
	}
}

export function entryAt(registry: TopicRegistry, threadId: number): TopicEntry {
	const entry = registry.get(threadId);
	if (entry === null) throw new Error(`no registry entry for thread ${threadId}`);
	return entry;
}

// ── topics ─────────────────────────────────────────────────────────────────

export interface FakeTopics extends TelegramTopics {
	sent: Array<{ threadId: number | null; markdown: string }>;
	created: string[];
	closed: Array<{ threadId: number; name: string }>;
	renamed: Array<{ threadId: number; name: string }>;
}

export function fakeTopics(createThreadId: number | null = 900): FakeTopics {
	const sent: FakeTopics["sent"] = [];
	const created: string[] = [];
	const closed: FakeTopics["closed"] = [];
	const renamed: FakeTopics["renamed"] = [];
	let next = createThreadId;
	return {
		sent,
		created,
		closed,
		renamed,
		notify: async (threadId, markdown) => {
			sent.push({ threadId, markdown });
			return true;
		},
		create: async name => {
			created.push(name);
			const id = next;
			if (id === null) return null;
			next = id + 1;
			return id;
		},
		close: async (threadId, name) => {
			closed.push({ threadId, name });
			return true;
		},
		reopen: async () => true,
		rename: async (threadId, name) => {
			renamed.push({ threadId, name });
		},
	};
}

export function sentTo(topics: FakeTopics, threadId: number): string[] {
	return topics.sent.filter(one => one.threadId === threadId).map(one => one.markdown);
}

export function allText(topics: FakeTopics): string[] {
	return topics.sent.map(one => one.markdown);
}

export function lastText(topics: FakeTopics): string {
	return topics.sent.at(-1)?.markdown ?? "";
}

// ── timers ─────────────────────────────────────────────────────────────────

export interface FakeTimer {
	ms: number;
	tick: () => Promise<void>;
	cancelled: boolean;
}

export interface FakeTimers {
	every(ms: number, tick: () => Promise<void>): () => void;
	timers: FakeTimer[];
	of(ms: number): FakeTimer[];
}

export function fakeTimers(): FakeTimers {
	const timers: FakeTimer[] = [];
	return {
		timers,
		every: (ms, tick) => {
			const timer: FakeTimer = { ms, tick, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		of: ms => timers.filter(timer => timer.ms === ms),
	};
}

export function timerAt(timers: FakeTimers, ms: number): FakeTimer {
	const timer = timers.of(ms)[0];
	if (timer === undefined) throw new Error(`no timer every ${ms} ms`);
	return timer;
}

// ── session files ──────────────────────────────────────────────────────────

const tempDirs: string[] = [];

/**
 * Removes every sandbox {@link makeSandbox} created. Bun shares one module
 * instance across test files, so a module-level `afterEach` here would only
 * register in the first file that imports it: each importing file calls this
 * from its own `afterEach` instead.
 */
export function cleanupSandboxes(): void {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

export interface Sandbox {
	file: string;
	size(): number;
	write(records: unknown[]): void;
	append(records: unknown[]): void;
	appendRaw(text: string): void;
}

export function makeSandbox(id: string = SESSION_ID): Sandbox {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mirror-"));
	tempDirs.push(root);
	const dir = path.join(root, "-code-work");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${STAMP}_${id}.jsonl`);
	const lines = (records: unknown[]): string => records.map(record => `${JSON.stringify(record)}\n`).join("");
	return {
		file,
		size: () => fs.statSync(file).size,
		write: records => fs.writeFileSync(file, lines(records)),
		append: records => fs.appendFileSync(file, lines(records)),
		appendRaw: text => fs.appendFileSync(file, text),
	};
}

export function sessionHead(options: { title?: string; cwd?: string; id?: string } = {}): unknown[] {
	const title = options.title ?? "Mirror review";
	const cwd = options.cwd ?? "/work/one";
	const id = options.id ?? SESSION_ID;
	return [
		{ type: "title", v: 1, title, source: "auto", updatedAt: AT, pad: "" },
		{ type: "session", version: 3, id, timestamp: AT, cwd, title },
	];
}

export function humanSaid(text: string, extra: Record<string, unknown> = {}): unknown {
	return {
		type: "message",
		id: "m1",
		timestamp: AT,
		message: { role: "user", attribution: "user", timestamp: AT, content: [{ type: "text", text }], ...extra },
	};
}

export function agentSaid(text: string, parts: unknown[] = []): unknown {
	return {
		type: "message",
		id: "m2",
		timestamp: AT,
		message: { role: "assistant", stopReason: "stop", content: [...parts, { type: "text", text }] },
	};
}

export function agentThought(text: string): unknown {
	return { type: "thinking", thinking: text };
}

export function toolCall(name: string, args: Record<string, unknown> = {}): unknown {
	return { type: "toolCall", id: `call_${name}`, name, arguments: args };
}

export function askCalled(questions: unknown[]): unknown {
	return {
		type: "message",
		id: "m3",
		timestamp: AT,
		message: { role: "assistant", stopReason: "toolUse", content: [toolCall("ask", { questions })] },
	};
}

export function askAnswered(details: unknown): unknown {
	return {
		type: "message",
		id: "m4",
		timestamp: AT,
		message: {
			role: "toolResult",
			toolCallId: "call_ask",
			toolName: "ask",
			content: [{ type: "text", text: "handled" }],
			details,
			isError: false,
		},
	};
}

export function toolResult(name: string): unknown {
	return {
		type: "message",
		id: "m5",
		timestamp: AT,
		message: {
			role: "toolResult",
			toolCallId: `call_${name}`,
			toolName: name,
			content: [{ type: "text", text: "output" }],
			isError: false,
		},
	};
}

export function customPrompt(text: string, options: { customType?: string; attribution?: string } = {}): unknown {
	return {
		type: "custom_message",
		customType: options.customType ?? "collab-prompt",
		content: text,
		display: true,
		details: { from: "guest" },
		attribution: options.attribution ?? "user",
		id: "m6",
		timestamp: AT,
	};
}

// ── presence ───────────────────────────────────────────────────────────────

export function liveSession(options: {
	file: string;
	session?: string;
	cwd?: string;
	pid?: number;
	kind?: SessionPresenceKind;
	name?: string | null;
}): SessionPresence {
	return {
		pid: options.pid ?? 4242,
		kind: options.kind ?? "interactive",
		sessionId: options.session ?? SESSION_ID,
		sessionFile: options.file,
		cwd: options.cwd ?? "/work/one",
		sessionName: options.name ?? null,
		startedAt: 1,
		updatedAt: 2,
	};
}

// ── harness ────────────────────────────────────────────────────────────────

export interface MirrorHarness {
	mirror: MirrorService;
	registry: TopicRegistry;
	topics: FakeTopics;
	timers: FakeTimers;
	clock: Clock;
	setLive(sessions: SessionPresence[]): void;
	setPresenceFailure(message: string | null): void;
}

export function mirrorHarness(
	options: {
		entries?: TopicEntry[];
		heldHere?: (entry: TopicEntry) => boolean;
		createThreadId?: number | null;
	} = {},
): MirrorHarness {
	const registry = new FakeRegistry();
	for (const entry of options.entries ?? []) registry.put(entry);
	const topics = fakeTopics(options.createThreadId === undefined ? 900 : options.createThreadId);
	const timers = fakeTimers();
	const clock: Clock = { now: () => CLOCK };
	const presence: { sessions: SessionPresence[]; failure: Error | null } = { sessions: [], failure: null };
	const deps: MirrorDeps = {
		chatId: CHAT,
		registry,
		topics,
		livePresence: async () => {
			if (presence.failure !== null) throw presence.failure;
			return presence.sessions;
		},
		isHeldHere: options.heldHere ?? (() => false),
		clock,
		every: (ms, tick) => timers.every(ms, tick),
	};
	return {
		mirror: createMirror(deps),
		registry,
		topics,
		timers,
		clock,
		setLive: sessions => {
			presence.sessions = sessions;
		},
		setPresenceFailure: message => {
			presence.failure = message === null ? null : new Error(message);
		},
	};
}
