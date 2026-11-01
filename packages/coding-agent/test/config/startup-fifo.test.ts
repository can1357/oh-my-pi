import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
// A namespace import, not named imports: this file must still load against code
// that has no such constants, which is how it is run against `main` to show
// each case fails there.
import * as envBounds from "@oh-my-pi/pi-utils/env";

// Every file a user or another process can place that omp reads before a
// command does its own work: the `.env` and `config.yml` files every command
// reads, and the files a session reads when it starts. A real FIFO stands at
// the path, and the command's own startup call runs in a child process,
// twice:
//
// - with input waiting in the FIFO and its write end held open by this test:
//   a reader that reads it takes the input, then waits for an end of file
//   that never comes;
// - with nothing writing to it: a blocking open, or a read, waits for ever.
//
// The pass is the child's own exit code, every byte of the input still in the
// FIFO, and the file named in what the command says. A child that does not
// finish in time is killed: a read that blocks stops every timer in its own
// process, so only another process can see it. An open with `O_NONBLOCK`
// alone fails the first run: the open returns at once, and the read after it
// reads the FIFO like any stream.
// The deadline is wide because it cannot tell a child blocked on a FIFO from one
// slow to load omp's modules on a busy machine: at load about 290, a child that
// was still loading was killed at a 20 s deadline. A blocked child never
// finishes, so a wide deadline only slows a failing run.
const CHILD_DEADLINE_MS = 45_000;
const TEST_TIMEOUT_MS = CHILD_DEADLINE_MS + 15_000;
const PAYLOAD = "queued for someone else\n";
const repoRoot = path.resolve(import.meta.dir, "../../../..");

let tempDir: TempDir;
let home: string;
let agentDir: string;
let projectDir: string;

beforeEach(() => {
	tempDir = TempDir.createSync("@omp-startup-fifo-");
	home = path.join(tempDir.path(), "home");
	agentDir = path.join(home, ".omp", "agent");
	// Inside home, so a walk up from the project stops there.
	projectDir = path.join(home, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(path.join(projectDir, ".omp"), { recursive: true });
});

afterEach(() => {
	tempDir.removeSync();
});

/** A module of this repository, by absolute path: the child runs in the project directory. */
function mod(pkg: string, file: string): string {
	return JSON.stringify(path.join(repoRoot, "packages", pkg, "src", file));
}

function mkfifo(target: string): void {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const made = Bun.spawnSync(["mkfifo", target]);
	if (made.exitCode !== 0) throw new Error(made.stderr.toString());
}

/** A FIFO at `target` holding {@link PAYLOAD}, its write end held by this process until `left` is read. */
function fifoWithInput(target: string): { left(): string } {
	mkfifo(target);
	const fd = fs.openSync(target, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
	fs.writeSync(fd, PAYLOAD);
	return {
		left() {
			const buffer = Buffer.alloc(4096);
			let text = "";
			try {
				for (;;) {
					const n = fs.readSync(fd, buffer, 0, buffer.length, null);
					if (n <= 0) break;
					text += buffer.subarray(0, n).toString();
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
			} finally {
				fs.closeSync(fd);
			}
			return text;
		},
	};
}

/** The test runner's environment without anything that would point omp, AWS or IDA somewhere else. */
function childEnv(extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || /^(PI_|OMP_|AWS_|XDG_|IDA)/.test(key)) continue;
		env[key] = value;
	}
	return { ...env, HOME: home, PI_CODING_AGENT_DIR: agentDir, AWS_EC2_METADATA_DISABLED: "true", ...extra };
}

interface Run {
	exit: number | "hung";
	stdout: string;
	stderr: string;
}

/** Run `script` as a module in `cwd` (the project directory by default); "hung" if it does not finish in time. */
async function runChild(script: string, env: Record<string, string>, cwd: string = projectDir): Promise<Run> {
	const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `${script}\nprocess.exit(0);`], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: childEnv(env),
	});
	// A real timer, because the defect is a read that blocks: no fake clock reaches the child.
	const settled = await Promise.race([child.exited.then(() => true), Bun.sleep(CHILD_DEADLINE_MS).then(() => false)]);
	if (!settled) child.kill("SIGKILL");
	const exitCode = await child.exited;
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	return { exit: settled ? exitCode : "hung", stdout, stderr };
}

