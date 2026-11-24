import { describe, expect, it } from "bun:test";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const SESSION_DIR = "/sessions/project";

const assistant = (provider: string, model: string, stopReason = "stop"): string =>
	JSON.stringify({
		type: "message",
		message: { role: "assistant", provider, model, stopReason, content: [{ type: "text", text: "ok" }] },
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
		// Without a provider on a reply there is nothing to name.
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
});
