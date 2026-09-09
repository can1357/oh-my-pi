import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import {
	__resetProfileSnapshotForTests,
	APP_NAME,
	getActiveProfile,
	getAgentDbPath,
	getAgentDir,
	setAgentDir,
	setProfile,
	VERSION,
} from "@oh-my-pi/pi-utils/dirs";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { runCli } from "../src/cli";
import * as profileAliasCli from "../src/cli/profile-alias";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

describe("global --profile flag", () => {
	let configDir = "";
	let originalProfile: string | undefined;
	let originalAgentDir = "";
	let originalAgentDirEnv: string | undefined;
	let originalOmpProfileEnv: string | undefined;
	let originalPiProfileEnv: string | undefined;
	let originalConfigDir: string | undefined;

	beforeEach(() => {
		originalProfile = getActiveProfile();
		originalAgentDir = getAgentDir();
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfileEnv = process.env.OMP_PROFILE;
		originalPiProfileEnv = process.env.PI_PROFILE;
		originalConfigDir = process.env.PI_CONFIG_DIR;
		configDir = `.omp-profile-cli-test-${Snowflake.next()}`;
		process.env.PI_CONFIG_DIR = configDir;
		process.exitCode = 0;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProfile(undefined);
		if (originalConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalConfigDir;
		}
		if (originalProfile) {
			setProfile(originalProfile);
		} else if (originalAgentDirEnv !== undefined) {
			setAgentDir(originalAgentDir);
		} else {
			setProfile(undefined);
		}
		if (originalOmpProfileEnv === undefined) {
			delete process.env.OMP_PROFILE;
		} else {
			process.env.OMP_PROFILE = originalOmpProfileEnv;
		}
		if (originalPiProfileEnv === undefined) {
			delete process.env.PI_PROFILE;
		} else {
			process.env.PI_PROFILE = originalPiProfileEnv;
		}
		if (originalAgentDirEnv === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
		}
		__resetProfileSnapshotForTests();
		process.exitCode = 0;
		await removeWithRetries(path.join(os.homedir(), configDir));
	});

	it("activates a profile before dispatching root flags", async () => {
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["--profile=work", "--version"]);

		expect(process.exitCode).toBe(0);
		expect(writeSpy).toHaveBeenCalled();
		expect(getActiveProfile()).toBe("work");
		expect(getAgentDir()).toBe(path.join(os.homedir(), configDir, "profiles", "work", "agent"));
	});

	it("activates a profile inherited from OMP_PROFILE at run time", async () => {
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		setProfile(undefined);
		process.env.OMP_PROFILE = "work";
		delete process.env.PI_PROFILE;

		await runCli(["--version"]);

		expect(process.exitCode).toBe(0);
		expect(writeSpy).toHaveBeenCalled();
		expect(getActiveProfile()).toBe("work");
		expect(getAgentDir()).toBe(path.join(os.homedir(), configDir, "profiles", "work", "agent"));
		expect(getAgentDbPath()).toBe(path.join(os.homedir(), configDir, "profiles", "work", "agent", "agent.db"));
	});

	it("accepts the profile flag after other root flags", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["--version", "--profile", "office"]);

		expect(process.exitCode).toBe(0);
		expect(getActiveProfile()).toBe("office");
		expect(getAgentDir()).toBe(path.join(os.homedir(), configDir, "profiles", "office", "agent"));
	});

	it("installs a shell alias and exits before command dispatch", async () => {
		const installSpy = vi.spyOn(profileAliasCli, "installProfileAlias").mockResolvedValue({
			shell: "bash",
			configPath: "/home/me/.bashrc",
			aliasName: "omp-work",
			profile: "work",
			command: "omp --profile=work",
			reloadedWith: ". '/home/me/.bashrc'",
		});
		const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["--profile", "work", "--alias", "omp-work", "--version"]);

		expect(process.exitCode).toBe(0);
		expect(installSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: "work",
				aliasName: "omp-work",
			}),
		);
		const output = outSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n");
		expect(output).toContain("Created omp-work");
		expect(output).not.toContain(`${APP_NAME}/${VERSION}`);
	});

	it("installs a shell alias when launch is explicit", async () => {
		const installSpy = vi.spyOn(profileAliasCli, "installProfileAlias").mockResolvedValue({
			shell: "bash",
			configPath: "/home/me/.bashrc",
			aliasName: "omp-work",
			profile: "work",
			command: "omp --profile=work",
			reloadedWith: ". '/home/me/.bashrc'",
		});
		const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["launch", "--profile", "work", "--alias", "omp-work", "--version"]);

		expect(process.exitCode).toBe(0);
		expect(installSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: "work",
				aliasName: "omp-work",
			}),
		);
		const output = outSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n");
		expect(output).toContain("Created omp-work");
		expect(output).not.toContain(`${APP_NAME}/${VERSION}`);
	});

	it("installs a shell alias when acp is explicit", async () => {
		const installSpy = vi.spyOn(profileAliasCli, "installProfileAlias").mockResolvedValue({
			shell: "bash",
			configPath: "/home/me/.bashrc",
			aliasName: "omp-work",
			profile: "work",
			command: "omp --profile=work",
			reloadedWith: ". '/home/me/.bashrc'",
		});
		const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["acp", "--profile", "work", "--alias", "omp-work", "--version"]);

		expect(process.exitCode).toBe(0);
		expect(installSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				profile: "work",
				aliasName: "omp-work",
			}),
		);
		expect(getActiveProfile()).toBe("work");
		const output = outSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n");
		expect(output).toContain("Created omp-work");
		expect(output).not.toContain(`${APP_NAME}/${VERSION}`);
	});

	it("rejects missing profile values without dispatching", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await runCli(["--profile", "--version"]);

		expect(process.exitCode).toBe(1);
		expect(errSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n")).toContain(
			"--profile requires a profile name",
		);
		expect(outSpy).not.toHaveBeenCalled();
	});

	it("loads profile agent .env before command modules import pi-utils env", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-cli-env-"));
		try {
			const home = path.join(root, "home");
			const configDir = ".omp-profile-cli-env";
			const defaultAgentDir = path.join(home, configDir, "agent");
			const profileAgentDir = path.join(home, configDir, "profiles", "work", "agent");
			await fs.mkdir(defaultAgentDir, { recursive: true });
			await fs.mkdir(profileAgentDir, { recursive: true });
			await Bun.write(path.join(defaultAgentDir, ".env"), "OMP_PROFILE_BOOTSTRAP_SENTINEL=default\n");
			await Bun.write(path.join(profileAgentDir, ".env"), "OMP_PROFILE_BOOTSTRAP_SENTINEL=work\n");

			const probePath = path.join(root, "probe.ts");
			await Bun.write(
				probePath,
				[
					`import { runCli } from ${JSON.stringify(url.pathToFileURL(cliEntry).href)};`,
					'await runCli(["--profile", "work", "--help"]);',
					'process.stdout.write("\\nSENTINEL=" + (Bun.env.OMP_PROFILE_BOOTSTRAP_SENTINEL ?? ""));',
				].join("\n"),
			);

			const childEnv: Record<string, string | undefined> = {
				...process.env,
				HOME: home,
				PI_CONFIG_DIR: configDir,
				PI_NO_TITLE: "1",
				NO_COLOR: "1",
			};
			delete childEnv.OMP_PROFILE;
			delete childEnv.PI_PROFILE;
			delete childEnv.PI_CODING_AGENT_DIR;
			delete childEnv.OMP_PROFILE_BOOTSTRAP_SENTINEL;

			const proc = Bun.spawn([process.execPath, probePath], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: childEnv,
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				readStream(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);

			expect(exitCode, stderr).toBe(0);
			expect(stdout).toContain("SENTINEL=work");
			expect(stdout).not.toContain("SENTINEL=default");
		} finally {
			await removeWithRetries(root);
		}
		// Spawns a probe that imports the command modules, so the cost is cold
		// transpile of the CLI graph, not latency under test.
	}, 30_000);

	it("surfaces an invalid OMP_PROFILE env as a clean error, not an import crash", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-cli-env-bad-"));
		try {
			const home = path.join(root, "home");
			await fs.mkdir(home, { recursive: true });

			const probePath = path.join(root, "probe.ts");
			await Bun.write(
				probePath,
				[
					`import { runCli } from ${JSON.stringify(url.pathToFileURL(cliEntry).href)};`,
					'await runCli(["--version"]);',
					// Reached only if the module import did NOT throw — i.e. the invalid
					// env was deferred to runCli's error handler instead of crashing the
					// process during the static import of dirs.ts.
					'process.stdout.write("HANDLED");',
				].join("\n"),
			);

			const childEnv: Record<string, string | undefined> = {
				...process.env,
				HOME: home,
				PI_CONFIG_DIR: ".omp-profile-cli-env-bad",
				OMP_PROFILE: "..",
				NO_COLOR: "1",
			};
			delete childEnv.PI_PROFILE;
			delete childEnv.PI_CODING_AGENT_DIR;

			const proc = Bun.spawn([process.execPath, probePath], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: childEnv,
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				readStream(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);

			expect(stdout, stderr).toContain("HANDLED");
			expect(stderr).toContain("Invalid OMP profile");
			expect(exitCode).toBe(1);
		} finally {
			await removeWithRetries(root);
		}
		// Same cold-spawn cost as the sibling above; it only escapes Bun's 5s
		// default because that test warms the transpile cache first.
	}, 30_000);
});
