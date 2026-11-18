/**
 * The shell process worker: the bash tool's shell as a process of its own, on
 * pipes and as the shell of a pseudo-terminal. Real worker processes drive
 * these.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { PtySession } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { shellProcessCommand } from "../src/exec/shell-process";
import type { ShellProcessSpec } from "../src/exec/shell-process-protocol";
import { quotePosixArgv } from "../src/utils/shell-quote";

/** Run `spec` as a shell process on pipes, feeding it `stdin`. */
async function run(spec: ShellProcessSpec, stdin = ""): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const { application, args } = shellProcessCommand(spec);
	const child = Bun.spawn([application, ...args], { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

/** A shell process on a pseudo-terminal it leads. */
function onTerminal(
	command: string,
	cwd: string,
): {
	session: PtySession;
	/** What it printed so far. */
	output: () => string;
	/** Resolves once its output contains `marker`. */
	seen: (marker: string) => Promise<void>;
	done: Promise<number | undefined>;
} {
	const session = new PtySession();
	let output = "";
	const waiting: Array<{ marker: string; resolve: () => void }> = [];
	const done = session
		.startArgv(
			{ ...shellProcessCommand({ command }), cwd, timeoutMs: 60_000, env: { TERM: "xterm-256color" } },
			(_error, chunk) => {
				if (!chunk) return;
				output += chunk.replaceAll("\r\n", "\n");
				for (let at = waiting.length - 1; at >= 0; at--) {
					if (!output.includes(waiting[at].marker)) continue;
					waiting[at].resolve();
					waiting.splice(at, 1);
				}
			},
		)
		.then(result => result.exitCode);
	return {
		session,
		output: () => output,
		seen: marker => {
			if (output.includes(marker)) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiting.push({ marker, resolve });
			return promise;
		},
		done,
	};
}

describe("shell process on pipes", () => {
	it("runs omp's utilities and tools ahead of PATH on its own stdin, and exits with the command's status", async () => {
		using tempDir = TempDir.createSync("@omp-shell-process-");
		// No directory on the search path has any of them.
		const lookup = `PATH='${tempDir.path()}'`;

		const summed = await run({ command: `${lookup}; jq -c '.a | add'` }, '{"a":[40,2]}');
		const tools = await run({ command: `${lookup}; printf 'a\\nb\\n' | xargs echo; timeout 5 echo timed` });
		const failed = await run({ command: "echo before; exit 7; echo after" });

		expect(summed).toEqual({ stdout: "42\n", stderr: "", exitCode: 0 });
		expect(tools).toEqual({ stdout: "a b\ntimed\n", stderr: "", exitCode: 0 });
		expect(failed).toEqual({ stdout: "before\n", stderr: "", exitCode: 7 });
	}, 60_000);

	it.skipIf(process.platform === "win32")(
		"writes more than a pipe holds without losing a line",
		async () => {
			// A pipe a shell made, read slower than it is written: the writer has to wait for room.
			const { application, args } = shellProcessCommand({ command: "seq 1 200000" });
			const child = Bun.spawn(
				["/bin/sh", "-c", `${quotePosixArgv([application, ...args])} | { sleep 0.3; wc -l; }`],
				{
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);

			expect({ lines: stdout.trim(), stderr, exitCode }).toEqual({ lines: "200000", stderr: "", exitCode: 0 });
		},
		60_000,
	);

	it("finds URL paths missing once no session serves them, and refuses a malformed command line", async () => {
		using tempDir = TempDir.createSync("@omp-shell-process-gone-");
		const gone = { endpoint: path.join(tempDir.path(), "no-such.sock"), token: "revoked" };

		const orphan = await run({ command: "cat local://notes.md; echo status=$?", urls: gone });
		const { application, args } = shellProcessCommand({ command: "true" });
		const malformed = Bun.spawn([application, ...args.slice(0, -2), "true"], { stdout: "pipe", stderr: "pipe" });

		expect(orphan.stdout).toBe("status=1\n");
		expect(orphan.stderr).toContain("local://notes.md: No such file or directory");
		expect(await malformed.exited).toBe(2);
	}, 60_000);

	it.skipIf(process.platform === "win32")(
		"ends its command and exits 143 when terminated",
		async () => {
			const { application, args } = shellProcessCommand({
				command: "/bin/sh -c 'echo $$; exec sleep 60'; echo after",
			});
			const child = Bun.spawn([application, ...args], { stdout: "pipe", stderr: "pipe" });
			const reader = child.stdout.getReader();
			const decoder = new TextDecoder();
			// The program prints its pid once it runs.
			let printed = "";
			while (!printed.includes("\n")) {
				const { value, done } = await reader.read();
				if (done) break;
				printed += decoder.decode(value, { stream: true });
			}

			child.kill("SIGTERM");
			const exitCode = await child.exited;
			for (let read = await reader.read(); !read.done; read = await reader.read()) {
				printed += decoder.decode(read.value, { stream: true });
			}

			expect(exitCode).toBe(143);
			// Nothing after the program ran, and the program is gone with its shell.
			expect(printed).toMatch(/^\d+\n$/);
			expect(() => process.kill(Number(printed), 0)).toThrow();
		},
		60_000,
	);
});

describe.skipIf(process.platform === "win32")("shell process on a pseudo-terminal", () => {
	it("is the terminal's shell: its programs see a terminal and reach it through /dev/tty", async () => {
		using tempDir = TempDir.createSync("@omp-shell-process-tty-");
		const shell = onTerminal(
			`[ -t 0 ] && [ -t 1 ] && echo stdio-tty; /bin/sh -c 'echo via-dev-tty > /dev/tty'; exit 3`,
			tempDir.path(),
		);

		expect(await shell.done).toBe(3);
		expect(shell.output()).toBe("stdio-tty\nvia-dev-tty\n");
	}, 60_000);

	it("stops at an interrupt that kills its foreground program", async () => {
		using tempDir = TempDir.createSync("@omp-shell-process-int-");
		const shell = onTerminal("echo started; sleep 60; echo after", tempDir.path());
		await shell.seen("started");

		shell.session.write("\x03");

		expect(await shell.done).toBe(130);
		expect(shell.output()).not.toContain("after");
	}, 60_000);

	it("goes on after an interrupt its foreground program handles", async () => {
		using tempDir = TempDir.createSync("@omp-shell-process-trap-");
		// The program takes the interrupt itself, as a REPL or an editor does, and outlives by
		// its own clock the moment a killed program would have ended the command.
		const handler = `/bin/sh -c 'trap "echo caught; got=1" INT; echo ready; while [ -z "$got" ]; do sleep 0.05; done; sleep 0.6; echo finished'`;
		const shell = onTerminal(`${handler}; echo after`, tempDir.path());
		await shell.seen("ready");

		shell.session.write("\x03");

		expect(await shell.done).toBe(0);
		expect(shell.output()).toContain("caught\nfinished\nafter\n");
	}, 60_000);
});