/** {@link runChild}, started now: `saw` waits for a text on its standard error while it runs, `finish` for its end. */
function startChild(script: string): {
	child: Bun.Subprocess;
	saw(text: string): Promise<boolean>;
	finish(): Promise<Run>;
} {
	const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `${script}\nprocess.exit(0);`], {
		cwd: projectDir,
		stdout: "pipe",
		stderr: "pipe",
		env: childEnv({}),
	});
	let stderr = "";
	const drained = (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
			stderr += decoder.decode(chunk, { stream: true });
		}
	})();
	return {
		child,
		async saw(text) {
			// A real timer: the child is another process, and no fake clock reaches it.
			for (const started = Date.now(); Date.now() - started < CHILD_DEADLINE_MS; await Bun.sleep(20)) {
				if (stderr.includes(text)) return true;
				if (child.exitCode !== null || child.signalCode !== null) break;
			}
			return stderr.includes(text);
		},
		async finish() {
			const settled = await Promise.race([
				child.exited.then(() => true),
				Bun.sleep(CHILD_DEADLINE_MS).then(() => false),
			]);
			if (!settled) child.kill("SIGKILL");
			const exitCode = await child.exited;
			await drained;
			const stdout = await new Response(child.stdout as ReadableStream<Uint8Array>).text();
			return { exit: settled ? exitCode : "hung", stdout, stderr };
		},
	};
}

function timesNamed(text: string, file: string): number {
	return text.split(`omp did not read ${file}: it is a FIFO`).length - 1;
}

interface Case {
	/** The path, as the pull request names it. */
	name: string;
	/** Where the FIFO stands, once the directories exist. */
	at(): string;
	/** The child module: imports, then the call a command makes at startup that reads `at`. */
	script(): string;
	/**
	 * `skipped`: an optional file — the command goes on without it, exits 0,
	 * and says once on standard error which file it did not read and why.
	 * `refused`: a file the command cannot go on without — it stops with exit 1
	 * and names the file. `reported`: the caller's own error result names it,
	 * and the command goes on (the child prints that result).
	 */
	outcome: "skipped" | "refused" | "reported";
	env?(): Record<string, string>;
}

const watchdogMd = (): string =>
	`import { discoverWatchdogFiles } from ${mod("coding-agent", "advisor/watchdog.ts")};
	await discoverWatchdogFiles(${JSON.stringify(projectDir)}, ${JSON.stringify(agentDir)});`;

const watchdogYml = (): string =>
	`import { discoverAdvisorConfigs } from ${mod("coding-agent", "advisor/config.ts")};
	await discoverAdvisorConfigs(${JSON.stringify(projectDir)}, ${JSON.stringify(agentDir)});`;

const settingsInit = (): string =>
	`import { Settings } from ${mod("coding-agent", "config/settings.ts")};
	await Settings.init({ cwd: ${JSON.stringify(projectDir)}, agentDir: ${JSON.stringify(agentDir)} });`;

const pluginOverrides = (): string =>
	`import { getEnabledPlugins } from ${mod("coding-agent", "extensibility/plugins/loader.ts")};
	await getEnabledPlugins(${JSON.stringify(projectDir)});`;

const skillshare = (): string =>
	`import { loadSkillshareSkills } from ${mod("coding-agent", "discovery/skillshare.ts")};
	await loadSkillshareSkills({ cwd: ${JSON.stringify(projectDir)}, home: ${JSON.stringify(home)}, repoRoot: null });`;

