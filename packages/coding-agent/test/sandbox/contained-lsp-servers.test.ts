/**
 * Language servers and the CLI tools the LSP subsystem runs from the workspace (Biome, SwiftLint,
 * the workspace checkers) under the OS sandbox: while it applies (the `lsp` scope, independent of
 * `sandbox.scope`), every server starts contained, bypassing the shared daemon and the external
 * lspmux wrapper, and every tool runs contained, so neither can write outside the writable roots. A
 * server started under another containment is never reused, and config loading never runs the
 * workspace `tsc` while the sandbox is on. Without a backend, `fallback: block` refuses to start any
 * of them and `fallback: warn` runs them as before; with the sandbox off nothing changes. The
 * contained cases skip where no backend exists.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { execContained } from "@oh-my-pi/pi-coding-agent/exec/exec";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import { BiomeClient } from "@oh-my-pi/pi-coding-agent/lsp/clients/biome-client";
import { SwiftLintClient } from "@oh-my-pi/pi-coding-agent/lsp/clients/swiftlint-client";
import { loadConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";
import * as lspmux from "@oh-my-pi/pi-coding-agent/lsp/lspmux";
import * as daemon from "@oh-my-pi/pi-coding-agent/daemon/client";
import type { LinterClient, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { runWorkspaceDiagnostics } from "@oh-my-pi/pi-coding-agent/lsp/workspace-diagnostics";
import { SandboxRuntime, SandboxUnavailableError } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import {
	cfgSandboxDenyRead,
	cfgSandboxEnabled,
	cfgSandboxFallback,
	cfgSandboxNetworkMode,
	cfgSandboxScope,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import * as natives from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { CONTAINED_SOURCE_RUNS, failure, SANDBOX_UNAVAILABLE } from "../helpers/sandbox-test-state";
import {
	beginSettingsTest,
	restoreEnvValue,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../helpers/settings-test-state";

const supported =
	typeof natives.sandboxSupport === "function" &&
	typeof natives.SandboxProcess === "function" &&
	natives.sandboxSupport().supported;
/** The stubs are shell scripts. */
const posix = process.platform !== "win32";

/**
 * A minimal language server. At start it tries to write `<outside>/escaped` and records the
 * outcome, and `OMP_SANDBOX`, in the workspace; then it answers requests (`initialize` with no
 * capabilities). Mode `fail` writes to stderr and exits 3 on `initialize` instead; mode `slow`
 * answers `shutdown` only after 500 ms.
 */
const STUB_SERVER = String.raw`
const fs = require("node:fs");
const [mode, workspace, outside] = process.argv.slice(2);
let outcome = "written";
try {
	fs.writeFileSync(outside + "/escaped", "x");
} catch (error) {
	outcome = String(error.code);
}
fs.writeFileSync(workspace + "/outside-write", outcome);
fs.writeFileSync(workspace + "/omp-sandbox", process.env.OMP_SANDBOX ?? "");
let buffer = Buffer.alloc(0);
process.stdin.on("data", chunk => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const end = buffer.indexOf("\r\n\r\n");
		if (end < 0) return;
		const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
		if (buffer.length < end + 4 + length) return;
		const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
		buffer = buffer.subarray(end + 4 + length);
		if (message.method === "initialize" && mode === "fail") {
			process.stderr.write("stub server: refusing to start\n");
			process.exit(3);
		}
		if (message.method === "exit") process.exit(0);
		if (message.id === undefined || message.method === undefined) continue;
		const json = JSON.stringify({
			jsonrpc: "2.0",
			id: message.id,
			result: message.method === "initialize" ? { capabilities: {} } : null,
		});
		const reply = () => process.stdout.write("Content-Length: " + Buffer.byteLength(json) + "\r\n\r\n" + json);
		// A real delay: the stub is a separate process, out of reach of fake timers.
		if (mode === "slow" && message.method === "shutdown") setTimeout(reply, 500);
		else reply();
	}
});
`;

let state: SettingsTestState | undefined;
let settings: Settings;
let scratch: TempDir;
/** `<scratch>/workspace`, realpath'd. */
let workspace: string;
/** `<scratch>/outside`: neither the workspace nor the (spied) tmpdir, so read-only when contained. */
let outside: string;
/** The daemon connection a shared-server attach starts with; it refuses, so the spawn stays private. */
let connectShared: Mock<typeof daemon.daemonClient>;
let lspmuxCommand: Mock<typeof lspmux.getLspmuxCommand>;
let shared: { release(): void } | undefined;

