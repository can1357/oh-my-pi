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
	const frames: RunnerFrame[] = [];

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
		proc.stdin.write(encoder.encode(`${JSON.stringify({ id: "r1", code })}\n`));
		proc.stdin.flush();
		while (true) {
			const frame = await readFrame();
			frames.push(frame);
			if (frame.type === "done") break;
		}
		proc.stdin.write(encoder.encode(`${JSON.stringify({ type: "exit" })}\n`));
		proc.stdin.end();
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new Error(`Python runner exited ${exitCode}: ${await stderr}`);
		}
		return frames;
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
		expect(stdout.join("")).toBe("firstsecond");
	});
});