// Files a FIFO at which is refused by kind: no tool serves any of them through
// a pipe on purpose. `.env`, which 1Password does serve that way, is below.
const cases: Case[] = [
	// Read by every command, before it does anything else.
	{
		name: "~/.omp/agent/config.yml",
		at: () => path.join(agentDir, "config.yml"),
		script: settingsInit,
		outcome: "refused",
	},
	{
		name: "<project>/.omp/config.yml",
		at: () => path.join(projectDir, ".omp", "config.yml"),
		script: settingsInit,
		outcome: "refused",
	},
	// Read when a session starts.
	{
		name: "~/.omp/agent/models.yml",
		at: () => path.join(agentDir, "models.yml"),
		script: () =>
			`import { ModelsConfigFile } from ${mod("coding-agent", "config/models-config.ts")};
			const loaded = ModelsConfigFile.tryLoad();
			console.log(loaded.status, String(loaded.error));`,
		outcome: "reported",
	},
	{
		name: "~/.omp/agent/mcp.json",
		at: () => path.join(agentDir, "mcp.json"),
		script: () =>
			`import { loadAllMCPConfigs } from ${mod("coding-agent", "mcp/config.ts")};
			await loadAllMCPConfigs(${JSON.stringify(projectDir)});`,
		outcome: "skipped",
	},
	...([".omp", ".claude", ".codex", ".gemini"] as const).map((dir): Case => ({
		name: `<project>/${dir}/plugin-overrides.json`,
		at: () => path.join(projectDir, dir, "plugin-overrides.json"),
		script: pluginOverrides,
		outcome: "skipped",
	})),
	...(["WATCHDOG.md", "WATCHDOG.yml", "WATCHDOG.yaml"] as const).flatMap(file =>
		(["~/.omp/agent", "<project>/.omp", "<project>"] as const).map((dir): Case => ({
			name: `${dir}/${file}`,
			at: () =>
				path.join(
					{ "~/.omp/agent": agentDir, "<project>/.omp": path.join(projectDir, ".omp"), "<project>": projectDir }[
						dir
					],
					file,
				),
			script: file === "WATCHDOG.md" ? watchdogMd : watchdogYml,
			outcome: "skipped",
		})),
	),
	{
		name: "~/.omp/agent/skills.lock.json",
		at: () => path.join(agentDir, "skills.lock.json"),
		script: skillshare,
		outcome: "skipped",
	},
	{
		name: "<project>/.omp/skills.lock.json",
		at: () => path.join(projectDir, ".omp", "skills.lock.json"),
		script: skillshare,
		outcome: "skipped",
	},
	{
		// The model registry's synchronous check for an AWS profile, at every session start.
		name: "~/.aws/credentials",
		at: () => path.join(home, ".aws", "credentials"),
		script: () =>
			`import { hasConfiguredAwsProfile } from ${mod("ai", "utils/aws-profile.ts")};
			hasConfiguredAwsProfile();`,
		outcome: "skipped",
	},
	{
		// The same file, read again when a Bedrock request resolves its credentials.
		name: "~/.aws/credentials, when a request resolves credentials",
		at: () => path.join(home, ".aws", "credentials"),
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
		at: () => path.join(home, ".idapro", "ida-config.json"),
		script: () =>
			`import { locateIdaInstall } from ${mod("coding-agent", "ida/install.ts")};
			locateIdaInstall(undefined);`,
		outcome: "skipped",
	},
	{
		name: "~/.omp/agent/PERSONALITY.md",
		at: () => path.join(agentDir, "PERSONALITY.md"),
		script: () =>
			`import { buildSystemPrompt } from ${mod("coding-agent", "system-prompt.ts")};
			await buildSystemPrompt({ cwd: ${JSON.stringify(projectDir)}, personality: "default", skills: [], contextFiles: [] });`,
		outcome: "skipped",
	},
	// The same files, through readers the census could not reach past an earlier hang.
	{
		name: "~/.omp/agent/config.yml, read by auth-broker discovery",
		at: () => path.join(agentDir, "config.yml"),
		script: () =>
			`import { resolveAuthBrokerConfig } from ${mod("ai", "auth-broker/discover.ts")};
			await resolveAuthBrokerConfig({ agentDir: ${JSON.stringify(agentDir)} });`,
		outcome: "refused",
	},
	{
		name: "~/.omp/auth-broker.token",
		at: () => path.join(home, ".omp", "auth-broker.token"),
		script: () =>
			`import { resolveAuthBrokerConfig } from ${mod("ai", "auth-broker/discover.ts")};
			import { MissingApiKeyError } from ${mod("ai", "error/index.ts")};
			try {
				await resolveAuthBrokerConfig({ agentDir: ${JSON.stringify(agentDir)} });
			} catch (error) {
				// A broker with no token is this call's own answer, as with no file at all.
				if (!(error instanceof MissingApiKeyError)) throw error;
			}`,
		env: () => ({ OMP_AUTH_BROKER_URL: "http://127.0.0.1:9" }),
		outcome: "skipped",
	},
	{
		name: "~/.omp/plugins/omp-plugins.lock.json",
		at: () => path.join(home, ".omp", "plugins", "omp-plugins.lock.json"),
		script: () =>
			`import { getPluginSettings } from ${mod("coding-agent", "extensibility/plugins/loader.ts")};
			await getPluginSettings("none", ${JSON.stringify(projectDir)});`,
		outcome: "skipped",
	},
];

