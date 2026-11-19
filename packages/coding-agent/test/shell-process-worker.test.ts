/**
 * The shell process worker: the bash tool's shell as a process of its own, on
 * pipes and as the shell of a pseudo-terminal. Real worker processes drive
 * these.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PtySession } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { shellMounts, shellProcessCommand } from "../src/exec/shell-process";
import type { ShellProcessSpec } from "../src/exec/shell-process-protocol";
import type { Skill } from "../src/extensibility/skills";
import type { ToolSession } from "../src/tools";
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

/**
 * Run `command` as a shell process on pipes, send it `signal` once it printed
 * a first line, and collect everything it printed until its output closed.
 */
async function terminate(command: string, signal: NodeJS.Signals): Promise<{ exitCode: number; printed: string }> {
	const { application, args } = shellProcessCommand({ command });
	const child = Bun.spawn([application, ...args], { stdout: "pipe", stderr: "pipe" });
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let printed = "";
	while (!printed.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) break;
		printed += decoder.decode(value, { stream: true });
	}

	child.kill(signal);
	const exitCode = await child.exited;
	for (let read = await reader.read(); !read.done; read = await reader.read()) {
		printed += decoder.decode(read.value, { stream: true });
	}
	return { exitCode, printed };
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

	it("refuses a malformed command line", async () => {
		const { application, args } = shellProcessCommand({ command: "true" });
		const malformed = Bun.spawn([application, ...args.slice(0, -2), "true"], { stdout: "pipe", stderr: "pipe" });

		expect(await malformed.exited).toBe(2);
	}, 60_000);

	it.skipIf(process.platform === "win32")(
		"ends its command and exits 143 when terminated",
		async () => {
			// The program prints its pid once it runs.
			const { exitCode, printed } = await terminate("/bin/sh -c 'echo $$; exec sleep 60'; echo after", "SIGTERM");

			expect(exitCode).toBe(143);
			// Nothing after the program ran, and the program is gone with its shell.
			expect(printed).toMatch(/^\d+\n$/);
			expect(() => process.kill(Number(printed), 0)).toThrow();
		},
		60_000,
	);

	it.skipIf(process.platform === "win32").each([
		["SIGTERM", 143],
		["SIGHUP", 129],
	] as const)(
		"stays on %s until its command's TERM trap ran to the end, then exits %d",
		async (signal, status) => {
			// The trap takes far longer than a process that exits on the signal
			// itself, without waiting for the cancel to end its command.
			const { exitCode, printed } = await terminate(
				"trap 'sleep 0.3; echo trapped' TERM; echo started; sleep 60; echo after",
				signal,
			);

			expect({ exitCode, printed }).toEqual({ exitCode: status, printed: "started\ntrapped\n" });
		},
		60_000,
	);
});

