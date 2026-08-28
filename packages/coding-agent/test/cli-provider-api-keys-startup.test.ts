import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const roots: string[] = [];
const argsModuleUrl = pathToFileURL(path.join(import.meta.dir, "../src/cli/args.ts")).href;
const mainModuleUrl = pathToFileURL(path.join(import.meta.dir, "../src/main.ts")).href;
const settingsModuleUrl = pathToFileURL(path.join(import.meta.dir, "../src/config/settings.ts")).href;
const helpersModuleUrl = pathToFileURL(path.join(import.meta.dir, "../src/discovery/helpers.ts")).href;

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("--provider-api-keys startup", () => {
	it("rejects simultaneous named and descriptor bundle sources before auth discovery and closes the descriptor", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-mixed-"));
		roots.push(root);
		const bundlePath = path.join(root, "bundle.json");
		fs.writeFileSync(bundlePath, JSON.stringify({ anthropic: "descriptor-token" }), { mode: 0o600 });
		const script = `
import * as fs from "node:fs";
import { parseArgs } from ${JSON.stringify(argsModuleUrl)};
import { runRootCommand } from ${JSON.stringify(mainModuleUrl)};
const bundlePath = ${JSON.stringify(bundlePath)};
const fd = fs.openSync(bundlePath, "r");
const argv = ["--provider-api-keys", bundlePath, "--provider-api-keys-fd", String(fd)];
const parsed = parseArgs(argv);
parsed.mode = "acp";
parsed.noExtensions = true;
let discovered = false;
process.exitCode = 0;
await runRootCommand(parsed, argv, {
  discoverAuthStorage: async () => {
    discovered = true;
    return { close() {} };
  },
});
const observedExitCode = process.exitCode;
process.exitCode = 0;
let fdOpenAfter = true;
try {
  fs.fstatSync(fd);
} catch {
  fdOpenAfter = false;
}
console.log(JSON.stringify({ observedExitCode, discovered, fdOpenAfter }));`;
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
		expect(stderr).toContain("mutually exclusive");
		const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
		expect(result).toEqual({ observedExitCode: 2, discovered: false, fdOpenAfter: false });
	});

	it("consumes and closes the descriptor before --cwd validation can fail", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-fd-cwd-"));
		roots.push(root);
		const bundlePath = path.join(root, "bundle.json");
		fs.writeFileSync(bundlePath, JSON.stringify({ anthropic: "descriptor-token" }), { mode: 0o600 });
		const missingCwd = path.join(root, "missing-target");
		const script = `
import * as fs from "node:fs";
import { parseArgs } from ${JSON.stringify(argsModuleUrl)};
import { runRootCommand } from ${JSON.stringify(mainModuleUrl)};
const bundlePath = ${JSON.stringify(bundlePath)};
const fd = fs.openSync(bundlePath, "r");
const argv = ["--cwd", ${JSON.stringify(missingCwd)}, "--provider-api-keys-fd", String(fd)];
const parsed = parseArgs(argv);
parsed.mode = "acp";
parsed.noExtensions = true;
process.on("exit", () => {
  let fdOpenAfter = true;
  try {
    fs.fstatSync(fd);
  } catch {
    fdOpenAfter = false;
  }
  console.log(JSON.stringify({ fdOpenAfter }));
});
await runRootCommand(parsed, argv, {
  discoverAuthStorage: async () => ({ close() {} }),
});
throw new Error("expected invalid --cwd to exit");`;
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
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Cannot change working directory");
		const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
		expect(result).toEqual({ fdOpenAfter: false });
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

	it.skipIf(process.platform !== "linux")(
		"consumes the launcher descriptor before auth discovery can spawn a child",
		async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-provider-api-keys-order-"));
			roots.push(root);
			const bundle = path.join(root, "bundle.json");
			fs.writeFileSync(bundle, JSON.stringify({ anthropic: "selected-token" }), { mode: 0o600 });
			const script = `
import * as fs from "node:fs";
import { parseArgs } from ${JSON.stringify(argsModuleUrl)};
import { runRootCommand } from ${JSON.stringify(mainModuleUrl)};
import { Settings } from ${JSON.stringify(settingsModuleUrl)};
const bundle = ${JSON.stringify(bundle)};
const fd = fs.openSync(bundle, fs.constants.O_RDONLY);
const parsed = parseArgs(["--provider-api-keys-fd", String(fd)]);
parsed.mode = "acp";
parsed.noExtensions = true;
const continued = new Error("continued past auth discovery");
const installed = [];
let openAtDiscovery;
Settings.init = () => Promise.reject(continued);
try {
  await runRootCommand(parsed, ["--provider-api-keys-fd", String(fd)], {
    discoverAuthStorage: async () => {
      try {
        fs.fstatSync(fd);
        openAtDiscovery = true;
      } catch {
        openAtDiscovery = false;
      }
      return {
        close() {},
        setRuntimeApiKey(provider, value) { installed.push([provider, value]); },
      };
    },
  });
  throw new Error("startup returned before the post-install boundary");
} catch (error) {
  if (error !== continued) throw error;
}
console.log(JSON.stringify({ openAtDiscovery, installed }));`;
			const proc = Bun.spawn({
				cmd: [process.execPath, "--eval", script],
				cwd: process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
				timeout: 10_000,
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			expect(exitCode, stderr).toBe(0);
			const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
			expect(result).toEqual({
				openAtDiscovery: false,
				installed: [["anthropic", "selected-token"]],
			});
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
		const script = `
import { vi } from "bun:test";
import { parseArgs } from ${JSON.stringify(argsModuleUrl)};
import * as helpers from ${JSON.stringify(helpersModuleUrl)};
import { runRootCommand } from ${JSON.stringify(mainModuleUrl)};
const pluginDir = ${JSON.stringify(pluginDir)};
const parsed = parseArgs(["--provider-api-keys="]);
parsed.mode = "acp";
parsed.noExtensions = true;
parsed.pluginDirs = [pluginDir];
const injectSpy = vi.spyOn(helpers, "injectPluginDirRoots");
const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
process.exitCode = 0;
await runRootCommand(parsed, ["--provider-api-keys=", "--plugin-dir", pluginDir], {
  discoverAuthStorage: async () => ({ close() {} }),
  get settings() {
    throw new Error("unexpected settings init on a rejected bundle");
  },
});
const result = {
  requestedExitCode: process.exitCode,
  injectCalled: injectSpy.mock.calls.length > 0,
  rootPresent: helpers.getPreloadedPluginRoots().some(entry => entry.id.startsWith("rejected-run-plugin@")),
};
process.exitCode = 0;
stderr.mockRestore();
injectSpy.mockRestore();
console.log(JSON.stringify(result));`;
		const proc = Bun.spawn({
			cmd: [process.execPath, "--eval", script],
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")).toEqual({
			requestedExitCode: 2,
			injectCalled: false,
			rootPresent: false,
		});
	});
});
