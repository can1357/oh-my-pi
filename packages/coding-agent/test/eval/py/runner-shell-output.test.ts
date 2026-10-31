import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";

interface RunnerFrame {
	type?: string;
	id?: string;
	data?: string;
	status?: string;
}

const pythonPath = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");
const runnerPath = path.resolve(import.meta.dir, "../../../src/eval/py/runner.py");
const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const encoder = new TextEncoder();

function shellQuote(value: string): string {
	// `!cmd` runs through cmd.exe on Windows (shell=True) and a POSIX shell
	// elsewhere; quote for the shell that will actually parse the command.
	if (process.platform === "win32") {
		return `"${value.replaceAll('"', '""')}"`;
	}
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function runCell(code: string): Promise<RunnerFrame[]> {
	const [frames] = await runCells([code]);
	return frames;
}

/** Runs each cell on one runner, sending the next request only after the previous cell's done frame. */
async function runCells(codes: string[]): Promise<RunnerFrame[][]> {
	const proc = Bun.spawn([pythonPath, "-u", runnerPath], {
		cwd: repoRoot,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			PYTHONUNBUFFERED: "1",
			PYTHONIOENCODING: "utf-8",
		},
	});
	const stderr = new Response(proc.stderr).text();
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let pending = "";

	async function readFrame(): Promise<RunnerFrame> {
		while (true) {
			const newline = pending.indexOf("\n");
			if (newline >= 0) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				const frame = JSON.parse(line) as RunnerFrame;
				// Child processes write \r\n on Windows.
				if (typeof frame.data === "string") frame.data = frame.data.replaceAll("\r\n", "\n");
				return frame;
			}
			const { value, done } = await reader.read();
			if (done) {
				throw new Error(`Python runner exited before done frame: ${await stderr}`);
			}
			pending += decoder.decode(value, { stream: true });
		}
	}

	try {
		const results: RunnerFrame[][] = [];
		for (const [index, code] of codes.entries()) {
			proc.stdin.write(encoder.encode(`${JSON.stringify({ id: `r${index + 1}`, code })}\n`));
			proc.stdin.flush();
			const frames: RunnerFrame[] = [];
			while (true) {
				const frame = await readFrame();
				frames.push(frame);
				if (frame.type === "done") break;
			}
			results.push(frames);
		}
		proc.stdin.write(encoder.encode(`${JSON.stringify({ type: "exit" })}\n`));
		proc.stdin.end();
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new Error(`Python runner exited ${exitCode}: ${await stderr}`);
		}
		return results;
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Reader may already be released by stream closure.
		}
		try {
			proc.kill("SIGKILL");
		} catch {
			// Process already exited.
		}
	}
}

