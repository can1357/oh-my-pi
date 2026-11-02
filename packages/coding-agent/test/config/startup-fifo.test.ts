import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
// A namespace import, not named imports: this file must still load against code
// that has no such constants, which is how it is run against `main` to show
// each case fails there.
import * as envBounds from "@oh-my-pi/pi-utils/env";
import { readFile as readDiscoveryFile } from "../../src/capability/fs";
import {
	type FifoCase,
	fifoWithInput,
	itRefusesFifo,
	mkfifo,
	mod,
	namedAsFifo,
	notesAbout,
	PAYLOAD,
	runChild,
	startChild,
	TEST_TIMEOUT_MS,
	useFifoSandbox,
	writerWaitingInOpen,
} from "./fifo-harness";

// Every file a user or another process can place that omp reads before a
// command does its own work: the `.env` and `config.yml` files every command
// reads, and the files a session reads when it starts. See `fifo-harness.ts`
// for how each case runs.
const box = useFifoSandbox("@omp-startup-fifo-");

afterEach(() => {
	vi.restoreAllMocks();
});

const watchdogMd = (): string =>
	`import { discoverWatchdogFiles } from ${mod("coding-agent", "advisor/watchdog.ts")};
	await discoverWatchdogFiles(${JSON.stringify(box.projectDir)}, ${JSON.stringify(box.agentDir)});`;

const watchdogYml = (): string =>
	`import { discoverAdvisorConfigs } from ${mod("coding-agent", "advisor/config.ts")};
	await discoverAdvisorConfigs(${JSON.stringify(box.projectDir)}, ${JSON.stringify(box.agentDir)});`;

const settingsInit = (): string =>
	`import { Settings } from ${mod("coding-agent", "config/settings.ts")};
	await Settings.init({ cwd: ${JSON.stringify(box.projectDir)}, agentDir: ${JSON.stringify(box.agentDir)} });`;

const pluginOverrides = (): string =>
	`import { getEnabledPlugins } from ${mod("coding-agent", "extensibility/plugins/loader.ts")};
	await getEnabledPlugins(${JSON.stringify(box.projectDir)});`;

const skillshare = (): string =>
	`import { loadSkillshareSkills } from ${mod("coding-agent", "discovery/skillshare.ts")};
	await loadSkillshareSkills({ cwd: ${JSON.stringify(box.projectDir)}, home: ${JSON.stringify(box.home)}, repoRoot: null });`;

