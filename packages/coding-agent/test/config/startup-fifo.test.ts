import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

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
const CHILD_DEADLINE_MS = 20_000;
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

/** Run `script` as a module in the project directory; "hung" if it does not finish in time. */
async function runChild(script: string, env: Record<string, string>): Promise<Run> {
	const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `${script}\nprocess.exit(0);`], {
		cwd: projectDir,
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
		it(`${c.name}, with input waiting in it`, async () => {
			const fifo = fifoWithInput(c.at());

			const run = await runChild(c.script(), c.env?.() ?? {});
			const left = fifo.left();

			expectNamed(run, c);
			expect(left).toBe(PAYLOAD);
			expect(fs.lstatSync(c.at()).isFIFO()).toBe(true);
		}, 30_000);

		it(`${c.name}, with nothing writing to it`, async () => {
			mkfifo(c.at());

			const run = await runChild(c.script(), c.env?.() ?? {});

			expectNamed(run, c);
		}, 30_000);
	}

	it("a link to a FIFO is judged by what it leads to", async () => {
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
	}, 30_000);

	it("a FIFO put at a discovery file's name after a look at it is still not read", async () => {
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
	}, 30_000);
});

// A `.env` is the one file a tool serves through a named pipe on purpose:
// 1Password mounts `.env` files that way, and writes the file when a reader
// opens it. So a pipe at a `.env` path is read, but only to its end within a
// bound, and never in part; with nothing writing it, the command goes on
// without it after the bound and says that its variables are unset.
const ENV_PATHS = {
	"~/.env": () => path.join(home, ".env"),
	"~/.omp/.env": () => path.join(home, ".omp", ".env"),
	"~/.omp/agent/.env": () => path.join(agentDir, ".env"),
	"<project>/.env": () => path.join(projectDir, ".env"),
};
const VARIABLE = "STARTUP_FIFO_PROBE";

/** The child loads omp's environment as every command does, then prints what the probe variable holds. */
const loadEnvAndPrint = (): string =>
	`import ${mod("utils", "index.ts")};
	console.log("${VARIABLE}=" + (process.env.${VARIABLE} ?? "unset"));`;

/** A writer that waits for a reader to open `target`, writes `text` and closes it, as a 1Password mount does. */
function answeringWriter(target: string, text: string): Bun.Subprocess {
	mkfifo(target);
	return Bun.spawn(["sh", "-c", 'printf %s "$1" > "$0"', target, text], { stdout: "ignore", stderr: "ignore" });
}

describe.skipIf(process.platform === "win32")("a named pipe at a .env path is read to its end, within a bound", () => {
	for (const [name, at] of Object.entries(ENV_PATHS)) {
		it(`${name}, answered by a writer, sets its variables`, async () => {
			const writer = answeringWriter(at(), `${VARIABLE}=loaded\n`);
			try {
				const run = await runChild(loadEnvAndPrint(), {});

				expect(run.exit).toBe(0);
				expect(run.stdout).toContain(`${VARIABLE}=loaded`);
				expect(run.stderr).not.toContain("omp did not load");
			} finally {
				writer.kill();
			}
		}, 30_000);

		it(`${name}, with nothing writing to it, is passed over after the bound with its variables unset`, async () => {
			mkfifo(at());

			const run = await runChild(loadEnvAndPrint(), {});

			expect(run.exit).toBe(0);
			expect(run.stdout).toContain(`${VARIABLE}=unset`);
			const waiting = run.stderr.indexOf(`omp is waiting up to 10 s for ${at()}: it is a named pipe`);
			const passedOver = run.stderr.indexOf(
				`omp did not load ${at()}: it is a named pipe, and nothing wrote to it within 10 s, so every variable it sets is unset`,
			);
			expect(waiting).toBeGreaterThanOrEqual(0);
			expect(passedOver).toBeGreaterThan(waiting);
		}, 30_000);
	}

	it("a writer that stops before the end of the file sets none of its variables", async () => {
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
				`omp is waiting up to 10 s for ${at}: it is a named pipe (1Password mounts .env files this way), and what is writing it has not finished`,
			);
			const passedOver = run.stderr.indexOf(
				`omp did not load ${at}: it is a named pipe, and what was writing it stopped before the end within 10 s`,
			);
			expect(waiting).toBeGreaterThanOrEqual(0);
			expect(passedOver).toBeGreaterThan(waiting);
		} finally {
			fs.closeSync(fd);
		}
	}, 30_000);

	it("a regular .env file sets its variables, with nothing said", async () => {
		fs.writeFileSync(path.join(home, ".env"), `${VARIABLE}=loaded\n`);

		const run = await runChild(loadEnvAndPrint(), {});

		expect(run.exit).toBe(0);
		expect(run.stdout).toContain(`${VARIABLE}=loaded`);
		expect(run.stderr).toBe("");
	}, 30_000);
});
