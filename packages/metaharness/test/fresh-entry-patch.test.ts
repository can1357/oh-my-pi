import { expect, it } from "bun:test";
import { FreshStart } from "../src/compaction/fresh";

const PLACEHOLDER = "ELIDEDMARK placeholder";
const HEAVY = `HEAVYMARK ${"heavy output ".repeat(64)}`;

function line(entry: object): string {
	return `${JSON.stringify(entry)}\n`;
}

/** A task, one tool turn and its reply; patched, an elide pass's record follows with the result's placeholder. */
function session(form: "patched" | "inline"): string {
	const output = form === "inline" ? PLACEHOLDER : HEAVY;
	let text =
		line({ type: "session", version: 3, id: `s-${form}`, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" }) +
		line({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "do the task" } }) +
		line({
			type: "message",
			id: "a1",
			parentId: "u1",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -R" } }],
				stopReason: "toolUse",
			},
		}) +
		line({
			type: "message",
			id: "t1",
			parentId: "a1",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: output }],
				isError: false,
			},
		}) +
		line({
			type: "message",
			id: "a2",
			parentId: "t1",
			message: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" },
		});
	if (form === "patched") {
		text += line({
			type: "custom",
			customType: "entry_patch",
			id: "p1",
			parentId: "a2",
			data: { patches: [{ entryId: "t1", message: { content: [{ type: "text", text: PLACEHOLDER }] } }] },
		});
	}
	return text;
}

// The fresh-start rebuild keeps the recent tail verbatim as the model's next input:
// it must keep the placeholder an elide pass recorded, not the heavy output it removed.
it("rebuilds a session with the content its entry_patch records set, as with that content inline", async () => {
	const rebuilt = async (form: "patched" | "inline") => {
		const build = await new FreshStart({ threshold: 100_000, tailChars: 1_000_000, index: false }).rebuild(
			session(form),
		);
		const entries = Bun.JSONL.parse(build.sessionJsonl) as {
			type: string;
			message?: { role: string; content: unknown };
		}[];
		const tail = entries.filter(entry => entry.message?.role === "toolResult").map(entry => entry.message?.content);
		return { heavy: build.sessionJsonl.includes("HEAVYMARK"), tail };
	};
	const fromPatched = await rebuilt("patched");
	expect(fromPatched).toEqual({ heavy: false, tail: [[{ type: "text", text: PLACEHOLDER }]] });
	expect(fromPatched).toEqual(await rebuilt("inline"));
});