function writeExecutable(file: string, content: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, { mode: 0o755 });
	return file;
}

/** A `rust-analyzer` (an lspmux-supported name) that runs {@link STUB_SERVER} in `mode`. */
function stubServer(mode: "ok" | "fail" | "slow"): ServerConfig {
	const script = writeExecutable(path.join(workspace, "stub-server.cjs"), STUB_SERVER);
	const wrapper = writeExecutable(
		path.join(workspace, "bin", "rust-analyzer"),
		`#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
	);
	return {
		command: "rust-analyzer",
		resolvedCommand: wrapper,
		args: [mode, workspace, outside],
		fileTypes: [".rs"],
		rootMarkers: [],
		watchFiles: false,
	};
}

function readMarker(name: string): string | undefined {
	const file = path.join(workspace, name);
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
}

/**
 * A workspace tool at `file` whose every run first tries to write `<outside>/<name>-escaped`, records
 * `OMP_SANDBOX` in `<workspace>/<name>-ran`, then runs `body`.
 */
function plantTool(file: string, name: string, body: string): string {
	return writeExecutable(
		file,
		`#!/bin/sh\necho x > "${outside}/${name}-escaped" 2>/dev/null\nprintf '%s' "$OMP_SANDBOX" > "${workspace}/${name}-ran"\n${body}\n`,
	);
}

function escaped(name: string): boolean {
	return fs.existsSync(path.join(outside, `${name}-escaped`));
}

/** A {@link plantTool} `biome` running `body`. */
function biome(body: string): BiomeClient {
	const command = plantTool(path.join(workspace, "node_modules", ".bin", "biome"), "biome", body);
	return new BiomeClient({ command: "biome", resolvedCommand: command, fileTypes: [], rootMarkers: [] }, workspace);
}

/** A {@link plantTool} `swiftlint` reporting no violations. */
function swiftlint(): LinterClient {
	const command = plantTool(path.join(workspace, "bin", "swiftlint"), "swiftlint", "printf '[]'");
	return SwiftLintClient.create(
		{ command: "swiftlint", resolvedCommand: command, fileTypes: [], rootMarkers: [] },
		workspace,
	);
}

/**
 * A TypeScript workspace whose checker (`npx tsc --noEmit`) is a {@link plantTool} `tsc` in
 * `node_modules/.bin` reporting one error; `npx` is a stub first on `PATH` that runs it.
 */
function plantTypescriptCheck(): void {
	fs.writeFileSync(path.join(workspace, "tsconfig.json"), "{}");
	plantTool(path.join(workspace, "node_modules", ".bin", "tsc"), "tsc", "echo 'a.ts(1,1): error TS1: stub'\nexit 2");
	writeExecutable(
		path.join(workspace, "bin", "npx"),
		`#!/bin/sh\ntool="$1"\nshift\nexec "./node_modules/.bin/$tool" "$@"\n`,
	);
	process.env.PATH = `${path.join(workspace, "bin")}${path.delimiter}${process.env.PATH ?? ""}`;
}

beforeEach(async () => {
	state = beginSettingsTest();
	restoreEnvValue("PI_SANDBOX", undefined);
	// Not under the OS temp dir: on Linux the sandbox hides the host's /tmp, so `outside` would be
	// invisible to contained processes rather than read-only.
	scratch = TempDir.createSync(path.join(os.homedir(), ".omp-contained-lsp-servers-"));
	const root = fs.realpathSync(scratch.path());
	workspace = path.join(root, "workspace");
	outside = path.join(root, "outside");
	const tmp = path.join(root, "tmp");
	for (const dir of [workspace, outside, tmp]) fs.mkdirSync(dir);
	// The sandbox always grants tmpdir; keep it away from the workspace and `outside`.
	vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
	settings = await Settings.init({ inMemory: true, cwd: workspace });
	cfgSandboxNetworkMode.set(settings, "deny");
	SandboxRuntime.resetForTest();
	// The shared daemon and lspmux paths are observed, never started: the uncontained spawn stays private.
	shared = lspClient.holdSharedLsp(true);
	connectShared = vi.spyOn(daemon, "daemonClient").mockRejectedValue(new Error("no daemon in this test"));
	lspmuxCommand = vi
		.spyOn(lspmux, "getLspmuxCommand")
		.mockImplementation(async (command: string, args?: string[]) => ({ command, args: args ?? [] }));
});

