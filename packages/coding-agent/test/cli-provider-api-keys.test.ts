import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import {
	installProviderApiKeys,
	type ProviderApiKeyEntries,
	readProviderApiKeyBundle,
	readProviderApiKeyBundleFd,
} from "@oh-my-pi/pi-coding-agent/cli/provider-api-keys";
import { mergeAuthHeaderSources } from "@oh-my-pi/pi-coding-agent/config/custom-models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as helpers from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getPreloadedPluginRoots } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { $ } from "bun";

const roots: string[] = [];
const argsModuleUrl = pathToFileURL(path.join(import.meta.dir, "../src/cli/args.ts")).href;
const mainModuleUrl = pathToFileURL(path.join(import.meta.dir, "../src/main.ts")).href;
const providerApiKeysModuleUrl = pathToFileURL(path.join(import.meta.dir, "../src/cli/provider-api-keys.ts")).href;
const settingsModuleUrl = pathToFileURL(path.join(import.meta.dir, "../src/config/settings.ts")).href;

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Read-then-install, the pairing startup performs across its own reorder. */
async function installBundle(bundlePath: string, auth: Pick<AuthStorage, "setRuntimeApiKey">): Promise<void> {
	installProviderApiKeys(await readProviderApiKeyBundle(bundlePath), auth);
}

async function installFd(fd: number, auth: Pick<AuthStorage, "setRuntimeApiKey">): Promise<void> {
	installProviderApiKeys(await readProviderApiKeyBundleFd(fd), auth);
}

function fdIsOpen(fd: number): boolean {
	try {
		fs.fstatSync(fd);
		return true;
	} catch {
		return false;
	}
}

