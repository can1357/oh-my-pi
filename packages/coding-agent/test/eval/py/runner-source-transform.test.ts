import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";

const pythonPath = Bun.env.PYTHON ?? $which("python3") ?? $which("python");
const runnerPath = path.resolve(import.meta.dir, "../../../src/eval/py/runner.py");

interface RunnerFrame {
	type: string;
	id?: string;
	data?: string;
	status?: string;
	evalue?: string;
}

async function executeCell(code: string): Promise<RunnerFrame[]> {
	if (!pythonPath) throw new Error("Python is required for the runner regression");
	const proc = Bun.spawn([pythonPath, "-u", runnerPath], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
	});
	const stderr = new Response(proc.stderr).text();
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	const frames: RunnerFrame[] = [];
	let pending = "";
	try {
		proc.stdin.write(`${JSON.stringify({ id: "probe", code })}\n`);
		proc.stdin.flush();
		while (true) {
			const newline = pending.indexOf("\n");
			if (newline >= 0) {
				const frame = JSON.parse(pending.slice(0, newline)) as RunnerFrame;
				pending = pending.slice(newline + 1);
				frames.push(frame);
				if (frame.type === "done" && frame.id === "probe") return frames;
				continue;
			}
			const { value, done } = await reader.read();
			if (done) throw new Error(`Runner exited before completing the cell: ${await stderr}`);
			pending += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
		proc.kill();
		await proc.exited;
	}
}

function expectSuccess(frames: RunnerFrame[], marker: string): void {
	expect(frames.filter(frame => frame.type === "error")).toEqual([]);
	expect(frames.find(frame => frame.type === "done")?.status).toBe("ok");
	expect(
		frames
			.filter(frame => frame.type === "stdout")
			.map(frame => frame.data ?? "")
			.join(""),
	).toContain(marker);
}

describe.skipIf(!pythonPath)("Python runner quoted-source transformation", () => {
	it("preserves raw triple-quoted generated source and magic-looking literal lines", async () => {
		const payload = [
			"bool malformedRejected=!SlopArena.IsValid();",
			"IsGrounded = !air,",
			"!literal-not-a-command",
			"%pwd",
			"%%bash",
			"value = %pwd",
		].join("\n");
		const code = [
			`source = r"""${payload}"""`,
			`assert source == ${JSON.stringify(payload)}`,
			'print("literal-source-preserved")',
		].join("\n");
		expectSuccess(await executeCell(code), "literal-source-preserved");
	});

	it("preserves generated source when a closing string delimiter is followed by a call token", async () => {
		const code = [
			"import io",
			"output = io.StringIO()",
			'output.write("""',
			"bool ok;",
			'ok = !done;""")',
			'assert output.getvalue() == "\\nbool ok;\\nok = !done;"',
			'print("closing-delimiter-source-preserved")',
		].join("\n");
		expectSuccess(await executeCell(code), "closing-delimiter-source-preserved");
	});

	it("handles triple-single quotes, comments, and escaped physical-line continuations", async () => {
		const payload = '\n# quote-looking comment: """\nIsGrounded = !air,\n%pwd\n';
		const code = [
			'# A comment containing a delimiter must not open a string: """',
			`source = '''${payload}'''`,
			`assert source == ${JSON.stringify(payload)}`,
			'single = "first\\',
			'!second"',
			'assert single == "first!second"',
			'print("escaped-source-preserved")',
		].join("\n");
		expectSuccess(await executeCell(code), "escaped-source-preserved");
	});

	it("preserves multiline f-string contents while evaluating interpolations", async () => {
		const code = [
			"value = 7",
			'source = f"""first {value}',
			"IsGrounded = !air,",
			"%pwd",
			'"""',
			'assert source == "first 7\\nIsGrounded = !air,\\n%pwd\\n"',
			'print("fstring-source-preserved")',
		].join("\n");
		expectSuccess(await executeCell(code), "fstring-source-preserved");
	});

	it("keeps real shell, assignment, continuation, and cell magics active after quoted payloads", async () => {
		const code = [
			"import os",
			'source = """%pwd',
			"!literal",
			'"""',
			'assert source == "%pwd\\n!literal\\n"',
			"cwd = %pwd",
			"assert cwd == os.getcwd()",
			'!echo "quoted shell"',
			"out = !echo assignment-shell",
			'assert out == ["assignment-shell"]',
			"!echo continued-\\",
			"shell",
			"if True:",
			"    if True:",
			"        %pwd",
			"        !echo indented-shell",
			'    source = """%pwd',
			"!still-literal",
			'"""',
			'    assert source == "%pwd\\n!still-literal\\n"',
			"    %pwd",
			'print("real-magics-active")',
			"%%bash",
			"printf cell-magic-active",
		].join("\n");
		const frames = await executeCell(code);
		expectSuccess(frames, "real-magics-active");
		const output = frames
			.filter(frame => frame.type === "stdout")
			.map(frame => frame.data ?? "")
			.join("");
		expect(output).toContain("quoted shell");
		expect(output).toContain("continued-shell");
		expect(output).toContain("indented-shell");
		expect(output).toContain("cell-magic-active");
	});

	it("does not let quote-like shell payloads hide later Python strings or magics", async () => {
		const code = [
			"!echo \"'''\"",
			'source = """IsGrounded = !air,',
			"%pwd",
			'"""',
			'assert source == "IsGrounded = !air,\\n%pwd\\n"',
			"out = !echo later-shell",
			'assert out == ["later-shell"]',
			'print("shell-quotes-isolated")',
		].join("\n");
		expectSuccess(await executeCell(code), "shell-quotes-isolated");
	});

	it("reports unterminated quoted source without executing its apparent shell commands", async () => {
		const frames = await executeCell('source = """\n!echo must-not-run\n');
		expect(frames.find(frame => frame.type === "done")?.status).toBe("error");
		// Python < 3.10 reports "EOF while scanning triple-quoted string literal".
		const unterminated = /unterminated|EOF while scanning/;
		expect(frames.some(frame => frame.type === "error" && unterminated.test(frame.evalue ?? ""))).toBe(true);
		expect(frames.filter(frame => frame.type === "stdout")).toEqual([]);
	});
});
