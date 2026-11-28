import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// An id the startup catalog lacks may still come from an extension or account
// discovery, so `--provider p --model id` defers like `--model p/id` instead of
// exiting before either has run.
describe("--provider with a model the startup catalog lacks", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `pi-cli-provider-deferral-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function deferredPattern(cliArgs: string[]): Promise<string | string[] | undefined> {
		authStorage.keys.setRuntime("anthropic", "test-key");
		vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions exited with ${code}`);
		});
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const options = await buildSessionOptions(
			parseArgs(cliArgs),
			[],
			SessionManager.inMemory(),
			modelRegistry,
			Settings.isolated(),
		);
		return options.modelPattern;
	}

	test("defers the provider-qualified selector to post-extension resolution", async () => {
		expect(await deferredPattern(["--provider", "anthropic", "--model", "claude-unreleased-9"])).toBe(
			"anthropic/claude-unreleased-9",
		);
	});

	test("does not double the provider prefix", async () => {
		expect(await deferredPattern(["--provider", "anthropic", "--model", "anthropic/claude-unreleased-9"])).toBe(
			"anthropic/claude-unreleased-9",
		);
	});

	test("defers a discovery provider that holds no models until its refresh", async () => {
		const hasProvider = modelRegistry.hasProvider.bind(modelRegistry);
		vi.spyOn(modelRegistry, "hasProvider").mockImplementation(id => id === "proxy" || hasProvider(id));
		expect(await deferredPattern(["--provider", "proxy", "--model", "some-model"])).toBe("proxy/some-model");
	});
});

describe("print-mode suggestions for a provider-qualified miss", () => {
	test("never lists other providers' models", async () => {
		const home = path.join(os.tmpdir(), `pi-cli-qualified-hint-${Snowflake.next()}`);
		fs.mkdirSync(home, { recursive: true });
		try {
			const proc = spawnPrintCli(home, ["--provider", "anthropic", "--model", "gpt-4o", "hi"], {
				ANTHROPIC_API_KEY: "test-key",
				OPENAI_API_KEY: "test-key",
			});
			const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
			expect(exitCode).toBe(1);
			expect(stderr).toContain('Model "anthropic/gpt-4o" not found');
			expect(stderr).not.toContain("openai/");
		} finally {
			removeSyncWithRetries(home);
		}
	}, 60_000);
});

describe("print mode with a stale configured default", () => {
	test("warns on stderr naming the stale default and the model that runs instead", async () => {
		const home = path.join(os.tmpdir(), `pi-cli-stale-default-${Snowflake.next()}`);
		const agentDir = path.join(home, ".omp", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			"modelRoles:\n  default: anthropic/claude-sonnet-9-9\nretry:\n  enabled: false\n",
		);
		try {
			// The fallback model's request fails at the dead proxy; the test stops the run once the warning is out.
			const proc = spawnPrintCli(home, ["hi"], { ANTHROPIC_API_KEY: "test-key" });
			const warning = "Default model anthropic/claude-sonnet-9-9 not found. Using anthropic/";
			const stderr = await readUntil(proc.stderr, warning);
			proc.kill();
			await proc.exited;
			expect(stderr).toContain(warning);
		} finally {
			removeSyncWithRetries(home);
		}
	}, 60_000);
});

/** Closed local port: every request through it is refused at once. */
const DEAD_PROXY = "http://127.0.0.1:9";

/**
 * `omp -p` in an isolated `home`. A missed selector or stale default awaits one
 * online discovery pass over every provider catalog before it reports; routing
 * all requests through a dead proxy fails that pass at once, so resolution runs
 * against the bundled catalog instead of waiting on the network.
 */
function spawnPrintCli(home: string, args: string[], env: Record<string, string>) {
	return Bun.spawn(
		[
			process.execPath,
			path.resolve(import.meta.dir, "../src/cli.ts"),
			"--no-title",
			"--no-lsp",
			"--no-extensions",
			"--no-tools",
			"--no-session",
			"-p",
			...args,
		],
		{
			cwd: home,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				USERPROFILE: home,
				TMPDIR: process.env.TMPDIR,
				NO_COLOR: "1",
				HTTP_PROXY: DEAD_PROXY,
				HTTPS_PROXY: DEAD_PROXY,
				// Test runtime: keeps the child off the OS keychain.
				PI_TEST_RUNTIME: "1",
				...env,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
}

/** Stderr read until it contains `needle`, or all of it once the stream ends without it. */
async function readUntil(stream: ReadableStream<Uint8Array>, needle: string): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (!text.includes(needle)) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
	return text;
}
