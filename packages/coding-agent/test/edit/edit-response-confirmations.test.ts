import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type ExecuteHashlineSingleOptions, executeHashlineSingle } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	} as ToolSession;
}

function execOptions(input: string, session: ToolSession): ExecuteHashlineSingleOptions {
	return {
		session,
		input,
		writethrough: async (targetPath, content) => {
			await Bun.write(targetPath, content);
			return undefined;
		},
		beginDeferredDiagnosticsForPath: () => ({
			onDeferredDiagnostics: () => {},
			signal: new AbortController().signal,
			finalize: () => {},
		}),
	};
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

const HEADER = /^\[([^#\r\n]+)#([0-9A-F]{4})\]$/m;

function tagFromOutput(text: string): string {
	const match = HEADER.exec(text);
	if (!match) throw new Error(`no hashline header in read output:\n${text}`);
	return match[2];
}

const LINES = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
const CONTENT = `${LINES.join("\n")}\n`;

async function editResponse(input: string, content: string = CONTENT): Promise<string> {
	const file = path.join(tmpDir, "notes.txt");
	await Bun.write(file, content);
	const session = createSession(tmpDir);
	const read = await new ReadTool(session).execute("r1", { path: file });
	const tag = tagFromOutput(resultText(read));
	const result = await executeHashlineSingle(execOptions(`[notes.txt#${tag}]\n${input}`, session));
	return resultText(result);
}

let tmpDir: string;

describe("edit response confirmations (issue #8603)", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-response-confirmations-"));
	});
	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	describe("renumber deltas", () => {
		it("reports a positive shift for a hunk that grows the file", async () => {
			const text = await editResponse("PUT 3-3:\n+A\n+B");
			expect(text).toContain("Renumber: lines >3 shifted +1");
			// A single hunk already says it all — no net line.
			expect(text).not.toContain("Renumber: net");
		});

		it("reports a negative shift for a hunk that shrinks the file", async () => {
			const text = await editResponse("PUT 4-6:\n+X");
			expect(text).toContain("Renumber: lines >6 shifted -2");
		});

		it("emits no renumber line for a zero-delta replacement", async () => {
			const text = await editResponse("PUT 5-5:\n+X");
			expect(text).not.toContain("Renumber:");
		});

		it("composes two hunks against original numbering and sums the net", async () => {
			const text = await editResponse("PUT 2-2:\n+A\n+B\nPUT 9-9:\n+Z\n+Y");
			// Both anchors are ORIGINAL line numbers; the net line frees the
			// model from summing them for a below-all-hunks edit.
			expect(text).toContain("Renumber: lines >2 shifted +1");
			expect(text).toContain("Renumber: lines >9 shifted +1");
			expect(text).toContain("Renumber: net +2");
		});

		it("omits the net line when interacting deltas cancel out", async () => {
			const text = await editResponse("PUT 2-2:\n+A\n+B\nPUT 9-10:\n+Z");
			expect(text).toContain("Renumber: lines >2 shifted +1");
			expect(text).toContain("Renumber: lines >10 shifted -1");
			expect(text).not.toContain("Renumber: net");
		});
	});

	describe("replaced-range boundary echoes", () => {
		it("echoes the first and last original line of a multi-line range", async () => {
			const text = await editResponse("PUT 3-5:\n+A\n+B\n+C");
			expect(text).toContain('PUT 3.=5: replaced "line 3"…"line 5"');
		});

		it("echoes a single-line range once", async () => {
			const text = await editResponse("PUT 4-4:\n+A");
			// Exact-line assertion: the two-side form would render
			// `PUT 4.=4: replaced "line 4"…"line 4"` and fail.
			expect(text.split("\n")).toContain('PUT 4.=4: replaced "line 4"');
		});

		it("truncates each echoed side to ~40 chars with an ellipsis", async () => {
			const long = `${"x".repeat(80)}-first`;
			const longLast = `${"y".repeat(80)}-last`;
			const content = ["short", long, "mid", longLast, "tail"].join("\n") + "\n";
			const text = await editResponse("PUT 2-4:\n+A\n+B\n+C", content);
			expect(text).toContain(`PUT 2.=4: replaced "${"x".repeat(39)}…"`);
			expect(text).toContain(`"${"y".repeat(39)}…"`);
			expect(text).not.toContain("x".repeat(40));
		});

		it("escapes quotes inside echoed content", async () => {
			const content = ['say "hi"', "plain", 'end "quote"'].join("\n") + "\n";
			const text = await editResponse("PUT 1-3:\n+A\n+B\n+C", content);
			expect(text).toContain('PUT 1.=3: replaced "say \\"hi\\""…"end \\"quote\\""');
		});

		it("does not split an escape pair or surrogate pair at the truncation boundary", async () => {
			// 38 a's + a quote: the 40-unit cut lands on the quote, which must
			// arrive escaped (not as a dangling backslash before the ellipsis).
			const content =
				[`${"a".repeat(38)}"${"b".repeat(25)}`, "mid", `${"x".repeat(36)}${"😀".repeat(5)}`].join("\n") + "\n";
			const text = await editResponse("PUT 1-3:\n+A\n+B\n+C", content);
			expect(text).toContain(`PUT 1.=3: replaced "${"a".repeat(38)}\\"…"`);
			// 36 x's + emoji: the cut must fall between emoji, never inside one.
			expect(text).toContain(`"${"x".repeat(36)}😀😀😀…"`);
		});
	});

	describe("op-kind coverage", () => {
		it("emits a renumber delta but no boundary echo for a CUT-only edit", async () => {
			const text = await editResponse("CUT 5-6");
			expect(text).toContain("Renumber: lines >6 shifted -2");
			expect(text).not.toContain("replaced");
		});

		it("emits neither for a pure insertion with no line-count context below", async () => {
			// Pure insert grows the file, so a renumber line appears; no range
			// was replaced, so no echo does.
			const text = await editResponse("PUT >2:\n+inserted");
			expect(text).toContain("Renumber: lines >2 shifted +1");
			expect(text).not.toContain("replaced");
		});

		it("skips the boundary echo for block ops (resolution echo covers them)", async () => {
			const ts = ["function f() {", "  return 1;", "}", "let done = true;"].join("\n") + "\n";
			const file = path.join(tmpDir, "block.ts");
			await Bun.write(file, ts);
			const session = createSession(tmpDir);
			const read = await new ReadTool(session).execute("r1", { path: file });
			const tag = tagFromOutput(resultText(read));
			const result = await executeHashlineSingle(
				execOptions(`[block.ts#${tag}]\nPUT 1*:\n+function g() {\n+  return 2;\n+}`, session),
			);
			const text = resultText(result);
			expect(text).toMatch(/PUT 1\*: → resolved/);
			expect(text).not.toContain("replaced");
			// Three lines replaced by three: zero net shift, no renumber line.
			expect(text).not.toContain("Renumber:");
			expect(await Bun.file(file).text()).toBe("function g() {\n  return 2;\n}\nlet done = true;\n");
		});
	});
});
