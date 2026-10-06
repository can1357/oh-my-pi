import { afterEach, describe, expect, it } from "bun:test";
import {
	MIRROR_CLOSED,
	MIRROR_ENDED,
	MIRROR_READOPTED,
	mirrorChunks,
	mirrorHeader,
	mirrorName,
	readSessionLines,
	refusalText,
	sessionCwdOf,
	sessionTitleOf,
	transcriptMessages,
	transcriptMessagesFrom,
} from "../../src/telegram/mirror-text";
import { mdText } from "../../src/telegram/rich";
import {
	agentSaid,
	agentThought,
	askAnswered,
	askCalled,
	AT,
	cleanupSandboxes,
	customPrompt,
	humanSaid,
	makeSandbox,
	SESSION_ID,
	sessionHead,
	toolCall,
	toolResult,
} from "./mirror-fixtures";

afterEach(cleanupSandboxes);

const turn = (records: unknown[]): string => `${records.map(record => JSON.stringify(record)).join("\n")}\n`;

describe("transcript parsing", () => {
	it("relays human prompts and agent replies, dropping thinking, other tool calls and tool results", () => {
		expect(
			transcriptMessages(
				turn([
					humanSaid("how are you?"),
					agentSaid("fine", [agentThought("weighing it")]),
					{ type: "custom", customType: "tool_execution_start", data: { toolName: "bash" } },
					toolResult("bash"),
				]),
			),
		).toEqual([
			{ who: "human", text: "how are you?" },
			{ who: "agent", text: "fine" },
		]);
	});

	it("relays user-attributed custom messages as human prompts and drops agent-attributed ones", () => {
		expect(
			transcriptMessages(
				turn([
					customPrompt("from the phone"),
					customPrompt("written by the bridge", { customType: "hook", attribution: "agent" }),
				]),
			),
		).toEqual([{ who: "human", text: "from the phone" }]);
	});

	it("skips synthetic user messages and partial JSON lines", () => {
		const lines = `${JSON.stringify(humanSaid("auto continued", { synthetic: true }))}\n{"type":"message","message":{"role":"user","cont`;
		expect(transcriptMessages(lines)).toEqual([]);
	});

	it("turns an ask tool call into a notice with numbered options, a recommended mark and the terminal-only tail", () => {
		const found = transcriptMessages(
			turn([
				askCalled([
					{
						id: "auth",
						question: "Which sign-in?",
						options: [{ label: "JWT", description: "stateless tokens" }, { label: "OAuth2" }],
						recommended: 0,
					},
				]),
			]),
		);
		expect(found).toHaveLength(1);
		expect(found[0].who).toBe("agent");
		const lines = found[0].text.split("\n");
		expect(lines).toContain("**The agent is waiting for an answer in the terminal:**");
		expect(lines).toContain(`**${mdText("Which sign-in?")}**`);
		expect(lines).toContain("1. **JWT** — stateless tokens ⭐");
		expect(lines).toContain("2. **OAuth2**");
		expect(lines).toContain("You can answer only in the terminal.");
	});

	it("turns an ask result into an answer line", () => {
		expect(
			transcriptMessages(
				turn([
					askAnswered({
						question: "Which sign-in?",
						options: ["JWT", "OAuth2"],
						multi: false,
						selectedOptions: ["JWT"],
					}),
				]),
			),
		).toEqual([{ who: "agent", text: "**Answer:** JWT" }]);
	});

	it("names every question of a multi-question ask result and marks unanswered ones", () => {
		expect(
			transcriptMessages(
				turn([
					askAnswered({
						results: [
							{ id: "storage", question: "Storage?", options: ["SQLite"], selectedOptions: ["SQLite"] },
							{ id: "auth", question: "Sign-in?", options: ["JWT"], selectedOptions: [] },
						],
					}),
				]),
			),
		).toEqual([{ who: "agent", text: "**Answer:** storage: SQLite; auth: —" }]);
	});

	it("relays a free-text ask answer, escaped", () => {
		expect(
			transcriptMessages(
				turn([
					askAnswered({ question: "Sign-in?", options: [], selectedOptions: [], customInput: "through the gate" }),
				]),
			),
		).toEqual([{ who: "agent", text: "**Answer:** through the gate" }]);
		const escaped = transcriptMessages(
			turn([askAnswered({ question: "Sign-in?", options: [], selectedOptions: [], customInput: "<b>danger</b>" })]),
		);
		expect(escaped[0].text.startsWith("**Answer:** ")).toBe(true);
		expect(escaped[0].text).not.toContain("<b>");
	});

	it("keeps file order around an ask call", () => {
		const call = toolCall("ask", {
			questions: [{ id: "auth", question: "Which sign-in?", options: [{ label: "JWT" }] }],
		});
		const callFirst = transcriptMessages(turn([agentSaid("Let me ask", [call])]));
		expect(callFirst).toHaveLength(2);
		expect(callFirst[0].text).toContain("The agent is waiting for an answer in the terminal:");
		expect(callFirst[1]).toEqual({ who: "agent", text: "Let me ask" });

		const textFirst = transcriptMessages(
			turn([
				{
					type: "message",
					id: "m9",
					timestamp: AT,
					message: { role: "assistant", content: [{ type: "text", text: "First say" }, call] },
				},
			]),
		);
		expect(textFirst[0]).toEqual({ who: "agent", text: "First say" });
		expect(textFirst[1].text).toContain("The agent is waiting for an answer in the terminal:");
	});
});

