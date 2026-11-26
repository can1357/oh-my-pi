import { describe, expect, it } from "bun:test";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const SESSION_DIR = "/sessions/project";

const assistant = (provider: string, model: string, stopReason = "stop"): string =>
	JSON.stringify({
		type: "message",
		message: { role: "assistant", provider, model, stopReason, content: [{ type: "text", text: "ok" }] },
	});

/** The newest reply of an assistant whose provider/model went unrecorded. */
const anonymousAssistant = (stopReason = "stop"): string =>
	JSON.stringify({
		type: "message",
		message: { role: "assistant", stopReason, content: [{ type: "text", text: "ok" }] },
	});

const header = (id: string): string =>
	JSON.stringify({ type: "session", id, cwd: "/repo", timestamp: "2026-06-27T00:00:00.000Z" });

/** A session's rows, by id. */
async function scan(
	...files: [name: string, lines: string[]][]
): Promise<Record<string, { model?: string; status?: string }>> {
	const storage = new MemorySessionStorage();
	for (const [name, lines] of files) storage.writeTextSync(`${SESSION_DIR}/${name}.jsonl`, lines.join("\n") + "\n");
	return Object.fromEntries((await listSessions(SESSION_DIR, storage)).map(session => [session.id, session]));
}

describe("session listing model", () => {
	it("names the last assistant reply's provider/model, not a later switch or a trailing prompt", async () => {
		const sessions = await scan([
			"pending",
			[
				header("pending"),
				JSON.stringify({ type: "message", message: { role: "user", content: "first" } }),
				assistant("anthropic", "claude-sonnet-4-5"),
				JSON.stringify({ type: "model_change", model: "openai/gpt-5.2" }),
				JSON.stringify({ type: "message", message: { role: "user", content: "go on" } }),
			],
		]);
		// A regression names the later model_change entry's model, or none, for a session waiting on the user.
		expect(sessions.pending).toMatchObject({ model: "anthropic/claude-sonnet-4-5", status: "pending" });
	});

	it("follows the model across replies and leaves it unset for a session that never replied", async () => {
		const sessions = await scan(
			[
				"switched",
				[
					header("switched"),
					assistant("anthropic", "claude-sonnet-4-5"),
					JSON.stringify({ type: "model_change", model: "openai/gpt-5.2" }),
					assistant("openai", "gpt-5.2", "error"),
				],
			],
			[
				"unanswered",
				[header("unanswered"), JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })],
			],
		);
		// A regression shows a session's first model, or a model for a 0-turn stub, in `/resume`.
		expect(sessions.switched).toMatchObject({ model: "openai/gpt-5.2", status: "error" });
		expect(sessions.unanswered).not.toHaveProperty("model");
	});

	it("leaves the model unknown when the newest assistant reply has no identity", async () => {
		const sessions = await scan([
			"anonymous",
			[header("anonymous"), assistant("anthropic", "claude-sonnet-4-5"), anonymousAssistant()],
		]);
		// A regression shows the older reply's model for a session whose newest
		// reply came from a source that recorded no provider/model.
		expect(sessions.anonymous).toMatchObject({ status: "complete" });
		expect(sessions.anonymous).not.toHaveProperty("model");
	});

	it("strips control characters, C1 included, from the model before it reaches the picker", async () => {
		const sessions = await scan(
			// C0 escapes (ESC CSI, BEL) and a tab: the sequences go whole, the
			// tab becomes spaces — no "[31m" fragments survive.
			["crafted", [header("crafted"), assistant("acme", "model\u001b[31mred\u001b[0m\tevil\u0007")]],
			// C1 controls alone (CSI U+009B, OSC U+009D) never reach the row.
			["crafted1", [header("crafted1"), assistant("acme", "m\u009b31m\u009d")]],
		);
		// A regression lets a session file recolour the terminal row, set the
		// window title, or leave escape fragments like "[31m" on the row.
		expect(sessions.crafted).toMatchObject({ model: "acme/modelred   evil" });
		expect(sessions.crafted1).toMatchObject({ model: "acme/m31m" });
	});
});