afterEach(async () => {
	try {
		await lspClient.shutdownAll();
		shared?.release();
		shared = undefined;
		await (await SandboxRuntime.for(workspace)).dispose();
		SandboxRuntime.resetForTest();
	} finally {
		vi.restoreAllMocks();
		restoreSettingsTestState(state);
		state = undefined;
		scratch.removeSync();
	}
});

describe.skipIf(!posix)("language servers without an applying sandbox", () => {
	it("start uncontained through lspmux and the shared daemon, as before, with the sandbox off", async () => {
		const client = await lspClient.getOrCreateClient(stubServer("ok"), workspace, 10_000);

		expect(client.status).toBe("ready");
		expect(lspmuxCommand).toHaveBeenCalled();
		expect(connectShared).toHaveBeenCalled();
		expect(readMarker("outside-write")).toBe("written");
		expect(fs.existsSync(path.join(outside, "escaped"))).toBe(true);
		expect(readMarker("omp-sandbox")).toBe("");
	});

	it("refuse to start under fallback block without a backend, and start once fallback is warn", async () => {
		cfgSandboxEnabled.set(settings, true);
		cfgSandboxFallback.set(settings, "block");
		SandboxRuntime.resetForTest(SANDBOX_UNAVAILABLE);
		const config = stubServer("ok");

		const error = await failure(lspClient.getOrCreateClient(config, workspace, 10_000));

		expect(error).toBeInstanceOf(SandboxUnavailableError);
		expect(readMarker("outside-write")).toBeUndefined();
		expect(lspmuxCommand).not.toHaveBeenCalled();
		expect(connectShared).not.toHaveBeenCalled();

		// The refusal left no stuck start behind: under `warn` the same server starts, uncontained.
		cfgSandboxFallback.set(settings, "warn");
		const client = await lspClient.getOrCreateClient(config, workspace, 10_000);

		expect(client.status).toBe("ready");
		expect(readMarker("outside-write")).toBe("written");
		expect(connectShared).toHaveBeenCalled();
	});

	it("run Biome, SwiftLint and the workspace checkers uncontained, as before, with the sandbox off", async () => {
		plantTypescriptCheck();

		expect(await biome(`printf '{"diagnostics":[]}'`).lint(path.join(workspace, "a.ts"))).toEqual([]);
		expect(await swiftlint().lint(path.join(workspace, "a.swift"))).toEqual([]);
		expect((await runWorkspaceDiagnostics(workspace)).output).toContain("error TS1: stub");

		for (const tool of ["biome", "swiftlint", "tsc"]) {
			expect(readMarker(`${tool}-ran`)).toBe("");
			expect(escaped(tool)).toBe(true);
		}
	});

	it("refuse Biome, SwiftLint and the workspace checkers under fallback block", async () => {
		cfgSandboxEnabled.set(settings, true);
		cfgSandboxFallback.set(settings, "block");
		SandboxRuntime.resetForTest(SANDBOX_UNAVAILABLE);
		plantTypescriptCheck();
		const biomeClient = biome(`printf '{"diagnostics":[]}'`);
		const swiftlintClient = swiftlint();

		expect(await failure(biomeClient.lint(path.join(workspace, "a.ts")))).toBeInstanceOf(SandboxUnavailableError);
		expect(await failure(swiftlintClient.lint(path.join(workspace, "a.swift")))).toBeInstanceOf(
			SandboxUnavailableError,
		);
		expect(await failure(runWorkspaceDiagnostics(workspace))).toBeInstanceOf(SandboxUnavailableError);
		for (const tool of ["biome", "swiftlint", "tsc"]) expect(readMarker(`${tool}-ran`)).toBeUndefined();
	});

	describe("TypeScript server selection outside an npm layout", () => {
		/** A workspace `tsc` claiming TypeScript 7, with no package around it, so only running it tells its version. */
		function plantTsc(): void {
			fs.writeFileSync(path.join(workspace, "package.json"), "{}");
			plantTool(path.join(workspace, "node_modules", ".bin", "tsc"), "tsc", "echo 'Version 7.0.2'");
		}

		it("asks the workspace tsc for its version with the sandbox off", () => {
			plantTsc();

			expect(Object.keys(loadConfig(workspace).servers)).toContain("typescript-native");
			expect(readMarker("tsc-ran")).toBe("");
		});

		it("never runs the workspace tsc while the sandbox is on, treating its version as unknown", () => {
			cfgSandboxEnabled.set(settings, true);
			plantTsc();

			expect(Object.keys(loadConfig(workspace).servers)).not.toContain("typescript-native");
			expect(readMarker("tsc-ran")).toBeUndefined();
			expect(escaped("tsc")).toBe(false);
		});
	});
});