describe("--provider-api-keys", () => {
	it("parses a credential-file path without leaking it into the prompt", () => {
		const parsed = parseArgs(["--provider-api-keys", "/tmp/bundle.json", "hello"]);
		expect(parsed.providerApiKeys).toBe("/tmp/bundle.json");
		expect(parsed.messages).toEqual(["hello"]);
	});

	it("parses an exact descriptor separately from named bundle paths", () => {
		const parsed = parseArgs(["--provider-api-keys-fd", "7", "hello"]);
		expect(parsed.providerApiKeysFd).toBe("7");
		expect(parsed.messages).toEqual(["hello"]);
	});

	it("rejects repeated descriptor bundle flags", () => {
		expect(() => parseArgs(["--provider-api-keys-fd", "7", "--provider-api-keys-fd", "8"])).toThrow(
			"--provider-api-keys-fd may only be specified once",
		);
	});

	it("rejects one descriptor value from each invalid numeric branch", async () => {
		for (const value of ["2", "3.5"]) {
			await expect(readProviderApiKeyBundleFd(value)).rejects.toThrow("integer descriptor greater than 2");
		}
	});

	it("records a missing credential-file value as empty so startup rejects it", () => {
		const parsed = parseArgs(["--provider-api-keys"]);
		expect(parsed.providerApiKeys).toBe("");
	});

	it("records a missing descriptor value as empty so startup rejects it", () => {
		const parsed = parseArgs(["--provider-api-keys-fd"]);
		expect(parsed.providerApiKeysFd).toBe("");
	});

	it("recognizes the descriptor flag after a missing credential-file value", () => {
		const parsed = parseArgs(["--provider-api-keys", "--provider-api-keys-fd", "7"]);
		expect(parsed.providerApiKeys).toBe("");
		expect(parsed.providerApiKeysFd).toBe("7");
		expect(parsed.messages).toEqual([]);
	});

	it("rejects simultaneous named and descriptor bundle sources before auth discovery and closes the descriptor", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-mixed-"));
		roots.push(root);
		const bundlePath = path.join(root, "bundle.json");
		fs.writeFileSync(bundlePath, JSON.stringify({ anthropic: "descriptor-token" }), { mode: 0o600 });
		const fd = fs.openSync(bundlePath, "r");
		const parsed = parseArgs(["--provider-api-keys", bundlePath, "--provider-api-keys-fd", String(fd)]);
		parsed.mode = "acp";
		parsed.noExtensions = true;
		let discovered = false;
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const exitCode = process.exitCode;
		process.exitCode = 0;
		try {
			await expect(
				runRootCommand(parsed, ["--provider-api-keys", bundlePath, "--provider-api-keys-fd", String(fd)], {
					discoverAuthStorage: async () => {
						discovered = true;
						return { close: () => {} } as unknown as AuthStorage;
					},
				}),
			).resolves.toBeUndefined();
			expect(process.exitCode).toBe(2);
			expect(discovered).toBe(false);
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining("mutually exclusive"));
			expect(fdIsOpen(fd)).toBe(false);
		} finally {
			if (fdIsOpen(fd)) fs.closeSync(fd);
			process.exitCode = exitCode ?? 0;
			stderr.mockRestore();
		}
	});

	it("rejects an explicitly empty credential-file path, disarms the watchdog and releases stdin", async () => {
		const script = `
import { parseArgs } from ${JSON.stringify(argsModuleUrl)};
import { runRootCommand } from ${JSON.stringify(mainModuleUrl)};
const parsed = parseArgs(["--provider-api-keys="]);
parsed.mode = "rpc";
parsed.noExtensions = true;
let discovered = false;
const armedWatchdogs = new Set();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = ((fn, ms, ...args) => {
  const timer = realSetInterval(fn, ms, ...args);
  if (ms === 10_000) armedWatchdogs.add(timer);
  return timer;
});
globalThis.clearInterval = ((timer) => {
  armedWatchdogs.delete(timer);
  return realClearInterval(timer);
});
process.exitCode = 0;
await runRootCommand(parsed, ["--provider-api-keys="], {
  discoverAuthStorage: async () => {
    discovered = true;
    return { close() {} };
  },
  get settings() {
    throw new Error("continued after an empty provider bundle path");
  },
});
let stdinLockFree = false;
const stdinReader = Bun.stdin.stream().getReader();
stdinReader.releaseLock();
stdinLockFree = true;
const observedExitCode = process.exitCode;
process.exitCode = 0;
console.log(JSON.stringify({
  observedExitCode,
  discovered,
  armedWatchdogs: armedWatchdogs.size,
  stdinLockFree,
}));`;
		const proc = Bun.spawn({
			cmd: [process.execPath, "--eval", script],
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
		expect(result).toEqual({
			observedExitCode: 2,
			discovered: false,
			armedWatchdogs: 0,
			stdinLockFree: true,
		});
	});

	it("restores startup directory state when bundle validation rejects", async () => {
		const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-provider-api-keys-cwd-"));
		roots.push(root);
		const target = path.join(root, "target");
		fs.mkdirSync(target);
		const relativeTarget = path.relative(process.cwd(), target);
		const script = `import { parseArgs } from ${JSON.stringify(argsModuleUrl)};
import { runRootCommand } from ${JSON.stringify(mainModuleUrl)};
import { getProjectDir } from "@oh-my-pi/pi-utils";
const parsed = parseArgs(["--cwd", ${JSON.stringify(relativeTarget)}, "--provider-api-keys="]);
parsed.mode = "acp";
parsed.noExtensions = true;
const before = { cwd: process.cwd(), projectDir: getProjectDir(), parsedCwd: parsed.cwd };
await runRootCommand(parsed, ["--cwd", ${JSON.stringify(relativeTarget)}, "--provider-api-keys="]);
console.log(JSON.stringify({ before, after: { cwd: process.cwd(), projectDir: getProjectDir(), parsedCwd: parsed.cwd } }));`;
		const proc = Bun.spawn({
			cmd: [process.execPath, "--eval", script],
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(proc.signalCode).toBeNull();
		expect(exitCode).toBe(2);
		expect(stderr).toContain("must name a readable credential bundle");
		const state = JSON.parse(stdout.trim());
		expect(state.after).toEqual(state.before);
	});

	it("resolves a relative named bundle from the launch directory before automatic relocation", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-relative-"));
		roots.push(root);
		fs.mkdirSync(path.join(root, "tmp"));
		fs.writeFileSync(path.join(root, "bundle.json"), JSON.stringify({ anthropic: "selected-token" }), {
			mode: 0o600,
		});
		const script = `import { parseArgs } from ${JSON.stringify(argsModuleUrl)};
import { runRootCommand } from ${JSON.stringify(mainModuleUrl)};
import { Settings } from ${JSON.stringify(settingsModuleUrl)};
const parsed = parseArgs(["--provider-api-keys", "bundle.json"]);
parsed.mode = "acp";
parsed.noExtensions = true;
const installed = [];
const continued = new Error("continued after relative bundle");
// Settings init is the first startup boundary awaited AFTER the bundle is
// installed into AuthStorage; rejecting there stops the run past the install.
Settings.init = () => Promise.reject(continued);
try {
  await runRootCommand(parsed, ["--provider-api-keys", "bundle.json"], {
    discoverAuthStorage: async () => ({
      close() {},
      setRuntimeApiKey(provider, value) { installed.push([provider, value]); },
    }),
  });
  throw new Error("bundle rejection returned instead of continuing");
} catch (error) {
  if (error !== continued) throw error;
}
console.log(JSON.stringify({ cwd: process.cwd(), installed }));`;
		const proc = Bun.spawn({
			cmd: [process.execPath, "--eval", script],
			cwd: root,
			env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: path.join(root, "agent") },
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(proc.signalCode).toBeNull();
		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout.trim())).toEqual({
			cwd: path.join(root, "tmp"),
			installed: [["anthropic", "selected-token"]],
		});
	});

	it("reports an unreadable descriptor after restoring startup directory state", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-cwd-error-"));
		roots.push(root);
		const target = path.join(root, "target");
		fs.mkdirSync(target);
		const bundle = path.join(root, "bundle.json");
		fs.writeFileSync(bundle, JSON.stringify({ anthropic: "selected-token" }), { mode: 0o600 });
		const script = `import * as fs from "node:fs";
import { parseArgs } from ${JSON.stringify(argsModuleUrl)};
import { runRootCommand } from ${JSON.stringify(mainModuleUrl)};
import { getProjectDir } from "@oh-my-pi/pi-utils";
const fd = fs.openSync(${JSON.stringify(bundle)}, fs.constants.O_WRONLY);
const parsed = parseArgs(["--cwd", ${JSON.stringify(target)}, "--provider-api-keys-fd", String(fd)]);
parsed.mode = "acp";
parsed.noExtensions = true;
const before = { cwd: process.cwd(), projectDir: getProjectDir(), parsedCwd: parsed.cwd };
await runRootCommand(parsed, ["--cwd", ${JSON.stringify(target)}, "--provider-api-keys-fd", String(fd)], {
  get discoverAuthStorage() { throw new Error("unexpected auth discovery after descriptor read failure"); },
});
console.log(JSON.stringify({ before, after: { cwd: process.cwd(), projectDir: getProjectDir(), parsedCwd: parsed.cwd } }));`;
		const proc = Bun.spawn({
			cmd: [process.execPath, "--eval", script],
			cwd: process.cwd(),
			env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "agent") },
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(proc.signalCode).toBeNull();
		expect(exitCode).toBe(2);
		expect(stderr).toContain("descriptor must be readable");
		const state = JSON.parse(stdout.trim());
		expect(state.after).toEqual(state.before);
	});

	it("installs only the explicit one-shot provider bundle as runtime keys", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-"));
		roots.push(root);
		const bundle = path.join(root, "bundle.json");
		fs.writeFileSync(bundle, JSON.stringify({ "openai-codex": "resolved-token", anthropic: "selected-token" }));
		fs.chmodSync(bundle, 0o600);
		const auth = await AuthStorage.create(":memory:");
		try {
			await installBundle(bundle, auth);
			expect(await auth.getApiKey("openai-codex")).toBe("resolved-token");
			expect(await auth.getApiKey("anthropic")).toBe("selected-token");
			expect(await auth.getApiKey("openrouter")).toBeUndefined();
			expect(auth.describeCredentialSource("anthropic")).toBe("runtime API key override");
		} finally {
			auth.close();
		}
	});

	it("leaves an SDK host's handle open when loading a named bundle", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-named-owner-"));
		roots.push(root);
		const bundle = path.join(root, "bundle.json");
		fs.writeFileSync(bundle, JSON.stringify({ anthropic: "selected-token" }));
		fs.chmodSync(bundle, 0o600);
		const hostFd = fs.openSync(bundle, fs.constants.O_RDONLY);
		const auth = await AuthStorage.create(":memory:");
		try {
			await installBundle(bundle, auth);
			expect(await auth.getApiKey("anthropic")).toBe("selected-token");
			expect(fdIsOpen(hostFd)).toBe(true);
		} finally {
			if (fdIsOpen(hostFd)) fs.closeSync(hostFd);
			auth.close();
		}
	});

	it.skipIf(process.platform === "win32")("rejects loose permissions on named files", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-permissions-"));
		roots.push(root);
		const bundle = path.join(root, "bundle.json");
		fs.writeFileSync(bundle, JSON.stringify({ "openai-codex": "token" }));
		fs.chmodSync(bundle, 0o644);
		const auth = await AuthStorage.create(":memory:");
		try {
			await expect(readProviderApiKeyBundle(bundle)).rejects.toThrow("must not be group/world-accessible");
		} finally {
			auth.close();
		}
	});

	it.skipIf(process.platform !== "win32")("does not apply POSIX permission bits on Windows", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-windows-"));
		roots.push(root);
		const bundle = path.join(root, "bundle.json");
		fs.writeFileSync(bundle, JSON.stringify({ anthropic: "selected-token" }));
		fs.chmodSync(bundle, 0o644);
		const auth = await AuthStorage.create(":memory:");
		try {
			await installBundle(bundle, auth);
			expect(await auth.getApiKey("anthropic")).toBe("selected-token");
		} finally {
			auth.close();
		}
	});

	it.skipIf(process.platform !== "linux")("accepts an anonymous descriptor-backed bundle", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-fd-"));
		roots.push(root);
		const bundle = path.join(root, "bundle.json");
		fs.writeFileSync(bundle, JSON.stringify({ anthropic: "selected-token" }));
		fs.chmodSync(bundle, 0o644);
		const fd = fs.openSync(bundle, fs.constants.O_RDONLY);
		fs.unlinkSync(bundle);
		const auth = await AuthStorage.create(":memory:");
		try {
			// The loader takes ownership of the descriptor it consumes, so the
			// caller must not close it again.
			await installFd(fd, auth);
			expect(await auth.getApiKey("anthropic")).toBe("selected-token");
		} finally {
			auth.close();
		}
	});

	it.skipIf(process.platform === "win32")("rejects a FIFO without blocking", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-fifo-"));
		roots.push(root);
		const bundle = path.join(root, "bundle.json");
		await $`mkfifo ${bundle}`.quiet();
		const script = `import { readProviderApiKeyBundle } from ${JSON.stringify(providerApiKeysModuleUrl)}; await readProviderApiKeyBundle(${JSON.stringify(bundle)});`;
		// A process boundary is required because the regression blocks inside open(2).
		// Bun's own subprocess timeout is the failure signal (no GNU coreutils
		// dependency); the fixed path exits immediately.
		const proc = Bun.spawn({
			cmd: [process.execPath, "--eval", script],
			stdout: "ignore",
			stderr: "pipe",
			timeout: 2_000,
		});
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;
		expect(proc.signalCode).toBeNull(); // a timeout kill sets the signal — the hang regression
		expect(exitCode).not.toBe(0);
		// Pin the refusal to the loader's own message so an unrelated subprocess
		// failure (module resolution, runtime crash) cannot satisfy this test.
		expect(stderr).toContain("must name a regular file");
	});

	it("rejects malformed bundle entries", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-invalid-"));
		roots.push(root);
		const bundle = path.join(root, "bundle.json");
		fs.writeFileSync(bundle, JSON.stringify({ "openai-codex": 7 }));
		fs.chmodSync(bundle, 0o600);
		await expect(readProviderApiKeyBundle(bundle)).rejects.toThrow("non-empty string values");
	});

	it("rejects an oversized bundle before reading it", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-oversize-"));
		roots.push(root);
		const bundle = path.join(root, "bundle.json");
		const fd = fs.openSync(bundle, "w", 0o600);
		try {
			// Sparse regular file: 1 byte past the limit without writing a megabyte.
			fs.ftruncateSync(fd, 1_000_001);
		} finally {
			fs.closeSync(fd);
		}
		await expect(readProviderApiKeyBundle(bundle)).rejects.toThrow("must be 1-1000000 bytes");
	});

	it("rejects an empty JSON object and an array bundle", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-shape-"));
		roots.push(root);
		const empty = path.join(root, "empty.json");
		fs.writeFileSync(empty, "{}", { mode: 0o600 });
		await expect(readProviderApiKeyBundle(empty)).rejects.toThrow("must contain 1-16 providers");
		const array = path.join(root, "array.json");
		fs.writeFileSync(array, JSON.stringify(["k"]), { mode: 0o600 });
		await expect(readProviderApiKeyBundle(array)).rejects.toThrow("must be an object");
	});

	it("rejects a bundle with more than the provider limit", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-count-"));
		roots.push(root);
		const bundle = path.join(root, "bundle.json");
		const providers = Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`provider-${n}`, "value"]));
		fs.writeFileSync(bundle, JSON.stringify(providers), { mode: 0o600 });
		await expect(readProviderApiKeyBundle(bundle)).rejects.toThrow("must contain 1-16 providers");
	});

	it("accepts an arbitrary provider name from the config contract", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-ids-"));
		roots.push(root);
		const provider = "@Acme Gateway/β";
		const bundle = path.join(root, "bundle.json");
		fs.writeFileSync(bundle, JSON.stringify({ [provider]: "selected-token" }), { mode: 0o600 });
		const auth = await AuthStorage.create(":memory:");
		try {
			// The models config keys providers with `{ "[string]": … }`, and the
			// registry carries that name verbatim into AuthStorage. One composite
			// non-empty name proves the boundary; spelling variants are the same path.
			await installBundle(bundle, auth);
			expect(await auth.getApiKey(provider)).toBe("selected-token");
		} finally {
			auth.close();
		}
	});

	it("installs prototype-shaped provider names", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-proto-"));
		roots.push(root);
		const bundle = path.join(root, "bundle.json");
		fs.writeFileSync(bundle, '{"__proto__":"proto-token","constructor":"ctor-token"}', { mode: 0o600 });
		const auth = await AuthStorage.create(":memory:");
		try {
			await installBundle(bundle, auth);
			expect(await auth.getApiKey("__proto__")).toBe("proto-token");
			expect(await auth.getApiKey("constructor")).toBe("ctor-token");
		} finally {
			auth.close();
		}
	});

	it("rejects an empty provider name", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-empty-id-"));
		roots.push(root);
		const bundle = path.join(root, "bundle.json");
		fs.writeFileSync(bundle, JSON.stringify({ "": "value" }), { mode: 0o600 });
		await expect(readProviderApiKeyBundle(bundle)).rejects.toThrow("requires provider IDs");
	});

	it("closes the launcher descriptor it consumed", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-fd-owned-"));
		roots.push(root);
		const bundle = path.join(root, "bundle.json");
		fs.writeFileSync(bundle, JSON.stringify({ anthropic: "selected-token" }));
		fs.chmodSync(bundle, 0o600);
		const sourceFd = fs.openSync(bundle, fs.constants.O_RDONLY);
		const hostFd = fs.openSync(bundle, fs.constants.O_RDONLY);
		const auth = await AuthStorage.create(":memory:");
		let sourceConsumed = false;
		try {
			await installFd(sourceFd, auth);
			sourceConsumed = true;
			expect(await auth.getApiKey("anthropic")).toBe("selected-token");
			// Ownership transfers for exactly the numeric descriptor. A second
			// handle on the same inode still belongs to the SDK host.
			expect(fdIsOpen(sourceFd)).toBe(false);
			expect(fdIsOpen(hostFd)).toBe(true);
		} finally {
			if (!sourceConsumed && fdIsOpen(sourceFd)) fs.closeSync(sourceFd);
			if (fdIsOpen(hostFd)) fs.closeSync(hostFd);
			auth.close();
		}
	});

	it.skipIf(process.platform !== "linux")("rejects descriptor aliases on the named-path flag", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-path-symlink-"));
		roots.push(root);
		const bundle = path.join(root, "bundle.json");
		fs.writeFileSync(bundle, JSON.stringify({ anthropic: "selected-token" }), { mode: 0o600 });
		const fd = fs.openSync(bundle, fs.constants.O_RDONLY);
		try {
			await expect(readProviderApiKeyBundle(`/proc/self/fd/${fd}`)).rejects.toThrow("must not be a symbolic link");
			expect(fdIsOpen(fd)).toBe(true);
		} finally {
			if (fdIsOpen(fd)) fs.closeSync(fd);
		}
	});

	it.skipIf(process.platform !== "linux")("closes a descriptor that fails validation", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-fd-invalid-"));
		roots.push(root);
		const fifo = path.join(root, "bundle.json");
		await $`mkfifo ${fifo}`.quiet();
		const fd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		try {
			await expect(readProviderApiKeyBundleFd(fd)).rejects.toThrow("must name a regular file");
			expect(fdIsOpen(fd)).toBe(false);
		} finally {
			if (fdIsOpen(fd)) fs.closeSync(fd);
		}
	});

	it.skipIf(process.platform !== "linux")(
		"consumes the launcher descriptor before auth discovery can spawn a child",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-order-"));
			roots.push(root);
			const bundle = path.join(root, "bundle.json");
			fs.writeFileSync(bundle, JSON.stringify({ anthropic: "selected-token" }));
			fs.chmodSync(bundle, 0o600);
			const fd = fs.openSync(bundle, fs.constants.O_RDONLY);
			const parsed = parseArgs(["--provider-api-keys-fd", String(fd)]);
			// A protocol mode skips readPipedInput without claiming the RPC stdin
			// singleton, so this test cannot strand the lock for later files.
			parsed.mode = "acp";
			parsed.noExtensions = true;
			const continued = new Error("continued past auth discovery");
			const installed: ProviderApiKeyEntries = [];
			const authStorage = {
				close: () => {},
				setRuntimeApiKey: (provider: string, value: string) => {
					(installed as (readonly [string, string])[]).push([provider, value]);
				},
			} as unknown as AuthStorage;
			// discoverAuthStorage resolves `!command` broker URL/token values
			// through a shell. Any inheritable descriptor still open at that
			// moment is readable by that child through its own /proc/self/fd.
			let openAtDiscovery: boolean | undefined;
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const exitCode = process.exitCode;
			// Settings init is the first startup boundary awaited AFTER the
			// descriptor is consumed and the keys reach AuthStorage; rejecting
			// there stops the run past both events without racing them.
			const settingsInit = vi.spyOn(Settings, "init").mockRejectedValue(continued);
			try {
				await expect(
					runRootCommand(parsed, ["--provider-api-keys-fd", String(fd)], {
						discoverAuthStorage: async () => {
							openAtDiscovery = fdIsOpen(fd);
							return authStorage;
						},
					}),
				).rejects.toBe(continued);
				expect(openAtDiscovery).toBe(false);
				// The keys still reach AuthStorage, which only exists after discovery.
				expect(installed).toEqual([["anthropic", "selected-token"]]);
			} finally {
				// Only close before ownership transfer. Once discovery observes
				// the consumed fd, its number may already have been reused.
				if (openAtDiscovery === undefined && fdIsOpen(fd)) fs.closeSync(fd);
				process.exitCode = exitCode ?? 0;
				settingsInit.mockRestore();
				stderr.mockRestore();
			}
		},
	);

	it("does not start plugin discovery when the bundle is rejected", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-plugin-"));
		roots.push(root);
		const pluginDir = path.join(root, "rejected-run-plugin");
		fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
		fs.writeFileSync(
			path.join(pluginDir, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "rejected-run-plugin" }),
		);
		const parsed = parseArgs(["--provider-api-keys="]);
		parsed.mode = "acp";
		parsed.noExtensions = true;
		parsed.pluginDirs = [pluginDir];
		// Assert discovery never STARTS rather than sampling the process-global
		// roots later: the mutation lands after awaited manifest reads, so any
		// wall-clock wait would be racing the very thing under test.
		const injectSpy = vi.spyOn(helpers, "injectPluginDirRoots");
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const exitCode = process.exitCode;
		process.exitCode = 0;
		try {
			await expect(
				runRootCommand(parsed, ["--provider-api-keys=", "--plugin-dir", pluginDir], {
					// Discovery must SUCCEED here. If it throws, the mutant dies
					// before reaching the spy assertion below and this test
					// silently stops covering the preload contract.
					discoverAuthStorage: async () => ({ close: () => {} }) as unknown as AuthStorage,
					get settings(): never {
						throw new Error("unexpected settings init on a rejected bundle");
					},
				}),
			).resolves.toBeUndefined();
			expect(process.exitCode).toBe(2);
			expect(injectSpy).not.toHaveBeenCalled();
			expect(getPreloadedPluginRoots().some(entry => entry.id.startsWith("rejected-run-plugin@"))).toBe(false);
		} finally {
			process.exitCode = exitCode ?? 0;
			stderr.mockRestore();
			injectSpy.mockRestore();
		}
	});

	it("materializes runtime-only auth headers for authHeader providers without a configured key", () => {
		// authHeader: true with no apiKey and no static headers is valid when the
		// credential comes exclusively from the runtime bundle; the resolver must
		// consult the override instead of returning no headers at all.
		const headers = mergeAuthHeaderSources([], true, undefined, () => "runtime-key");
		expect(headers?.Authorization).toBe("Bearer runtime-key");
	});
});
