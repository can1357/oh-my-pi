/**
 * A large, deterministic session that exercises every shape the tail-first
 * snapshot has to handle (issue #9469): hundreds of turns, two compactions
 * (the last one keeping from mid-turn), an abandoned branch, image blocks in
 * a user message, a tool result, eval `details.images` and a manual bash
 * `images` field, a string the shrinker clips, an entry whose size lives in
 * its keys (so the shrinker has to replace the whole entry), and one turn that
 * alone is larger than a 1 MiB page.
 *
 * Content is seeded; the only wall-clock values are the entry timestamps the
 * session manager stamps itself.
 */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { isTurnStartEntry } from "@oh-my-pi/pi-agent-core/compaction";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/** Ids of the fixture entries the tail-snapshot tests aim at. */
export interface TailFixtureIds {
	userImage: string;
	toolImage: string;
	detailsImage: string;
	bashImage: string;
	/**
	 * Tool result of three 450 KiB text blocks (1.35 MB): the shrinker's first pass
	 * clips each to 64 KiB. Each block stays under session persistence's 500 000-char
	 * cap (session-persistence.ts), so the entry clips the same after a resume.
	 */
	clippedString: string;
	/** Tool result whose size lives in `details` keys: the shrinker replaces the whole entry. */
	keyHeavy: string;
	/** Turn-start entry of the turn that alone exceeds 1 MiB. */
	bigTurnStart: string;
	firstCompaction: string;
	lastCompaction: string;
	/** The last compaction's `firstKeptEntryId`; an assistant entry, not a turn start. */
	lastFirstKept: string;
	/** Leaf of the abandoned branch (not on the active path). */
	abandonedLeaf: string;
}

export interface TailFixture {
	sessionManager: SessionManager;
	ids: TailFixtureIds;
}

const TURNS = 300;

// ── Deterministic content ───────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS =
	"the host guest snapshot entry turn page cursor branch compaction relay frame chunk budget image output tool result session replay history tail placeholder value offset hash stale reconnect welcome scroll prepend render".split(
		" ",
	);