describe.skipIf(!supported || !posix || !CONTAINED_SOURCE_RUNS)("language servers in the sandbox", () => {
	beforeEach(() => {
		cfgSandboxEnabled.set(settings, true);
		// Servers are contained whatever `sandbox.scope` lists.
		cfgSandboxScope.set(settings, ["bash"]);
	});

	it("start contained, bypassing lspmux and the shared daemon, and cannot write outside", async () => {
		const client = await lspClient.getOrCreateClient(stubServer("ok"), workspace, 10_000);

		expect(client.status).toBe("ready");
		expect(client.proc.sharedMux).toBeFalsy();
		expect(lspmuxCommand).not.toHaveBeenCalled();
		expect(connectShared).not.toHaveBeenCalled();
		expect(readMarker("omp-sandbox")).toBe("1");
		expect(readMarker("outside-write")).not.toBe("written");
		expect(fs.existsSync(path.join(outside, "escaped"))).toBe(false);
	});

	it("report a contained server's stderr when it exits during initialize", async () => {
		const error = await failure(lspClient.getOrCreateClient(stubServer("fail"), workspace, 10_000));

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("stub server: refusing to start");
		expect((error as Error).message).toContain("code 3");
		expect(readMarker("omp-sandbox")).toBe("1");
	});

	it("replace a server started before the sandbox applied instead of reusing it", async () => {
		cfgSandboxEnabled.set(settings, false);
		const config = stubServer("ok");
		const uncontained = await lspClient.getOrCreateClient(config, workspace, 10_000);
		expect(readMarker("omp-sandbox")).toBe("");

		cfgSandboxEnabled.set(settings, true);
		const client = await lspClient.getOrCreateClient(config, workspace, 10_000);

		expect(client).not.toBe(uncontained);
		expect(uncontained.proc.exitCode).not.toBeNull();
		expect(readMarker("omp-sandbox")).toBe("1");
		expect(readMarker("outside-write")).not.toBe("written");
	});

	it("return no client from getActiveOrPendingClient for a server started before the sandbox applied", async () => {
		cfgSandboxEnabled.set(settings, false);
		const config = stubServer("ok");
		const uncontained = await lspClient.getOrCreateClient(config, workspace, 10_000);

		cfgSandboxEnabled.set(settings, true);

		expect(await lspClient.getActiveOrPendingClient(config, workspace)).toBeUndefined();
		expect(uncontained.proc.exitCode).not.toBeNull();
	});

	it("replace a server still starting from before the sandbox applied instead of joining its start", async () => {
		cfgSandboxEnabled.set(settings, false);
		const config = stubServer("ok");
		const reached = Promise.withResolvers<void>();
		connectShared.mockImplementation(async () => {
			reached.resolve();
			throw new Error("no daemon in this test");
		});
		const starting = lspClient.getOrCreateClient(config, workspace, 10_000);
		// The uncontained start holds its lock once it asks the shared daemon.
		await reached.promise;

		cfgSandboxEnabled.set(settings, true);
		const client = await lspClient.getOrCreateClient(config, workspace, 10_000);
		const uncontained = await starting;

		expect(client).not.toBe(uncontained);
		expect(client.status).toBe("ready");
		expect(uncontained.proc.exitCode).not.toBeNull();
		expect(readMarker("omp-sandbox")).toBe("1");
	});

	it("start the replacement only after the stale server exited, however many callers find it", async () => {
		cfgSandboxEnabled.set(settings, false);
		const config = stubServer("slow");
		const uncontained = await lspClient.getOrCreateClient(config, workspace, 10_000);
		let exitedAt = Number.POSITIVE_INFINITY;
		void uncontained.proc.exited.then(() => {
			exitedAt = Date.now();
		});

		cfgSandboxEnabled.set(settings, true);
		const active = lspClient.getActiveOrPendingClient(config, workspace);
		const created = lspClient.getOrCreateClient(config, workspace, 10_000);

		expect(await active).toBeUndefined();
		const client = await created;
		expect(client.status).toBe("ready");
		expect(client.startedAt).toBeGreaterThanOrEqual(exitedAt);
	});

	it("start under the policy current after waiting for a stale server, not the one it found", async () => {
		const config = stubServer("slow");
		await lspClient.getOrCreateClient(config, workspace, 10_000);
		cfgSandboxEnabled.set(settings, false);
		const created = lspClient.getOrCreateClient(config, workspace, 10_000);
		// Resolves once `created` is waiting for the contained server's (slow) shutdown.
		expect(await lspClient.getActiveOrPendingClient(config, workspace)).toBeUndefined();

		cfgSandboxEnabled.set(settings, true);
		const client = await created;

		expect(client.status).toBe("ready");
		expect(readMarker("omp-sandbox")).toBe("1");
		expect(connectShared).not.toHaveBeenCalled();
	});

	it("let a start that failed before its server ran be retried", async () => {
		const config = stubServer("ok");
		const wrapper = config.resolvedCommand as string;
		fs.renameSync(wrapper, `${wrapper}.off`);

		const error = await failure(lspClient.getOrCreateClient(config, workspace, 10_000));

		expect(String(error)).toContain("LSP server command not found");
		fs.renameSync(`${wrapper}.off`, wrapper);
		const client = await lspClient.getOrCreateClient(config, workspace, 10_000);
		expect(client.status).toBe("ready");
	});

	it("run SwiftLint and the workspace checkers contained, so their writes outside are refused", async () => {
		plantTypescriptCheck();

		expect(await swiftlint().lint(path.join(workspace, "a.swift"))).toEqual([]);
		expect((await runWorkspaceDiagnostics(workspace)).output).toContain("error TS1: stub");
		for (const tool of ["swiftlint", "tsc"]) {
			expect(readMarker(`${tool}-ran`)).toBe("1");
			expect(escaped(tool)).toBe(false);
		}
	});

	it("kill a contained run whose abort fired while it was spawning", async () => {
		const controller = new AbortController();
		const runtime = await SandboxRuntime.for(workspace);
		const run = execContained(runtime, ["sleep", "30"], {
			cwd: workspace,
			signal: controller.signal,
		});
		controller.abort();

		const result = await run;

		expect(result.killed).toBe(true);
		expect(result.code).toBe(-1);
	}, 10_000);
});