// Files a FIFO at which is refused by kind: no tool serves any of them through
// a pipe on purpose. `.env`, which 1Password does serve that way, is below.
const cases: FifoCase[] = [
	// Read by every command, before it does anything else.
	{
		name: "~/.omp/agent/config.yml",
		at: () => path.join(box.agentDir, "config.yml"),
		script: settingsInit,
		outcome: "refused",
	},
	{
		name: "<project>/.omp/config.yml",
		at: () => path.join(box.projectDir, ".omp", "config.yml"),
		script: settingsInit,
		outcome: "refused",
	},
	// Read when a session starts.
	{
		name: "~/.omp/agent/models.yml",
		at: () => path.join(box.agentDir, "models.yml"),
		script: () =>
			`import { ModelsConfigFile } from ${mod("coding-agent", "config/models-config.ts")};
			const loaded = ModelsConfigFile.tryLoad();
			console.log(loaded.status, String(loaded.error));`,
		outcome: "reported",
	},
	{
		name: "~/.omp/agent/mcp.json",
		at: () => path.join(box.agentDir, "mcp.json"),
		script: () =>
			`import { loadAllMCPConfigs } from ${mod("coding-agent", "mcp/config.ts")};
			await loadAllMCPConfigs(${JSON.stringify(box.projectDir)});`,
		outcome: "skipped",
	},
	...([".omp", ".claude", ".codex", ".gemini"] as const).map((dir): FifoCase => ({
		name: `<project>/${dir}/plugin-overrides.json`,
		at: () => path.join(box.projectDir, dir, "plugin-overrides.json"),
		script: pluginOverrides,
		outcome: "skipped",
	})),
	...(["WATCHDOG.md", "WATCHDOG.yml", "WATCHDOG.yaml"] as const).flatMap(file =>
		(["~/.omp/agent", "<project>/.omp", "<project>"] as const).map((dir): FifoCase => ({
			name: `${dir}/${file}`,
			at: () =>
				path.join(
					{
						"~/.omp/agent": box.agentDir,
						"<project>/.omp": path.join(box.projectDir, ".omp"),
						"<project>": box.projectDir,
					}[dir],
					file,
				),
			script: file === "WATCHDOG.md" ? watchdogMd : watchdogYml,
			outcome: "skipped",
		})),
	),
	{
		name: "~/.omp/agent/skills.lock.json",
		at: () => path.join(box.agentDir, "skills.lock.json"),
		script: skillshare,
		outcome: "skipped",
	},
	{
		name: "<project>/.omp/skills.lock.json",
		at: () => path.join(box.projectDir, ".omp", "skills.lock.json"),
		script: skillshare,
		outcome: "skipped",
	},
	{
		// The model registry's synchronous check for an AWS profile, at every session start.
		name: "~/.aws/credentials",
		at: () => path.join(box.home, ".aws", "credentials"),
		script: () =>
			`import { hasConfiguredAwsProfile } from ${mod("ai", "utils/aws-profile.ts")};
			hasConfiguredAwsProfile();`,
		outcome: "skipped",
	},
	{
		// The same file, read again when a Bedrock request resolves its credentials.
		name: "~/.aws/credentials, when a request resolves credentials",
		at: () => path.join(box.home, ".aws", "credentials"),
		script: () =>
			`import { resolveAwsCredentials } from ${mod("ai", "providers/aws-credentials.ts")};
			import { AwsCredentialsError } from ${mod("ai", "error/index.ts")};
			try {
				await resolveAwsCredentials({ region: "us-east-1" });
			} catch (error) {
				// No credentials anywhere is this call's own answer, as with no file at all.
				if (!(error instanceof AwsCredentialsError)) throw error;
			}`,
		outcome: "skipped",
	},
	{
		name: "~/.idapro/ida-config.json",
		at: () => path.join(box.home, ".idapro", "ida-config.json"),
		script: () =>
			`import { locateIdaInstall } from ${mod("coding-agent", "ida/install.ts")};
			locateIdaInstall(undefined);`,
		outcome: "skipped",
	},
	{
		name: "~/.omp/agent/PERSONALITY.md",
		at: () => path.join(box.agentDir, "PERSONALITY.md"),
		script: () =>
			`import { buildSystemPrompt } from ${mod("coding-agent", "system-prompt.ts")};
			await buildSystemPrompt({ cwd: ${JSON.stringify(box.projectDir)}, personality: "default", skills: [], contextFiles: [] });`,
		outcome: "skipped",
	},
	// The same files, through readers the census could not reach past an earlier hang.
	{
		name: "~/.omp/agent/config.yml, read by auth-broker discovery",
		at: () => path.join(box.agentDir, "config.yml"),
		script: () =>
			`import { resolveAuthBrokerConfig } from ${mod("ai", "auth-broker/discover.ts")};
			await resolveAuthBrokerConfig({ agentDir: ${JSON.stringify(box.agentDir)} });`,
		outcome: "refused",
	},
	{
		name: "~/.omp/auth-broker.token",
		at: () => path.join(box.home, ".omp", "auth-broker.token"),
		script: () =>
			`import { resolveAuthBrokerConfig } from ${mod("ai", "auth-broker/discover.ts")};
			import { MissingApiKeyError } from ${mod("ai", "error/index.ts")};
			try {
				await resolveAuthBrokerConfig({ agentDir: ${JSON.stringify(box.agentDir)} });
			} catch (error) {
				// A broker with no token is this call's own answer, as with no file at all.
				if (!(error instanceof MissingApiKeyError)) throw error;
			}`,
		env: () => ({ OMP_AUTH_BROKER_URL: "http://127.0.0.1:9" }),
		outcome: "skipped",
	},
	{
		name: "~/.omp/plugins/omp-plugins.lock.json",
		at: () => path.join(box.home, ".omp", "plugins", "omp-plugins.lock.json"),
		script: () =>
			`import { getPluginSettings } from ${mod("coding-agent", "extensibility/plugins/loader.ts")};
			await getPluginSettings("none", ${JSON.stringify(box.projectDir)});`,
		outcome: "skipped",
	},
];