describe("relayed text", () => {
	it("quotes human prompts with a per-line quote", () => {
		expect(mirrorChunks({ who: "human", text: "how are you?" })).toEqual(["> 👤 **Human:** how are you?"]);
		expect(mirrorChunks({ who: "human", text: "" })).toEqual(["> 👤 **Human:**"]);
		expect(mirrorChunks({ who: "human", text: "one\ntwo" })).toEqual(["> 👤 **Human:** one\n> two"]);
	});

	it("relays agent replies as markdown, dropping empty ones", () => {
		expect(mirrorChunks({ who: "agent", text: "# Answer\n\n- one" })).toEqual(["# Answer\n\n- one"]);
		expect(mirrorChunks({ who: "agent", text: "" })).toEqual([]);
	});

	it("escapes foreign text in a human quote", () => {
		const quoted = mirrorChunks({ who: "human", text: "<b>bold</b> and *stars*\nsecond | line" })[0];
		const [first, second] = quoted.split("\n");
		expect(first.startsWith("> 👤 **Human:** ")).toBe(true);
		expect(quoted).not.toContain("<b>");
		expect(quoted).toContain("\\*stars\\*");
		expect(second).toBe(`> ${mdText("second | line")}`);
	});

	it("builds the header from the mirrored session's name, id, pid and directory", () => {
		const header = mirrorHeader(
			{ sessionId: SESSION_ID, sessionName: null, cwd: "/work/one", pid: 4242, sessionFile: "/x.jsonl" },
			"Mirror review",
		);
		expect(header).toMatch(/^## 🖥 Mirror review$/mu);
		expect(header).toContain("Mirror of session `01a0dc64`");
		expect(header).toContain("pid `4242`");
		expect(header).toContain("- **Directory:** `/work/one`");
		expect(header).toContain("> ⚠️ The session is running in the terminal (pid 4242)");
	});

	it("names a mirror after the title, else the presence name, else the short id", () => {
		const session = { sessionId: SESSION_ID, sessionName: null, cwd: "/w", pid: 1, sessionFile: "/x" };
		expect(mirrorName(session, "Mirror review")).toBe("Mirror review");
		expect(mirrorName({ ...session, sessionName: "Fox" }, "   ")).toBe("Fox");
		expect(mirrorName(session, null)).toBe("01a0dc64");
		expect(mirrorName({ ...session, sessionId: "" }, null)).toBe("session");
	});

	it("refuses mirror text naming the pid and lists the commands available in a mirror", () => {
		expect(refusalText(null, 4242)).toStartWith("⚠️ ");
		expect(refusalText(null, 4242)).toContain("(pid 4242)");
		expect(refusalText({ name: "status", rest: "" }, 4242)).toContain(
			"Only /close and /rename work in a mirror topic.",
		);
		expect(refusalText({ name: "status", rest: "" }, null)).not.toContain("pid");
	});

	it("states the ended, closed and re-adopted notices in English", () => {
		expect(MIRROR_ENDED).toBe("The session ended in the terminal; writing here now continues it here.");
		expect(MIRROR_CLOSED).toStartWith("⚠️ Mirror closed:");
		expect(MIRROR_READOPTED).toStartWith("⚠️ The session is running in the terminal again");
	});
});

describe("session file readers", () => {
	it("reads the title and cwd of an omp session file", async () => {
		const sandbox = makeSandbox();
		sandbox.write([...sessionHead({ title: "Mirror review", cwd: "/work/one" }), agentSaid("earlier")]);
		expect(await sessionTitleOf(sandbox.file)).toBe("Mirror review");
		expect(await sessionCwdOf(sandbox.file)).toBe("/work/one");
	});

	it("reads complete lines only and leaves a trailing partial line for the next read", async () => {
		const sandbox = makeSandbox();
		sandbox.write(sessionHead());
		const from = sandbox.size();
		const partial = JSON.stringify(humanSaid("half"));
		sandbox.appendRaw(`\n${partial.slice(0, 30)}`);
		const first = await readSessionLines(sandbox.file, { from });
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.text).toBe("\n");
		expect(first.offset).toBe(from + 1);

		sandbox.appendRaw(`${partial.slice(30)}\n`);
		const second = await readSessionLines(sandbox.file, { from: first.offset });
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(transcriptMessages(second.text)).toEqual([{ who: "human", text: "half" }]);
		expect(second.offset).toBe(sandbox.size());
	});

	it("reports a missing file instead of throwing", async () => {
		const missing = await readSessionLines("/nonexistent/omp-mirror.jsonl", { from: 0 });
		expect(missing.ok).toBe(false);
	});

	it("gives each relayed message the byte offset just past its own line", async () => {
		const sandbox = makeSandbox();
		sandbox.write(sessionHead());
		const from = sandbox.size();
		const human = humanSaid("hello");
		sandbox.append([human, agentThought("weighing it"), agentSaid("hi")]);

		const chunk = await readSessionLines(sandbox.file, { from });
		expect(chunk.ok).toBe(true);
		if (!chunk.ok) return;
		const relays = transcriptMessagesFrom(chunk.text, from);
		expect(relays.map(relay => relay.message)).toEqual([
			{ who: "human", text: "hello" },
			{ who: "agent", text: "hi" },
		]);
		// The first offset is where the line after the prompt starts: rerunning the
		// read from it relays the reply alone, never the prompt again.
		const afterPrompt = from + Buffer.byteLength(`${JSON.stringify(human)}\n`);
		expect(relays[0]?.offset).toBe(afterPrompt);
		expect(relays[1]?.offset).toBe(chunk.offset);
		const resumed = await readSessionLines(sandbox.file, { from: afterPrompt });
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) return;
		expect(transcriptMessages(resumed.text)).toEqual([{ who: "agent", text: "hi" }]);
	});
});