describe.skipIf(!supported || !posix || !CONTAINED_SOURCE_RUNS)("biome in the sandbox", () => {
	beforeEach(() => {
		cfgSandboxEnabled.set(settings, true);
	});

	it("formats and lints contained, so its writes outside are refused", async () => {
		const client = biome(
			`case "$1" in\n format) printf 'formatted\\n' > "$3" ;;\n lint) printf '{"diagnostics":[]}' ;;\nesac`,
		);
		const file = path.join(workspace, "a.ts");

		expect(await client.format(file, "const a=1")).toBe("formatted\n");
		expect(fs.readFileSync(file, "utf8")).toBe("formatted\n");
		expect(await client.lint(file)).toEqual([]);
		expect(fs.existsSync(path.join(outside, "biome-escaped"))).toBe(false);
	}, 20_000);

	it("reads the formatted file back contained, never through a symlink it swapped in", async () => {
		const secret = path.join(outside, "secret.txt");
		fs.writeFileSync(secret, "TOP SECRET");
		cfgSandboxDenyRead.set(settings, [secret]);
		const client = biome(`rm -f "$3"\nln -s "${secret}" "$3"`);

		const outcome = await client.format(path.join(workspace, "b.ts"), "const b=1").then(
			text => text,
			(error: unknown) => error,
		);

		expect(outcome).toBeInstanceOf(Error);
		expect(String(outcome)).not.toContain("TOP SECRET");
	}, 20_000);
});
