import { describe, expect, it } from "bun:test";
import { isAssistantMessageLine } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionStatus } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
const SESSION_DIR = "/sessions/status-proj";

function line(obj: unknown): string {
	return `${JSON.stringify(obj)}\n`;
}

function header(id: string): string {
	return line({ type: "session", version: 3, id, cwd: "/proj", timestamp: new Date().toISOString() });
}

let nextEntryId = 0;
function msg(message: unknown): string {
	nextEntryId += 1;
	return line({
		type: "message",
		id: `e${nextEntryId}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	});
}

const user = (text: string) => msg({ role: "user", content: text });
const assistant = (stopReason: string, content: unknown[]) =>
	msg({ role: "assistant", provider: "anthropic", model: "m", stopReason, content });
const toolResult = () =>
	msg({ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "ok" }] });
const textBlock = (text: string) => ({ type: "text", text });
const toolCallBlock = () => ({ type: "toolCall", id: "t1", name: "read", arguments: {} });

/** Build a fresh in-memory store seeded with one session file per id. */
function seed(files: Record<string, string>): MemorySessionStorage {
	const storage = new MemorySessionStorage();
	for (const id in files) {
		storage.writeTextSync(`${SESSION_DIR}/${id}.jsonl`, header(id) + files[id]);
	}
	return storage;
}

async function statusById(storage: MemorySessionStorage): Promise<Map<string, SessionStatus | undefined>> {
	const sessions = await SessionManager.list("/proj", SESSION_DIR, storage);
	return new Map(sessions.map(s => [s.id, s.status]));
}

describe("SessionManager.list session status (tail derivation)", () => {
	it("classifies each terminal-entry shape from the session tail", async () => {
		const storage = seed({
			complete: user("hi") + assistant("stop", [textBlock("all done")]),
			"interrupted-tooluse": user("go") + assistant("toolUse", [toolCallBlock()]),
			"interrupted-toolresult": user("go") + assistant("toolUse", [toolCallBlock()]) + toolResult(),
			aborted: user("go") + assistant("aborted", [{ type: "thinking", thinking: "x" }]),
			error: user("go") + assistant("error", []),
			pending: user("still waiting for a reply"),
			// `stop` but with an unanswered tool call → the loop was cut off before
			// running it, so this is interrupted rather than complete.
			"stop-with-pending-tool": user("go") + assistant("stop", [toolCallBlock()]),
		});

		const status = await statusById(storage);
		expect(status.get("complete")).toBe("complete");
		expect(status.get("interrupted-tooluse")).toBe("interrupted");
		expect(status.get("interrupted-toolresult")).toBe("interrupted");
		expect(status.get("aborted")).toBe("aborted");
		expect(status.get("error")).toBe("error");
		expect(status.get("pending")).toBe("pending");
		expect(status.get("stop-with-pending-tool")).toBe("interrupted");
	});

	it("excludes untitled header-only sessions from the picker list but keeps them in raw list", async () => {
		const storage = seed({ "header-only": "" });
		expect((await SessionManager.list("/proj", SESSION_DIR, storage)).map(s => s.id)).toEqual(["header-only"]);
		expect((await SessionManager.listForPicker("/proj", SESSION_DIR, storage)).map(s => s.id)).toEqual([]);
	});
	it("keeps titled header-only sessions in the picker list", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(
			`${SESSION_DIR}/titled-empty.jsonl`,
			`${JSON.stringify({ type: "session", version: 3, id: "titled-empty", cwd: "/proj", title: "Named stub", timestamp: new Date().toISOString() })}\n`,
		);
		expect((await SessionManager.listForPicker("/proj", SESSION_DIR, storage)).map(s => s.id)).toEqual([
			"titled-empty",
		]);
	});

	it("elides unnamed 0-turn stubs from the picker but keeps named 0-turn sessions", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(`${SESSION_DIR}/named-user-only.jsonl`, header("named-user-only") + user("typed prompt"));
		storage.writeTextSync(`${SESSION_DIR}/blank-stub.jsonl`, header("blank-stub"));
		expect((await SessionManager.listForPicker("/proj", SESSION_DIR, storage)).map(s => s.id).sort()).toEqual([
			"named-user-only",
		]);
	});

	it("keeps a titleless session whose first assistant turn starts past the prefix", async () => {
		const bigImage = `data:image/png;base64,${"a".repeat(5000)}`;
		const storage = seed({
			"late-assistant": user(bigImage) + assistant("stop", [textBlock("answered")]),
		});
		expect((await SessionManager.listForPicker("/proj", SESSION_DIR, storage)).map(s => s.id)).toEqual([
			"late-assistant",
		]);
	});

	it("keeps a pending session whose assistant reply sits mid-transcript", async () => {
		const bigImage = `data:image/png;base64,${"a".repeat(5000)}`;
		const storage = seed({
			"mid-assistant-pending":
				user(bigImage) + assistant("stop", [textBlock("answered")]) + user("awaiting follow-up"),
		});
		expect((await SessionManager.listForPicker("/proj", SESSION_DIR, storage)).map(s => s.id)).toEqual([
			"mid-assistant-pending",
		]);
	});

	it("keeps a titleless session whose only assistant record fits in neither window", async () => {
		const imageBlock = { type: "image", data: "a".repeat(5000), mimeType: "image/png" };
		const bigAssistant = "b".repeat(40_000);
		const storage = seed({
			"middle-gap-assistant":
				msg({ role: "user", content: [imageBlock] }) + assistant("stop", [textBlock(bigAssistant)]),
		});
		expect((await SessionManager.listForPicker("/proj", SESSION_DIR, storage)).map(s => s.id)).toEqual([
			"middle-gap-assistant",
		]);
	});

	it("keeps a gap assistant record serialized with valid JSON whitespace", async () => {
		expect(isAssistantMessageLine('{"type" : "message", "message": {"role" : "assistant"}}')).toBe(true);
		expect(isAssistantMessageLine('{"type":"message","message":{"role":\t"assistant"}}')).toBe(true);
		const imageBlock = { type: "image", data: "a".repeat(5000), mimeType: "image/png" };
		const bigAssistant = "b".repeat(40_000);
		const userLine = JSON.stringify({ role: "user", content: [imageBlock] });
		const asstRecord = JSON.stringify({
			type: "message",
			id: "e-gap",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "m",
				stopReason: "stop",
				content: [{ type: "text", text: bigAssistant }],
			},
		})
			.replace('"type":', '"type" :')
			.replace('"role":', '"role" :');
		const storage = new MemorySessionStorage();
		storage.writeTextSync(
			`${SESSION_DIR}/gap-whitespace.jsonl`,
			`${JSON.stringify({ type: "session", version: 3, id: "gap-whitespace", cwd: "/proj", timestamp: new Date().toISOString() })}\n${userLine}\n${asstRecord}\n`,
		);
		expect((await SessionManager.listForPicker("/proj", SESSION_DIR, storage)).map(s => s.id)).toEqual([
			"gap-whitespace",
		]);
	});
	it("reports unknown rather than misclassifying when the final message exceeds the tail window", async () => {
		// A completed turn whose final assistant message is larger than the 32 KiB
		// tail window: the window only captures a fragment of that final line, which
		// fails to parse. The picker must surface 'unknown', never a wrong status.
		const huge = "x".repeat(40_000);
		const storage = seed({
			"huge-complete": user("go") + assistant("toolUse", [toolCallBlock()]) + assistant("stop", [textBlock(huge)]),
		});

		const status = await statusById(storage);
		expect(status.get("huge-complete")).toBe("unknown");
	});
});