describe.skipIf(process.platform === "win32")("a FIFO at a startup path is neither waited on nor read", () => {
	for (const c of cases) itRefusesFifo(box, c);

	it(
		"a link to a FIFO is judged by what it leads to",
		async () => {
			const pipe = path.join(box.root, "elsewhere", "pipe");
			const fifo = fifoWithInput(pipe);
			const at = path.join(box.home, ".idapro", "ida-config.json");
			fs.mkdirSync(path.dirname(at), { recursive: true });
			fs.symlinkSync(pipe, at);

			const run = await runChild(
				box,
				`import { locateIdaInstall } from ${mod("coding-agent", "ida/install.ts")};
			locateIdaInstall(undefined);`,
			);
			const left = fifo.left();

			expect(run.exit).toBe(0);
			expect(namedAsFifo(run.stderr, at)).toBe(1);
			expect(left).toBe(PAYLOAD);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a FIFO put at a file's name after the look at the name is opened, but neither waited on nor read",
		async () => {
			const at = path.join(box.projectDir, "AGENTS.md");
			const fifo = fifoWithInput(at);
			const regular = path.join(box.root, "regular.md");
			fs.writeFileSync(regular, "a regular file\n");
			// The helper looks at the name through `node:fs/promises` `stat`; redirect that one call so
			// every look at the name sees a regular file, while the open a moment later finds the FIFO.
			const realStat = fsp.stat;
			// Cast at the mock boundary: `stat` is an overloaded node API, and this redirect only ever
			// takes the one-argument form the helper uses.
			vi.spyOn(fsp, "stat").mockImplementation(((file: fs.PathLike) =>
				realStat(file === at ? regular : file)) as typeof fsp.stat);

			const content = await readDiscoveryFile(at);
			const left = fifo.left();

			expect(content).toBeNull();
			expect(left).toBe(PAYLOAD);
		},
		TEST_TIMEOUT_MS,
	);
});

// A `.env` is the one file a tool serves through a named pipe on purpose:
// 1Password mounts `.env` files that way, and writes the file when a reader
// opens it. So at startup a pipe at a `.env` path is read until its writer
// closes it, within a bound; with nothing writing it, the command goes on
// without it after the bound and says that its variables are unset. A writer
// that dies part way through also closes the pipe, and what it wrote by then is
// parsed as the whole file: nothing a reader sees tells the two apart. The
// children here have no terminal, so the bound is ENV_PIPE_DEADLINE_MS.
//
// What omp says is for a person, and no program parses it, so these tests read
// the facts each note carries — the file, the bound, that its variables are
// unset, whether Ctrl-C ends the wait at once — and not the wording. The lines
// a child prints for the test (`NAME=value`, `calls=…`) are read exactly: the
// test parses them.
const ENV_PATHS = {
	"~/.env": () => path.join(box.home, ".env"),
	"~/.omp/.env": () => path.join(box.home, ".omp", ".env"),
	"~/.omp/agent/.env": () => path.join(box.agentDir, ".env"),
	"<project>/.env": () => path.join(box.projectDir, ".env"),
};
const VARIABLE = "STARTUP_FIFO_PROBE";
const BOUND = `${envBounds.ENV_PIPE_DEADLINE_MS / 1000} s`;

/** The child loads omp's environment as every command does, then prints what the probe variable holds. */
const loadEnvAndPrint = (): string =>
	`import ${mod("utils", "index.ts")};
	console.log("${VARIABLE}=" + (process.env.${VARIABLE} ?? "unset"));`;

/** A writer that waits for a reader to open `target`, writes `text` once and closes it, as a 1Password mount does. */
function answeringWriter(target: string, text: string): Bun.Subprocess {
	mkfifo(target);
	return Bun.spawn(["sh", "-c", 'printf %s "$1" > "$0"', target, text], { stdout: "ignore", stderr: "ignore" });
}

/**
 * A writer that answers the first reader of `target` as {@link answeringWriter}
 * does. Once the test makes `loaded`, it makes `<reopened>.waiting` and waits
 * in its own open for any second reader, and makes `reopened` when one comes;
 * it then holds the pipe open without writing, so a second reader that reads
 * would wait out the bound.
 */
function answerOnceThenWait(target: string, text: string, loaded: string, reopened: string): Bun.Subprocess {
	mkfifo(target);
	return Bun.spawn(
		[
			"sh",
			"-c",
			'printf %s "$1" > "$0"; while [ ! -e "$2" ]; do sleep 0.05; done; : > "$3.waiting"; exec 3>"$0"; : > "$3"; exec sleep 60',
			target,
			text,
			loaded,
			reopened,
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
}

/** The waiting note and the passed-over note about `file`, in the order omp said them. */
function waitThenPassOver(stderr: string, file: string): { waiting: string; passedOver: string } {
	const notes = notesAbout(stderr, file);
	expect(notes).toHaveLength(2);
	const [waiting, passedOver] = notes as [string, string];
	// Waiting first, with the bound; then passed over, with its variables unset.
	expect(waiting).toContain(BOUND);
	expect(waiting).not.toMatch(/\bunset\b/);
	expect(passedOver).toContain(BOUND);
	expect(passedOver).toMatch(/\bunset\b/);
	return { waiting, passedOver };
}

describe.skipIf(process.platform === "win32")("a .env pipe is read until its writer closes it, within a bound", () => {
	for (const [name, at] of Object.entries(ENV_PATHS)) {
		it(
			`${name}, answered by a writer, sets its variables`,
			async () => {
				const writer = answeringWriter(at(), `${VARIABLE}=loaded\n`);
				try {
					const run = await runChild(box, loadEnvAndPrint());

					expect(run.exit).toBe(0);
					expect(run.stdout).toContain(`${VARIABLE}=loaded`);
					expect(notesAbout(run.stderr, at())).toEqual([]);
				} finally {
					writer.kill();
				}
			},
			TEST_TIMEOUT_MS,
		);

		it(
			`${name}, with nothing writing to it, is passed over after the bound with its variables unset`,
			async () => {
				mkfifo(at());

				const run = await runChild(box, loadEnvAndPrint());

				expect(run.exit).toBe(0);
				expect(run.stdout).toContain(`${VARIABLE}=unset`);
				const { waiting } = waitThenPassOver(run.stderr, at());
				// Every stop listener here is omp's own, so Ctrl-C ends the wait at once.
				expect(waiting).toMatch(/Ctrl-C/);
				expect(waiting).not.toMatch(/when the wait ends/);
			},
			TEST_TIMEOUT_MS,
		);
	}

	it(
		"a writer that has not closed the pipe by the bound sets none of its variables",
		async () => {
			const at = path.join(box.home, ".env");
			// The first line is whole; the writer holds the pipe open and never finishes the second.
			mkfifo(at);
			const fd = fs.openSync(at, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
			fs.writeSync(fd, `${VARIABLE}=loaded\nSECOND=`);
			try {
				const run = await runChild(box, loadEnvAndPrint());

				expect(run.exit).toBe(0);
				expect(run.stdout).toContain(`${VARIABLE}=unset`);
				waitThenPassOver(run.stderr, at);
			} finally {
				fs.closeSync(fd);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a writer that sends more than any .env holds sets none of its variables, and is cut off",
		async () => {
			const at = path.join(box.home, ".env");
			mkfifo(at);
			// A whole first line, then 2 MiB with no end, the pipe held open after it.
			const writer = Bun.spawn(
				[
					"sh",
					"-c",
					'{ printf "%s\\n" "$1"; head -c 2097152 /dev/zero | tr "\\0" A; sleep 60; } > "$0"',
					at,
					`${VARIABLE}=loaded`,
				],
				{ stdout: "ignore", stderr: "ignore" },
			);
			try {
				const run = await runChild(box, loadEnvAndPrint());

				expect(run.exit).toBe(0);
				expect(run.stdout).toContain(`${VARIABLE}=unset`);
				// The note gives the size bound, not the time bound, and says its variables are unset.
				const passedOver = notesAbout(run.stderr, at).filter(line => /\bunset\b/.test(line));
				expect(passedOver).toHaveLength(1);
				expect(passedOver[0]).toContain(`${envBounds.ENV_PIPE_MAX_BYTES / 1024} KiB`);
			} finally {
				writer.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a regular .env file sets its variables, with nothing said",
		async () => {
			const at = path.join(box.home, ".env");
			fs.writeFileSync(at, `${VARIABLE}=loaded\n`);

			const run = await runChild(box, loadEnvAndPrint());

			expect(run.exit).toBe(0);
			expect(run.stdout).toContain(`${VARIABLE}=loaded`);
			expect(notesAbout(run.stderr, at)).toEqual([]);
		},
		TEST_TIMEOUT_MS,
	);

	it.skipIf(process.platform !== "linux" || !Bun.which("script"))(
		"at a terminal the wait is longer, and Ctrl-C ends it at once",
		async () => {
			const at = path.join(box.home, ".env");
			mkfifo(at);
			const childFile = path.join(box.root, "child.ts");
			fs.writeFileSync(childFile, `${loadEnvAndPrint()}\nprocess.exit(0);\n`);
			// util-linux `script` runs the child on a pseudo-terminal; a ^C byte written to it
			// is turned into SIGINT for the child by the terminal, as a key press is.
			const child = Bun.spawn(["script", "-qfec", `${process.execPath} --no-env-file ${childFile}`, "/dev/null"], {
				cwd: box.projectDir,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, HOME: box.home, PI_CODING_AGENT_DIR: box.agentDir },
			});
			// The waiting note names the file and gives the terminal's longer bound.
			const terminalBound = `${envBounds.ENV_PIPE_TERMINAL_DEADLINE_MS / 1000} s`;
			const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
			let seen = "";
			const noticed = (async () => {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) return false;
					seen += new TextDecoder().decode(value);
					if (notesAbout(seen, at).some(line => line.includes(terminalBound))) return true;
				}
			})();
			// A real timer: the child's start-up and the terminal are real.
			const sawNotice = await Promise.race([noticed, Bun.sleep(TEST_TIMEOUT_MS - 20_000).then(() => false)]);
			const pressed = Date.now();
			child.stdin.write("\x03");
			child.stdin.flush();
			const ended = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
			const afterPress = Date.now() - pressed;
			if (!ended) child.kill("SIGKILL");
			await child.exited;

			expect(sawNotice).toBe(true);
			expect(ended).toBe(true);
			expect(afterPress).toBeLessThan(10_000);
			expect(seen).not.toContain(`${VARIABLE}=`);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a writer that closes the pipe only after the bound sets none of its variables",
		async () => {
			const at = path.join(box.home, ".env");
			mkfifo(at);
			// The whole file at once, the pipe held open by this test.
			const fd = fs.openSync(at, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
			fs.writeSync(fd, `${VARIABLE}=loaded\n`);
			let closed = false;
			const started = startChild(box, loadEnvAndPrint());
			try {
				// The note that omp is waiting on this file.
				const waiting = await started.saw(line => line.includes(at) && line.includes(BOUND));
				// Stopped inside the bound, the child reads again only after this test has
				// closed the pipe, past the bound: its next read finds the end of the file late.
				// A real timer, because the bound is the child's real clock.
				started.child.kill("SIGSTOP");
				await Bun.sleep(envBounds.ENV_PIPE_DEADLINE_MS + 1_000);
				fs.closeSync(fd);
				closed = true;
				started.child.kill("SIGCONT");
				const run = await started.finish();

				expect(waiting).toBe(true);
				expect(run.exit).toBe(0);
				expect(run.stdout).toContain(`${VARIABLE}=unset`);
				waitThenPassOver(run.stderr, at);
			} finally {
				if (!closed) fs.closeSync(fd);
				started.child.kill("SIGKILL");
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a stop listener added with process.once still runs once after the wait, and the note says Ctrl-C waits",
		async () => {
			const at = path.join(box.home, ".env");
			mkfifo(at);
			// Opens the pipe at once and answers a second later, after omp has said it is waiting.
			const writer = Bun.spawn(
				["sh", "-c", 'exec 3>"$0"; sleep 1; printf %s "$1" >&3', at, `${VARIABLE}=loaded\n`],
				{ stdout: "ignore", stderr: "ignore" },
			);
			// Added before omp's environment loads, as an embedding program's own listener is.
			const listener = path.join(box.root, "once-listener.ts");
			fs.writeFileSync(listener, 'export let calls = 0;\nprocess.once("SIGTERM", () => {\n\tcalls++;\n});\n');
			try {
				const run = await runChild(
					box,
					`import * as once from ${JSON.stringify(listener)};
				import ${mod("utils", "env.ts")};
				process.emit("SIGTERM");
				process.emit("SIGTERM");
				console.log("calls=" + once.calls + " listeners=" + process.listenerCount("SIGTERM"));
				console.log("${VARIABLE}=" + (process.env.${VARIABLE} ?? "unset"));`,
				);

				expect(run.exit).toBe(0);
				expect(run.stdout).toContain("calls=1 listeners=0");
				expect(run.stdout).toContain(`${VARIABLE}=loaded`);
				// Another program's listener stays on, so the note says Ctrl-C waits for the wait.
				const [waiting] = notesAbout(run.stderr, at);
				expect(waiting).toMatch(/Ctrl-C.*when the wait ends/);
			} finally {
				writer.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a function registered through onStopSignal and process.once keeps its once registration",
		async () => {
			const at = path.join(box.home, ".env");
			mkfifo(at);
			// Opens the pipe at once and answers a second later, after omp has said it is waiting.
			const writer = Bun.spawn(
				["sh", "-c", 'exec 3>"$0"; sleep 1; printf %s "$1" >&3', at, `${VARIABLE}=loaded\n`],
				{ stdout: "ignore", stderr: "ignore" },
			);
			// The same function has one persistent registration and one once registration.
			const listener = path.join(box.root, "reused-listener.ts");
			fs.writeFileSync(
				listener,
				`import { onStopSignal } from ${mod("utils", "regular-file.ts")};\n` +
					"export let calls = 0;\n" +
					"const callback = () => {\n\tcalls++;\n};\n" +
					'onStopSignal("SIGINT", callback);\n' +
					'process.once("SIGTERM", callback);\n',
			);
			try {
				const run = await runChild(
					box,
					`import * as reused from ${JSON.stringify(listener)};
				import ${mod("utils", "env.ts")};
				process.emit("SIGTERM");
				process.emit("SIGTERM");
				console.log("calls=" + reused.calls + " listeners=" + process.listenerCount("SIGTERM"));`,
				);

				expect(run.exit).toBe(0);
				expect(run.stdout).toContain("calls=1 listeners=0");
				const [waiting] = notesAbout(run.stderr, at);
				expect(waiting).toMatch(/Ctrl-C.*when the wait ends/);
			} finally {
				writer.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a stop signal ends the wait at once when every stop listener was added through onStopSignal",
		async () => {
			const at = path.join(box.home, ".env");
			mkfifo(at);
			// Added before omp's environment loads, as omp's own crash handler is.
			const listener = path.join(box.root, "stop-listener.ts");
			fs.writeFileSync(
				listener,
				`import { onStopSignal } from ${mod("utils", "regular-file.ts")};\n` +
					'onStopSignal("SIGTERM", () => {\n\tconsole.log("LISTENER RAN");\n});\n',
			);
			const started = startChild(box, `import ${JSON.stringify(listener)};\n${loadEnvAndPrint()}`);
			try {
				// The waiting note, which says Ctrl-C ends the wait at once.
				const waiting = await started.saw(
					line => line.includes(at) && /Ctrl-C/.test(line) && !/when the wait ends/.test(line),
				);
				started.child.kill("SIGTERM");
				const run = await started.finish();

				expect(waiting).toBe(true);
				expect(started.child.signalCode).toBe("SIGTERM");
				expect(run.stdout).not.toContain("LISTENER RAN");
				expect(run.stdout).not.toContain(`${VARIABLE}=`);
			} finally {
				started.child.kill("SIGKILL");
			}
		},
		TEST_TIMEOUT_MS,
	);
});

// Re-reads of the project's `.env` files while omp runs — for every child
// shell's environment and for the stream redactor — never wait on a pipe, and
// never open one: an open wakes a writer that waits for a reader, as a
// 1Password mount does, and it then serves a reader that is gone.
describe.skipIf(process.platform === "win32")("a .env re-read while omp runs never opens a pipe", () => {
	const buildChildShellEnv = (): string =>
		`import { filterChildShellEnv } from ${mod("utils", "index.ts")};
		filterChildShellEnv(process.env);
		console.log("BUILT");`;

	it(
		"a FIFO at a .env file read only for a child shell is refused, not waited on or read",
		async () => {
			const at = path.join(box.projectDir, ".env.local");
			const fifo = fifoWithInput(at);

			const run = await runChild(box, buildChildShellEnv());
			const left = fifo.left();

			expect(run.exit).toBe(0);
			expect(run.stdout).toContain("BUILT");
			expect(namedAsFifo(run.stderr, at)).toBe(1);
			expect(left).toBe(PAYLOAD);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a FIFO at a .env file read only for a child shell does not wake a writer waiting in its open",
		async () => {
			const at = path.join(box.projectDir, ".env.local");
			const writer = writerWaitingInOpen(box, at);
			try {
				const run = await runChild(box, buildChildShellEnv());

				expect(run.exit).toBe(0);
				expect(run.stdout).toContain("BUILT");
				expect(namedAsFifo(run.stderr, at)).toBe(1);
				expect(await writer.woken()).toBe(false);
			} finally {
				writer.stop();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a .env pipe loaded at startup is not opened again: a child shell and the redactor use what was loaded",
		async () => {
			const at = path.join(box.projectDir, ".env");
			const loaded = path.join(box.root, "startup-loaded");
			const reopened = path.join(box.root, "pipe-reopened");
			const writer = answerOnceThenWait(at, `${VARIABLE}=loaded\n`, loaded, reopened);
			try {
				const run = await runChild(
					box,
					`import * as fs from "node:fs";
				import { filterChildShellEnv, getDotenvEnvValues } from ${mod("utils", "index.ts")};
				fs.writeFileSync(${JSON.stringify(loaded)}, "");
				// The re-reads come once the writer is about to wait in its second open, and a
				// moment more for it to get there: a re-read before it waits would wake nothing.
				while (!fs.existsSync(${JSON.stringify(`${reopened}.waiting`)})) await Bun.sleep(20);
				await Bun.sleep(200);
				console.log("redactor=" + getDotenvEnvValues().includes("loaded"));
				console.log("child=" + (filterChildShellEnv(process.env).${VARIABLE} ?? "absent"));`,
				);

				expect(run.exit).toBe(0);
				// The redactor knows the value, and the child shell does not inherit it.
				expect(run.stdout).toContain("redactor=true");
				expect(run.stdout).toContain("child=absent");
				expect(notesAbout(run.stderr, at)).toEqual([]);
				expect(fs.existsSync(reopened)).toBe(false);
			} finally {
				writer.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a .env pipe loaded at startup is reused through a symbolic-link alias of the project",
		async () => {
			const alias = path.join(box.root, "project-link");
			fs.symlinkSync(box.projectDir, alias);
			// The writer answers once, as at startup, and is gone before the re-reads.
			const writer = answeringWriter(path.join(box.projectDir, ".env"), `${VARIABLE}=loaded\n`);
			try {
				const run = await runChild(
					box,
					`import { filterChildShellEnv, getDotenvEnvValues } from ${mod("utils", "index.ts")};
				console.log("redactor=" + getDotenvEnvValues(${JSON.stringify(alias)}).includes("loaded"));
				console.log("child=" + (filterChildShellEnv(process.env, ${JSON.stringify(alias)}).${VARIABLE} ?? "absent"));`,
				);

				expect(run.exit).toBe(0);
				expect(run.stdout).toContain("redactor=true");
				expect(run.stdout).toContain("child=absent");
				expect(notesAbout(run.stderr, path.join(alias, ".env"))).toEqual([]);
				expect(notesAbout(run.stderr, path.join(box.projectDir, ".env"))).toEqual([]);
			} finally {
				writer.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

// A worker thread re-enters the CLI entry and loads omp's environment again, in
// an isolate of its own. The `.env` reads at startup happen once per process: a
// worker takes what the thread that started it read.
describe.skipIf(process.platform === "win32")("a .env read at startup is read once per process", () => {
	it(
		"a worker thread that re-enters the CLI entry neither opens nor waits on a .env pipe startup read",
		async () => {
			const at = path.join(box.home, ".env");
			const loaded = path.join(box.root, "startup-loaded");
			const reopened = path.join(box.root, "pipe-reopened");
			const writer = answerOnceThenWait(at, `${VARIABLE}=loaded\n`, loaded, reopened);
			try {
				const run = await runChild(
					box,
					`import * as fs from "node:fs";
				import ${mod("utils", "index.ts")};
				console.log("${VARIABLE}=" + (process.env.${VARIABLE} ?? "unset"));
				fs.writeFileSync(${JSON.stringify(loaded)}, "");
				// As production starts a worker: the CLI entry, with a worker selector.
				const worker = new Worker(${mod("coding-agent", "cli.ts")}, {
					type: "module",
					argv: ["__omp_worker_terminal_output"],
				});
				const reply = Promise.withResolvers();
				worker.addEventListener("message", event => reply.resolve(event.data));
				worker.addEventListener("error", event => reply.reject(event.error ?? new Error(event.message)));
				worker.postMessage({ output: "ready", options: { head: false, maxRows: 10 } });
				console.log("reply=" + (await reply.promise).ok);
				worker.terminate();`,
				);

				expect(run.exit).toBe(0);
				expect(run.stdout).toContain(`${VARIABLE}=loaded`);
				expect(run.stdout).toContain("reply=true");
				expect(fs.existsSync(reopened)).toBe(false);
				expect(notesAbout(run.stderr, at)).toEqual([]);
			} finally {
				writer.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"run from the home directory, the one .env pipe that is both ~/.env and the project's is read once",
		async () => {
			const at = path.join(box.home, ".env");
			// The writer answers once, as at startup; a second read would find no writer.
			const writer = answeringWriter(at, `${VARIABLE}=loaded\n`);
			try {
				const run = await runChild(box, loadEnvAndPrint(), {}, box.home);

				expect(run.exit).toBe(0);
				expect(run.stdout).toContain(`${VARIABLE}=loaded`);
				expect(notesAbout(run.stderr, at)).toEqual([]);
			} finally {
				writer.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