describe.skipIf(process.platform === "win32")("shell process URL paths", () => {
	const skillAt = (name: string, dir: string): Skill => ({
		name,
		description: name,
		filePath: path.join(dir, "SKILL.md"),
		baseDir: dir,
		source: "test",
	});

	/** The script `shellMounts` writes for a session with `artifacts` as its directory, saved under `root`. */
	async function mountScript(root: string, artifacts: string, skills: Skill[]): Promise<string> {
		const session = {
			getImageAttachments: () => [{ uri: "attachment://1", sourcePath: path.join(artifacts, "image.png") }],
		} as unknown as ToolSession;
		const script = await shellMounts(
			{ localProtocolOptions: { getArtifactsDir: () => artifacts, getSessionId: () => "session" }, skills, session },
			"exec",
		);
		const source = path.join(root, `mounts-${skills.length}.sh`);
		await fs.writeFile(source, script);
		return source;
	}

	/** Host files behind every scheme a shell process can open, and the script mounting them. */
	async function fixture(root: string): Promise<{ source: string; local: string; skill: string }> {
		const artifacts = path.join(root, "session");
		const local = path.join(artifacts, "local");
		const skill = path.join(root, "skills", "review it");
		const plugin = path.join(root, "plugins", "lint");
		await Promise.all([
			fs.mkdir(path.join(local, "sub"), { recursive: true }),
			fs.mkdir(path.join(skill, "scripts"), { recursive: true }),
			fs.mkdir(plugin, { recursive: true }),
		]);
		await Promise.all([
			fs.writeFile(path.join(local, "x.txt"), "local-x\n"),
			// Beside the local root: what a `..` out of it would reach.
			fs.writeFile(path.join(artifacts, "x.txt"), "outside\n"),
			fs.writeFile(path.join(artifacts, "image.png"), "png-bytes"),
			fs.writeFile(path.join(skill, "SKILL.md"), "# Review\n"),
			fs.writeFile(path.join(skill, "scripts", "a.sh"), '#!/bin/sh\necho "ran-script $1"\n', { mode: 0o755 }),
			fs.writeFile(path.join(plugin, "SKILL.md"), "# Lint\n"),
			fs.writeFile(path.join(plugin, "rules.txt"), "no-tabs\n"),
		]);
		const source = await mountScript(root, artifacts, [skillAt("review", skill), skillAt("plugin/lint", plugin)]);
		return { source, local, skill };
	}

	it("reads, lists and writes local:// in its root, which exists even before anything was written", async () => {
		using tempDir = TempDir.createSync("@omp-shell-process-local-");
		const root = await fs.realpath(tempDir.path());
		const { source, local } = await fixture(root);
		const fresh = path.join(root, "fresh-session");

		const used = await run({
			command: "cat local://x.txt; ls local://; echo new > local://sub/out.txt; cat local://sub/./out.txt",
			source,
		});
		const entered = await run({ command: "echo here > made.txt", source, cwd: "local://sub" });
		const created = await run({ command: "ls local://; echo status=$?", source: await mountScript(root, fresh, []) });

		expect(used).toEqual({ stdout: "local-x\nsub\nx.txt\nnew\n", stderr: "", exitCode: 0 });
		expect(await fs.readFile(path.join(local, "sub", "out.txt"), "utf-8")).toBe("new\n");
		expect(entered.exitCode).toBe(0);
		expect(await fs.readFile(path.join(local, "sub", "made.txt"), "utf-8")).toBe("here\n");
		expect(created.stdout).toBe("status=0\n");
	}, 60_000);

	it("reads a skill's instructions at its bare name and runs the files beside them", async () => {
		using tempDir = TempDir.createSync("@omp-shell-process-skill-");
		const { source } = await fixture(await fs.realpath(tempDir.path()));

		const skill = await run({
			command:
				"cat skill://review; skill://review/scripts/a.sh direct; /bin/sh skill://review/scripts/a.sh by-sh; cat skill://plugin/lint skill://plugin/lint/rules.txt",
			source,
		});

		expect(skill).toEqual({
			stdout: "# Review\nran-script direct\nran-script by-sh\n# Lint\nno-tabs\n",
			stderr: "",
			exitCode: 0,
		});
	}, 60_000);

	it("refuses every write to skill:// and a read-only local://", async () => {
		using tempDir = TempDir.createSync("@omp-shell-process-ro-");
		const root = await fs.realpath(tempDir.path());
		const { source, local, skill } = await fixture(root);
		// What `shellMounts` writes for a command approved below the tier `local://` writes need.
		const readOnlySource = path.join(root, "read-only.sh");
		await fs.writeFile(
			readOnlySource,
			(await fs.readFile(source, "utf-8")).replace("urlmap 'local://'", "urlmap -r 'local://'"),
		);

		const immutable = await run({
			command:
				"echo x > skill://review/SKILL.md; echo write=$?; rm skill://review/scripts/a.sh; echo rm=$?; mv local://x.txt skill://review/x.txt; echo mv=$?",
			source,
		});
		const readOnly = await run({
			command: "echo x > local://new.txt; echo write=$?; cat local://x.txt",
			source: readOnlySource,
		});

		expect(immutable.stdout).toBe("write=1\nrm=1\nmv=1\n");
		// Each of the three names the refusal: a move across filesystems falls back to a copy, refused too.
		expect(immutable.stderr.match(/Read-only file system/g)?.length).toBe(3);
		expect(await fs.readFile(path.join(skill, "SKILL.md"), "utf-8")).toBe("# Review\n");
		expect(await fs.readFile(path.join(skill, "scripts", "a.sh"), "utf-8")).toContain("ran-script");
		expect(await fs.readFile(path.join(local, "x.txt"), "utf-8")).toBe("local-x\n");
		expect(readOnly.stdout).toBe("write=1\nlocal-x\n");
		expect(readOnly.stderr).toContain("Read-only file system");
		expect(await fs.exists(path.join(local, "new.txt"))).toBe(false);
	}, 60_000);

	it("reads a spill through the local:// mount and attachment://N from its image file", async () => {
		using tempDir = TempDir.createSync("@omp-shell-process-spill-");
		const { source, local } = await fixture(await fs.realpath(tempDir.path()));
		// Written after the mount script: spills land in the mounted root, not per-id mounts.
		await fs.writeFile(path.join(local, "7.log"), "spill-seven\n");

		const found = await run({ command: "cat local://7.log; cat attachment://1", source });
		const missing = await run({ command: "cat local://8.log; echo status=$?", source });

		expect(found).toEqual({ stdout: "spill-seven\npng-bytes", stderr: "", exitCode: 0 });
		expect(missing.stdout).toBe("status=1\n");
		expect(missing.stderr).toContain("local://8.log: No such file or directory");
	}, 60_000);

	it("finds nothing above a scheme's root and nothing under a scheme it has no files for", async () => {
		using tempDir = TempDir.createSync("@omp-shell-process-escape-");
		const { source } = await fixture(await fs.realpath(tempDir.path()));

		const escaped = await run({
			command:
				"cat local://../x.txt; echo up=$?; cat local://sub/../../x.txt; echo deep=$?; cat local://%2e%2e/x.txt; echo encoded=$?",
			source,
		});
		const unmapped = await run({ command: "cat memory://x; echo memory=$?; ls skill://; echo root=$?", source });

		expect(escaped.stdout).toBe("up=1\ndeep=1\nencoded=1\n");
		expect(escaped.stderr).not.toContain("outside");
		expect(unmapped.stdout).toBe("memory=1\nroot=2\n");
		expect(unmapped.stderr).toContain("memory://x: No such file or directory");
	}, 60_000);

	it("hands an external program the host file behind a URL, and any other URL as written", async () => {
		using tempDir = TempDir.createSync("@omp-shell-process-external-");
		const { source, local, skill } = await fixture(await fs.realpath(tempDir.path()));

		const external = await run({
			command: `/bin/cat local://x.txt; /bin/sh -c 'printf "%s\\n" "$@"' sh local://x.txt skill://review https://example.com/a memory://x`,
			source,
		});

		expect(external).toEqual({
			stdout: `local-x\n${path.join(local, "x.txt")}\n${path.join(skill, "SKILL.md")}\nhttps://example.com/a\nmemory://x\n`,
			stderr: "",
			exitCode: 0,
		});
	}, 60_000);

	it("runs its command without mounts when the script it was started with is gone", async () => {
		using tempDir = TempDir.createSync("@omp-shell-process-gone-");
		const { source } = await fixture(await fs.realpath(tempDir.path()));
		await fs.rm(source);

		const relaunched = await run({ command: "cat local://x.txt; echo status=$?; echo ran", source });

		expect(relaunched.stdout).toBe("status=1\nran\n");
		expect(relaunched.exitCode).toBe(0);
	}, 60_000);

	it("keeps its command line short however many skills the session has", async () => {
		using tempDir = TempDir.createSync("@omp-shell-process-many-");
		const root = await fs.realpath(tempDir.path());
		const last = path.join(root, "skills", "skill-1999");
		await fs.mkdir(last, { recursive: true });
		await fs.writeFile(path.join(last, "SKILL.md"), "# Last of two thousand\n");
		const skills = Array.from({ length: 2000 }, (_, index) =>
			skillAt(`skill-${index}`, path.join(root, "skills", `skill-${index}`)),
		);
		const source = await mountScript(root, path.join(root, "session"), skills);
		const spec = { command: "cat skill://skill-1999; urlmap | wc -l", source };

		const { args } = shellProcessCommand(spec);
		const result = await run(spec);

		// The mounts alone are past what one Windows command line holds (about 32K characters).
		expect((await fs.stat(source)).size).toBeGreaterThan(64_000);
		expect(args.join(" ").length).toBeLessThan(2000);
		expect(result.stdout.replace(/ +/g, "")).toBe("#Lastoftwothousand\n4002\n");
		expect(result.exitCode).toBe(0);
	}, 60_000);
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