/** `bytes` of seeded prose-ish ASCII, broken into lines like tool output. */
function prose(rand: () => number, bytes: number): string {
	const parts: string[] = [];
	let size = 0;
	let line = 0;
	while (size < bytes) {
		const word = WORDS[Math.floor(rand() * WORDS.length)] ?? "x";
		line += word.length + 1;
		const sep = line > 96 ? "\n" : " ";
		if (sep === "\n") line = 0;
		parts.push(word, sep);
		size += word.length + 1;
	}
	return parts.join("").slice(0, bytes);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * An `image/png` block of exactly `bytes` decoded bytes: the PNG signature
 * (so a snapshot that still carries it is recognisable by its base64 prefix)
 * followed by seeded noise. Tests compare sizes and hashes, never pixels.
 */
function pngImage(rand: () => number, bytes: number): ImageContent {
	const data = Buffer.alloc(bytes);
	data.set(PNG_SIGNATURE);
	for (let i = PNG_SIGNATURE.length; i < bytes; i++) data[i] = Math.floor(rand() * 256);
	return { type: "image", data: data.toString("base64"), mimeType: "image/png" };
}

// ── Session construction ────────────────────────────────────────────────────

const USAGE = {
	input: 1200,
	output: 400,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1600,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * A fresh in-memory session holding the fixture. Every append goes through the
 * public session API, so the tree is exactly what a live session would persist.
 */
export function buildTailFixture(): TailFixture {
	const sessionManager = SessionManager.inMemory("/work/tail-fixture");
	const rand = mulberry32(9469);
	let clock = Date.UTC(2026, 8, 1);
	const tick = () => (clock += 1_000);
	let callSeq = 0;
	const ids: Partial<TailFixtureIds> = {};

	const user = (content: string | (ImageContent | { type: "text"; text: string })[]) =>
		sessionManager.appendMessage({ role: "user", content, timestamp: tick() });

	/** Assistant turn that calls one tool; returns [assistantId, toolCallId]. */
	const assistantCall = (toolName: string, args: Record<string, unknown>, thinkingBytes: number): [string, string] => {
		const toolCallId = `call_${(++callSeq).toString().padStart(5, "0")}`;
		const id = sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: prose(rand, thinkingBytes) },
				{ type: "text", text: prose(rand, 400) },
				{ type: "toolCall", id: toolCallId, name: toolName, arguments: args },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-fixture",
			usage: USAGE,
			stopReason: "toolUse",
			timestamp: tick(),
		});
		return [id, toolCallId];
	};

	const toolResult = (
		toolCallId: string,
		toolName: string,
		content: (ImageContent | { type: "text"; text: string })[],
		details?: unknown,
	) =>
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName,
			content,
			details,
			isError: false,
			timestamp: tick(),
		});

	const assistantReply = (bytes: number) =>
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: prose(rand, bytes) }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-fixture",
			usage: USAGE,
			stopReason: "stop",
			timestamp: tick(),
		});

	/** An ordinary ~75 KB turn: prompt, two tool calls, a reply. No string reaches 64 KiB. */
	const ordinaryTurn = (n: number): string => {
		const start = user(`Turn ${n}: ${prose(rand, 600)}`);
		for (let k = 0; k < 2; k++) {
			const [, callId] = assistantCall("read", { path: `src/file-${n}-${k}.ts` }, 4_000);
			toolResult(callId, "read", [{ type: "text", text: prose(rand, 30_000) }]);
		}
		assistantReply(2_000);
		return start;
	};

	for (let n = 0; n < TURNS; n++) {
		switch (n) {
			case 20: {
				// Abandoned branch: two turns off turn 19's reply, then rewind.
				const forkPoint = sessionManager.getLeafId();
				if (!forkPoint) throw new Error("fixture: no leaf before the fork point");
				ordinaryTurn(n);
				user(`Abandoned follow-up: ${prose(rand, 500)}`);
				ids.abandonedLeaf = assistantReply(1_000);
				sessionManager.branch(forkPoint);
				ordinaryTurn(n);
				break;
			}
			case 60: {
				ordinaryTurn(n);
				// First compaction keeps from turn 55's start (a turn boundary).
				const kept = sessionManager.getBranch().filter(isTurnStartEntry).at(-6);
				if (!kept) throw new Error("fixture: missing compaction anchor");
				ids.firstCompaction = sessionManager.appendCompaction(prose(rand, 8_000), "Earlier work", kept.id, 180_000);
				break;
			}
			case 120:
				ids.userImage = user([
					{ type: "text", text: "Here is the screenshot of the broken layout." },
					pngImage(rand, 300 * 1024),
				]);
				assistantReply(1_500);
				break;
			case 150: {
				user("Take a screenshot of the dashboard.");
				const [, callId] = assistantCall("browser", { action: "screenshot" }, 1_000);
				ids.toolImage = toolResult(callId, "browser", [
					{ type: "text", text: "Captured 1600x1125." },
					pngImage(rand, 2 * 1024 * 1024),
				]);
				assistantReply(800);
				break;
			}
			case 160: {
				user("Plot the frame sizes.");
				const [, callId] = assistantCall("eval", { language: "py", code: "plot(sizes)" }, 1_000);
				ids.detailsImage = toolResult(callId, "eval", [{ type: "text", text: "<Figure 640x480>" }], {
					images: [pngImage(rand, 200 * 1024)],
				});
				assistantReply(800);
				break;
			}
			case 170:
				ids.bashImage = sessionManager.appendMessage({
					role: "bashExecution",
					command: "imgcat chart.png",
					output: "",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					images: [pngImage(rand, 150 * 1024)],
					timestamp: tick(),
				});
				break;
			case 200: {
				user("Dump the full build log.");
				const [, callId] = assistantCall("bash", { command: "cat build.log" }, 1_000);
				ids.clippedString = toolResult(
					callId,
					"bash",
					Array.from({ length: 3 }, () => ({ type: "text" as const, text: prose(rand, 450 * 1024) })),
				);
				assistantReply(800);
				break;
			}
			case 210: {
				user("List every file the indexer touched.");
				const [, callId] = assistantCall("index", { root: "." }, 1_000);
				// ~1.3 MB of object keys: no string or array pass can shrink it.
				const files: Record<string, number> = {};
				for (let i = 0; i < 20_000; i++)
					files[`src/generated/module-${i.toString().padStart(5, "0")}/index.generated.ts`] = i;
				ids.keyHeavy = toolResult(callId, "index", [{ type: "text", text: "Indexed 20000 files." }], { files });
				assistantReply(800);
				break;
			}
			case 230: {
				// One turn well over a 1 MiB page, with every entry under the 1 MiB shrink ceiling.
				ids.bigTurnStart = user("Run the three slow test suites.");
				for (let k = 0; k < 3; k++) {
					const [, callId] = assistantCall("bash", { command: `bun test suite-${k}` }, 2_000);
					toolResult(
						callId,
						"bash",
						Array.from({ length: 8 }, () => ({ type: "text" as const, text: prose(rand, 50_000) })),
					);
				}
				assistantReply(1_000);
				break;
			}
			case 260: {
				ordinaryTurn(n);
				// Last compaction keeps from mid-turn: the first assistant entry of turn 255.
				const path = sessionManager.getBranch();
				const starts = path.flatMap((e, i) => (isTurnStartEntry(e) ? [i] : []));
				const turnStart = starts.at(-6);
				const midTurn = turnStart === undefined ? undefined : path[turnStart + 1];
				if (!midTurn || isTurnStartEntry(midTurn)) throw new Error("fixture: no mid-turn anchor");
				ids.lastFirstKept = midTurn.id;
				ids.lastCompaction = sessionManager.appendCompaction(prose(rand, 8_000), "Later work", midTurn.id, 190_000);
				break;
			}
			default:
				ordinaryTurn(n);
		}
	}

	for (const key of [
		"userImage",
		"toolImage",
		"detailsImage",
		"bashImage",
		"clippedString",
		"keyHeavy",
		"bigTurnStart",
		"firstCompaction",
		"lastCompaction",
		"lastFirstKept",
		"abandonedLeaf",
	] as const) {
		if (!ids[key]) throw new Error(`fixture: ${key} was not recorded`);
	}
	return { sessionManager, ids: ids as TailFixtureIds };
}