describe("Python runner shell output streaming", () => {
	for (const [name, lineEnding] of [
		["CRLF", "\r\n"],
		["bare CR", "\r"],
	] as const) {
		it(`normalizes ${name} line endings in quoted Python values and Bash cell magics`, async () => {
			const frames = await runCell(
				[
					"text = '''first",
					"!literal",
					"%literal",
					"last'''",
					"print(repr(text))",
					"%%bash",
					"set -e",
					"printf done",
					"",
				].join(lineEnding),
			);
			expect(frames.find(frame => frame.type === "done")?.status).toBe("ok");
			expect(
				frames
					.filter(frame => frame.type === "stdout")
					.map(frame => frame.data)
					.join(""),
			).toBe("'first\\n!literal\\n%literal\\nlast'\ndone");
		});
	}

	it("preserves modulo operators in continued Python expressions before real magics", async () => {
		const frames = await runCell(
			[
				"import os",
				"parenthesized = (",
				"    17",
				"    % 5",
				")",
				"continued = 17 \\",
				"    % 5",
				"%env OMP_CONTINUED_PROBE=preserved",
				"print(parenthesized, continued, os.environ['OMP_CONTINUED_PROBE'])",
			].join("\n"),
		);
		expect(frames.find(frame => frame.type === "done")?.status).toBe("ok");
		expect(
			frames
				.filter(frame => frame.type === "stdout")
				.map(frame => frame.data)
				.join(""),
		).toBe("2 2 preserved\n");
	});

	it("preserves non-newline separators inside quoted Python values", async () => {
		const contents = "before\v!literal\f%pwd\u0085after\u2028last";
		const frames = await runCell(`text = '''${contents}'''\nprint(text.encode('utf-8').hex())`);
		expect(frames.find(frame => frame.type === "done")?.status).toBe("ok");
		expect(
			frames
				.filter(frame => frame.type === "stdout")
				.map(frame => frame.data)
				.join(""),
		).toBe(`${Buffer.from(contents).toString("hex")}\n`);
	});

	it("preserves magic-looking lines in Python strings alongside real magics", async () => {
		const contents = "first\n!literal\n%pwd\n%%bash\nvalue = !literal\nlast";
		const frames = await runCell(
			[
				"%env OMP_STRING_PROBE=before",
				`text = r'''${contents}'''`,
				'formatted = f"""{2 + 3}\n!literal\n%%bash"""',
				"%env OMP_STRING_PROBE=after",
				"print(text, end='')",
				"print(formatted, end='')",
			].join("\n"),
		);
		expect(frames.find(frame => frame.type === "done")?.status).toBe("ok");
		expect(
			frames
				.filter(frame => frame.type === "stdout")
				.map(frame => frame.data)
				.join(""),
		).toBe(`${contents}5\n!literal\n%%bash`);
	});

	it("streams !cmd output chunks before the child process exits", async () => {
		const child = [
			"import sys,time",
			"sys.stdout.write('first\\n')",
			"sys.stdout.flush()",
			"time.sleep(0.2)",
			"sys.stdout.write('second\\n')",
			"sys.stdout.flush()",
		].join(";");
		const frames = await runCell(
			[
				`result = !${pythonPath} -c ${shellQuote(child)}`,
				"print('return=' + str(result.returncode) + ' lines=' + repr(list(result)))",
			].join("\n"),
		);
		const stdout = frames.filter(frame => frame.type === "stdout").map(frame => frame.data);

		expect(stdout[0]).toBe("first\n");
		expect(stdout.join("")).toContain("second\n");
		expect(stdout.join("")).toContain("return=0 lines=['first', 'second']");
	});

	it("caps !cmd output and captured result by line count with a truncation notice", async () => {
		const child = ["import sys", "sys.stdout.write(('x' + chr(10)) * 3100)", "sys.stdout.flush()"].join(";");
		const frames = await runCell(
			[
				`result = !${pythonPath} -c ${shellQuote(child)}`,
				"print('captured=' + str(len(result)) + ' return=' + str(result.returncode))",
			].join("\n"),
		);
		const stdout = frames
			.filter(frame => frame.type === "stdout")
			.map(frame => frame.data)
			.join("");

		expect(stdout).toContain("[output truncated: shell helper exceeded");
		expect(stdout).toContain("captured=3000 return=0");
		expect(stdout).not.toContain("captured=3100");
	});

	it("caps newline-free !cmd output by bytes with a truncation notice", async () => {
		const child = ["import sys", "sys.stdout.write('z' * (1024 * 1024 + 17))", "sys.stdout.flush()"].join(";");
		const frames = await runCell(
			[
				`result = !${pythonPath} -c ${shellQuote(child)}`,
				"print('capturedChars=' + str(len(result.n)) + ' return=' + str(result.returncode))",
			].join("\n"),
		);
		const stdout = frames
			.filter(frame => frame.type === "stdout")
			.map(frame => frame.data)
			.join("");

		expect(stdout).toContain("[output truncated: shell helper exceeded");
		expect(stdout).toContain("capturedChars=1048576 return=0");
		expect(stdout).not.toContain("capturedChars=1048593");
	});

	it("isolates !cmd children from the runner's stdin control channel", async () => {
		// The runner's stdin carries the host's NDJSON frames. A child that
		// inherits it can steal frames or block forever waiting for input;
		// with stdin=DEVNULL a stdin-reading child sees immediate EOF instead.
		const child = ["import sys", "data = sys.stdin.read()", "print('read=' + repr(data))"].join(";");
		const frames = await runCell(
			[
				`result = !${pythonPath} -c ${shellQuote(child)}`,
				"print('return=' + str(result.returncode) + ' lines=' + repr(list(result)))",
			].join("\n"),
		);
		const stdout = frames
			.filter(frame => frame.type === "stdout")
			.map(frame => frame.data)
			.join("");

		expect(stdout).toContain("read=''");
		expect(stdout).toContain("return=0");
	});

	it("gives processes started by plain user code EOF on stdin instead of the control channel", async () => {
		// Without an explicit stdin, a child inherits the runner's fd 0. That
		// must not be the host's control pipe, which stays open for the
		// kernel's whole life: a stdin-reading child (e.g. `omp -p`) would block
		// until the timeout below, or steal frames meant for the runner.
		const child = "import sys; print('read=' + repr(sys.stdin.read()))";
		const [first, second] = await runCells([
			[
				"import subprocess, sys",
				`proc = subprocess.run([sys.executable, "-c", ${JSON.stringify(child)}], capture_output=True, text=True, timeout=10)`,
				"print(proc.stdout, end='')",
			].join("\n"),
			"print('second request served')",
		]);

		expect(first.filter(frame => frame.type === "stdout").map(frame => frame.data)).toEqual(["read=''\n"]);
		expect(first.at(-1)?.status).toBe("ok");
		expect(second.filter(frame => frame.type === "stdout").map(frame => frame.data)).toEqual([
			"second request served\n",
		]);
		expect(second.at(-1)?.status).toBe("ok");
	}, 30_000);

	it("streams newline-free %%bash output without waiting for EOF", async () => {
		const child = [
			"import sys,time",
			"sys.stdout.write('first')",
			"sys.stdout.flush()",
			"time.sleep(0.2)",
			"sys.stdout.write('second')",
			"sys.stdout.flush()",
		].join(";");
		const frames = await runCell(`%%bash\n${pythonPath} -c ${shellQuote(child)}`);
		const stdout = frames.filter(frame => frame.type === "stdout").map(frame => frame.data);

		expect(stdout[0]).toBe("first");
		// The cell's trailing value (the magic's exit status) is echoed to stdout after the stream.
		expect(stdout.join("")).toStartWith("firstsecond");
	});
});