function expectNamed(run: Run, c: Case): void {
	const at = c.at();
	if (c.outcome === "skipped") {
		expect(run.exit).toBe(0);
		expect(timesNamed(run.stderr, at)).toBe(1);
	} else if (c.outcome === "refused") {
		expect(run.exit).toBe(1);
		expect(timesNamed(run.stdout + run.stderr, at)).toBeGreaterThan(0);
	} else {
		expect(run.exit).toBe(0);
		expect(run.stdout).toStartWith("error ");
		expect(timesNamed(run.stdout, at)).toBe(1);
	}
}

describe.skipIf(process.platform === "win32")("a FIFO at a startup path is neither waited on nor read", () => {
	for (const c of cases) {
		it(
			`${c.name}, with input waiting in it`,
			async () => {
				const fifo = fifoWithInput(c.at());

				const run = await runChild(c.script(), c.env?.() ?? {});
				const left = fifo.left();

				expectNamed(run, c);
				expect(left).toBe(PAYLOAD);
				expect(fs.lstatSync(c.at()).isFIFO()).toBe(true);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			`${c.name}, with nothing writing to it`,
			async () => {
				mkfifo(c.at());

				const run = await runChild(c.script(), c.env?.() ?? {});

				expectNamed(run, c);
			},
			TEST_TIMEOUT_MS,
		);
	}

	it(
		"a link to a FIFO is judged by what it leads to",
		async () => {
			const pipe = path.join(tempDir.path(), "elsewhere", "pipe");
			const fifo = fifoWithInput(pipe);
			const at = path.join(home, ".idapro", "ida-config.json");
			fs.mkdirSync(path.dirname(at), { recursive: true });
			fs.symlinkSync(pipe, at);

			const run = await runChild(
				`import { locateIdaInstall } from ${mod("coding-agent", "ida/install.ts")};
			locateIdaInstall(undefined);`,
				{},
			);
			const left = fifo.left();

			expect(run.exit).toBe(0);
			expect(timesNamed(run.stderr, at)).toBe(1);
			expect(left).toBe(PAYLOAD);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a FIFO put at a discovery file's name after a look at it is still not read",
		async () => {
			const at = path.join(projectDir, "AGENTS.md");
			const fifo = fifoWithInput(at);
			const regular = path.join(tempDir.path(), "regular.md");
			fs.writeFileSync(regular, "a regular file\n");

			// The look at the name sees a regular file; by the read, a FIFO stands there.
			const run = await runChild(
				`import * as fs from "node:fs";
			import { readFile } from ${mod("coding-agent", "capability/fs.ts")};
			const look = fs.promises.stat;
			fs.promises.stat = (file, ...rest) => look(file === ${JSON.stringify(at)} ? ${JSON.stringify(regular)} : file, ...rest);
			const content = await readFile(${JSON.stringify(at)});
			console.log("content", JSON.stringify(content));`,
				{},
			);
			const left = fifo.left();

			expect(run.exit).toBe(0);
			expect(run.stdout).toContain("content null");
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
const ENV_PATHS = {
	"~/.env": () => path.join(home, ".env"),
	"~/.omp/.env": () => path.join(home, ".omp", ".env"),
	"~/.omp/agent/.env": () => path.join(agentDir, ".env"),
	"<project>/.env": () => path.join(projectDir, ".env"),
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

/** Whether `stderr` says omp waited on, or passed over, a file. */
function saysNothingAboutFiles(stderr: string): boolean {
	return !stderr.includes("omp is waiting") && !stderr.includes("omp did not");
}

describe.skipIf(process.platform === "win32")("a .env pipe is read until its writer closes it, within a bound", () => {
	for (const [name, at] of Object.entries(ENV_PATHS)) {
		it(
			`${name}, answered by a writer, sets its variables`,
			async () => {
				const writer = answeringWriter(at(), `${VARIABLE}=loaded\n`);
				try {
					const run = await runChild(loadEnvAndPrint(), {});

					expect(run.exit).toBe(0);
					expect(run.stdout).toContain(`${VARIABLE}=loaded`);
					expect(saysNothingAboutFiles(run.stderr)).toBe(true);
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

				const run = await runChild(loadEnvAndPrint(), {});

				expect(run.exit).toBe(0);
				expect(run.stdout).toContain(`${VARIABLE}=unset`);
				const waiting = run.stderr.indexOf(
					`omp is waiting up to ${BOUND} for ${at()}: it is a named pipe, and nothing has written it yet. ` +
						`If 1Password serves it, approve its authorization prompt. Ctrl-C stops omp.`,
				);
				const passedOver = run.stderr.indexOf(
					`omp did not load ${at()}: it is a named pipe, and nothing wrote to it within ${BOUND}, ` +
						`so every variable it sets is unset for this command.`,
				);
				expect(waiting).toBeGreaterThanOrEqual(0);
				expect(passedOver).toBeGreaterThan(waiting);
			},
			TEST_TIMEOUT_MS,
		);
	}

	it(
		"a writer that has not closed the pipe by the bound sets none of its variables",
		async () => {
			const at = path.join(home, ".env");
			// The first line is whole; the writer holds the pipe open and never finishes the second.
			mkfifo(at);
			const fd = fs.openSync(at, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
			fs.writeSync(fd, `${VARIABLE}=loaded\nSECOND=`);
			try {
				const run = await runChild(loadEnvAndPrint(), {});

				expect(run.exit).toBe(0);
				expect(run.stdout).toContain(`${VARIABLE}=unset`);
				const waiting = run.stderr.indexOf(
					`omp is waiting up to ${BOUND} for ${at}: it is a named pipe, and what is writing it has not finished.`,
				);
				const passedOver = run.stderr.indexOf(
					`omp did not load ${at}: it is a named pipe, and what was writing it did not finish within ${BOUND}`,
				);
				expect(waiting).toBeGreaterThanOrEqual(0);
				expect(passedOver).toBeGreaterThan(waiting);
			} finally {
				fs.closeSync(fd);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a writer that sends more than any .env holds sets none of its variables, and is cut off",
		async () => {
			const at = path.join(home, ".env");
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
				const run = await runChild(loadEnvAndPrint(), {});

				expect(run.exit).toBe(0);
				expect(run.stdout).toContain(`${VARIABLE}=unset`);
				expect(run.stderr).toContain(
					`omp did not load ${at}: it is a named pipe, and what was writing it sent more than 1024 KiB, more than a .env file holds`,
				);
			} finally {
				writer.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a regular .env file sets its variables, with nothing said",
		async () => {
			fs.writeFileSync(path.join(home, ".env"), `${VARIABLE}=loaded\n`);

			const run = await runChild(loadEnvAndPrint(), {});

			expect(run.exit).toBe(0);
			expect(run.stdout).toContain(`${VARIABLE}=loaded`);
			expect(saysNothingAboutFiles(run.stderr)).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it.skipIf(process.platform !== "linux" || !Bun.which("script"))(
		"at a terminal the wait is longer, and Ctrl-C ends it at once",
		async () => {
			const at = path.join(home, ".env");
			mkfifo(at);
			const childFile = path.join(tempDir.path(), "child.ts");
			fs.writeFileSync(childFile, `${loadEnvAndPrint()}\nprocess.exit(0);\n`);
			// util-linux `script` runs the child on a pseudo-terminal; a ^C byte written to it
			// is turned into SIGINT for the child by the terminal, as a key press is.
			const child = Bun.spawn(["script", "-qfec", `${process.execPath} --no-env-file ${childFile}`, "/dev/null"], {
				cwd: projectDir,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: childEnv({}),
			});
			const notice = `omp is waiting up to ${envBounds.ENV_PIPE_TERMINAL_DEADLINE_MS / 1000} s for ${at}: it is a named pipe`;
			const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
			let seen = "";
			const noticed = (async () => {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) return false;
					seen += new TextDecoder().decode(value);
					if (seen.includes(notice)) return true;
				}
			})();
			// A real timer: the child's start-up and the terminal are real.
			const sawNotice = await Promise.race([noticed, Bun.sleep(CHILD_DEADLINE_MS).then(() => false)]);
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
			const at = path.join(home, ".env");
			mkfifo(at);
			// The whole file at once, the pipe held open by this test.
			const fd = fs.openSync(at, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
			fs.writeSync(fd, `${VARIABLE}=loaded\n`);
			let closed = false;
			const started = startChild(loadEnvAndPrint());
			try {
				const waiting = await started.saw(`${at}: it is a named pipe, and what is writing it has not finished`);
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
				expect(run.stderr).toContain(
					`omp did not load ${at}: it is a named pipe, and what was writing it did not finish within ${BOUND}`,
				);
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
			const at = path.join(home, ".env");
			mkfifo(at);
			// Opens the pipe at once and answers a second later, after omp has said it is waiting.
			const writer = Bun.spawn(
				["sh", "-c", 'exec 3>"$0"; sleep 1; printf %s "$1" >&3', at, `${VARIABLE}=loaded\n`],
				{ stdout: "ignore", stderr: "ignore" },
			);
			// Added before omp's environment loads, as an embedding program's own listener is.
			const listener = path.join(tempDir.path(), "once-listener.ts");
			fs.writeFileSync(listener, 'export let calls = 0;\nprocess.once("SIGTERM", () => {\n\tcalls++;\n});\n');
			try {
				const run = await runChild(
					`import * as once from ${JSON.stringify(listener)};
				import ${mod("utils", "env.ts")};
				process.emit("SIGTERM");
				process.emit("SIGTERM");
				console.log("calls=" + once.calls + " listeners=" + process.listenerCount("SIGTERM"));
				console.log("${VARIABLE}=" + (process.env.${VARIABLE} ?? "unset"));`,
					{},
				);

				expect(run.exit).toBe(0);
				expect(run.stdout).toContain("calls=1 listeners=0");
				expect(run.stdout).toContain(`${VARIABLE}=loaded`);
				expect(run.stderr).toContain("Ctrl-C takes effect when the wait ends.");
			} finally {
				writer.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a function registered through onStopSignal and process.once keeps its once registration",
		async () => {
			const at = path.join(home, ".env");
			mkfifo(at);
			// Opens the pipe at once and answers a second later, after omp has said it is waiting.
			const writer = Bun.spawn(
				["sh", "-c", 'exec 3>"$0"; sleep 1; printf %s "$1" >&3', at, `${VARIABLE}=loaded\n`],
				{ stdout: "ignore", stderr: "ignore" },
			);
			// The same function has one persistent registration and one once registration.
			const listener = path.join(tempDir.path(), "reused-listener.ts");
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
					`import * as reused from ${JSON.stringify(listener)};
				import ${mod("utils", "env.ts")};
				process.emit("SIGTERM");
				process.emit("SIGTERM");
				console.log("calls=" + reused.calls + " listeners=" + process.listenerCount("SIGTERM"));`,
					{},
				);

				expect(run.exit).toBe(0);
				expect(run.stdout).toContain("calls=1 listeners=0");
				expect(run.stderr).toContain("Ctrl-C takes effect when the wait ends.");
			} finally {
				writer.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a stop signal ends the wait at once when every stop listener was added through onStopSignal",
		async () => {
			mkfifo(path.join(home, ".env"));
			// Added before omp's environment loads, as omp's own crash handler is.
			const listener = path.join(tempDir.path(), "stop-listener.ts");
			fs.writeFileSync(
				listener,
				`import { onStopSignal } from ${mod("utils", "regular-file.ts")};\n` +
					'onStopSignal("SIGTERM", () => {\n\tconsole.log("LISTENER RAN");\n});\n',
			);
			const started = startChild(`import ${JSON.stringify(listener)};\n${loadEnvAndPrint()}`);
			try {
				const waiting = await started.saw("Ctrl-C stops omp.");
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
// shell's environment and for the stream redactor — never wait on a pipe.
describe.skipIf(process.platform === "win32")("a .env re-read while omp runs never waits on a pipe", () => {
	it(
		"a FIFO at a .env file read only for a child shell is refused, not waited on or read",
		async () => {
			const at = path.join(projectDir, ".env.local");
			const fifo = fifoWithInput(at);

			const run = await runChild(
				`import { filterChildShellEnv } from ${mod("utils", "index.ts")};
			filterChildShellEnv(process.env);
			console.log("BUILT");`,
				{},
			);
			const left = fifo.left();

			expect(run.exit).toBe(0);
			expect(run.stdout).toContain("BUILT");
			expect(timesNamed(run.stderr, at)).toBe(1);
			expect(run.stderr).not.toContain("omp is waiting");
			expect(left).toBe(PAYLOAD);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a .env pipe loaded at startup is not read again: a child shell and the redactor use what was loaded",
		async () => {
			// The writer answers once, as at startup, and is gone before the re-reads.
			const writer = answeringWriter(path.join(projectDir, ".env"), `${VARIABLE}=loaded\n`);
			try {
				const run = await runChild(
					`import { filterChildShellEnv, getDotenvEnvValues } from ${mod("utils", "index.ts")};
				console.log("redactor=" + getDotenvEnvValues().includes("loaded"));
				console.log("child=" + (filterChildShellEnv(process.env).${VARIABLE} ?? "absent"));`,
					{},
				);

				expect(run.exit).toBe(0);
				// The redactor knows the value, and the child shell does not inherit it.
				expect(run.stdout).toContain("redactor=true");
				expect(run.stdout).toContain("child=absent");
				expect(saysNothingAboutFiles(run.stderr)).toBe(true);
			} finally {
				writer.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a .env pipe loaded at startup is reused through a symbolic-link alias of the project",
		async () => {
			const alias = path.join(tempDir.path(), "project-link");
			fs.symlinkSync(projectDir, alias);
			// The writer answers once, as at startup, and is gone before the re-reads.
			const writer = answeringWriter(path.join(projectDir, ".env"), `${VARIABLE}=loaded\n`);
			try {
				const run = await runChild(
					`import { filterChildShellEnv, getDotenvEnvValues } from ${mod("utils", "index.ts")};
				console.log("redactor=" + getDotenvEnvValues(${JSON.stringify(alias)}).includes("loaded"));
				console.log("child=" + (filterChildShellEnv(process.env, ${JSON.stringify(alias)}).${VARIABLE} ?? "absent"));`,
					{},
				);

				expect(run.exit).toBe(0);
				expect(run.stdout).toContain("redactor=true");
				expect(run.stdout).toContain("child=absent");
				expect(saysNothingAboutFiles(run.stderr)).toBe(true);
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
			const at = path.join(home, ".env");
			mkfifo(at);
			const loaded = path.join(tempDir.path(), "startup-loaded");
			const reopened = path.join(tempDir.path(), "pipe-reopened");
			// Answers the first reader, as a 1Password mount does. Once startup has loaded,
			// it waits for any second reader, marks that one came, and holds the pipe open
			// without writing, so a second reader would wait out the bound.
			const writer = Bun.spawn(
				[
					"sh",
					"-c",
					'printf %s "$1" > "$0"; while [ ! -e "$2" ]; do sleep 0.05; done; exec 3>"$0"; : > "$3"; exec sleep 60',
					at,
					`${VARIABLE}=loaded\n`,
					loaded,
					reopened,
				],
				{ stdout: "ignore", stderr: "ignore" },
			);
			try {
				const run = await runChild(
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
					{},
				);

				expect(run.exit).toBe(0);
				expect(run.stdout).toContain(`${VARIABLE}=loaded`);
				expect(run.stdout).toContain("reply=true");
				expect(fs.existsSync(reopened)).toBe(false);
				expect(saysNothingAboutFiles(run.stderr)).toBe(true);
			} finally {
				writer.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"run from the home directory, the one .env pipe that is both ~/.env and the project's is read once",
		async () => {
			// The writer answers once, as at startup; a second read would find no writer.
			const writer = answeringWriter(path.join(home, ".env"), `${VARIABLE}=loaded\n`);
			try {
				const run = await runChild(loadEnvAndPrint(), {}, home);

				expect(run.exit).toBe(0);
				expect(run.stdout).toContain(`${VARIABLE}=loaded`);
				expect(saysNothingAboutFiles(run.stderr)).toBe(true);
			} finally {
				writer.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
