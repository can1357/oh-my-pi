import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveModels } from "@oh-my-pi/pi-coding-agent/cli/tiny-models-cli";
import { getTinyLocalModelSpec } from "@oh-my-pi/pi-coding-agent/tiny/models";
import { TinyTitleClient } from "../src/tiny/title-client";
import {
	LockAcquireError,
	__internalsForTesting as fileLockInternals,
	withFileLock,
} from "@oh-my-pi/pi-utils/file-lock";
import * as appleFm from "../src/tiny/apple-fm";

const {
	AFM_CORE_SIDECAR_ENV,
	completeAfmCore,
	foundationModelsUnavailableReason,
	probeAfmCore,
	resolveBundledSidecarPath,
	__internalsForTesting,
} = appleFm;

const { tryAcquireLock, getLockPath } = fileLockInternals;

const previousSidecar = process.env[AFM_CORE_SIDECAR_ENV];

afterEach(() => {
	if (previousSidecar === undefined) delete process.env[AFM_CORE_SIDECAR_ENV];
	else process.env[AFM_CORE_SIDECAR_ENV] = previousSidecar;
});

async function writeFakeSidecar(dir: string, script: string): Promise<string> {
	const sidecar = path.join(dir, "fake-afm");
	await Bun.write(sidecar, script);
	await fs.promises.chmod(sidecar, 0o755);
	return sidecar;
}

function bunSidecar(body: string): string {
	return `#!/usr/bin/env bun
${body}
`;
}

describe("afm-core title registry", () => {
	it("lets OMP_APPLE_FM_SIDECAR bypass the platform gate", () => {
		const spec = getTinyLocalModelSpec("afm-core");
		expect(spec).toBeDefined();
		if (!spec) return;
		delete process.env[AFM_CORE_SIDECAR_ENV];
		if (process.platform !== "darwin") {
			expect(foundationModelsUnavailableReason(spec)).toBe("Apple Foundation Models is macOS-only");
		}
		process.env[AFM_CORE_SIDECAR_ENV] = "/tmp/does-not-need-to-exist-for-this-check";
		expect(foundationModelsUnavailableReason(spec)).toBeUndefined();
	});

	it("treats Darwin kernels before 25 as too old for AFM", () => {
		const { darwinMeetsAfmRuntime } = __internalsForTesting;
		expect(darwinMeetsAfmRuntime("linux", "24.6.0")).toBe(false);
		expect(darwinMeetsAfmRuntime("darwin", "24.6.0")).toBe(false);
		expect(darwinMeetsAfmRuntime("darwin", "25.0.0")).toBe(true);
		expect(darwinMeetsAfmRuntime("darwin", "not-a-version")).toBe(false);
	});

	it("keeps afm-core out of download all even when Darwin-ready", () => {
		expect(resolveModels("all")).not.toContain("afm-core");
		expect(resolveModels("afm-core")).toEqual(["afm-core"]);
	});

	it("resolves a Bun file-loader emit against the module dir, not cwd", () => {
		expect(resolveBundledSidecarPath("./omp-apple-fm-py3pdx4g.", "/pkg/dist")).toBe(
			path.join("/pkg/dist", "omp-apple-fm-py3pdx4g."),
		);
	});
});

describe("AFM sidecar runner", () => {
	it("probes and completes through an env-overridden sidecar", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = await writeFakeSidecar(
				dir,
				bunSidecar(`
const cmd = process.argv[2];
if (cmd === "status") {
	process.stdout.write(JSON.stringify({ available: true, contextSize: 8192 }) + "\\n");
	process.exit(0);
}
const raw = await Bun.stdin.text();
const req = JSON.parse(raw);
if (!req.prompt) throw new Error("missing prompt");
process.stdout.write(JSON.stringify({ text: req.maxTokens ? String(req.maxTokens) : "<title>Fix login button</title>" }) + "\\n");
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			await expect(probeAfmCore()).resolves.toEqual({ available: true, reason: undefined, contextSize: 8192 });
			await expect(completeAfmCore({ instructions: "title", prompt: "fix the login button" })).resolves.toBe(
				"<title>Fix login button</title>",
			);
			await expect(completeAfmCore({ prompt: "classify", maxTokens: 16 })).resolves.toBe("16");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("surfaces sidecar error payloads", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = await writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ error: "apple_fm_failed", reason: "modelNotReady" }) + "\\n");
process.exit(1);
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			await expect(probeAfmCore()).rejects.toThrow("apple_fm_failed: modelNotReady");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("afm-core client titles", () => {
	it("generates a title without spawning a worker", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = await writeFakeSidecar(
				dir,
				bunSidecar(`
const cmd = process.argv[2];
if (cmd === "status") {
	process.stdout.write(JSON.stringify({ available: true, contextSize: 8192 }) + "\\n");
	process.exit(0);
}
process.stdout.write(JSON.stringify({ text: "<title>Fix login button</title>" }) + "\\n");
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const client = new TinyTitleClient();
			const events: string[] = [];
			client.onProgress(event => {
				if (event.modelKey === "afm-core") events.push(event.status);
			});
			await expect(client.generate("afm-core", "the login button is broken on mobile")).resolves.toBe(
				"Fix login button",
			);
			expect(events).toContain("initiate");
			expect(events).toContain("ready");
			expect(events).not.toContain("error");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("treats download as a readiness probe", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = await writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ available: true, contextSize: 8192 }) + "\\n");
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const client = new TinyTitleClient();
			await expect(client.downloadModel("afm-core")).resolves.toEqual({ ok: true });
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("closes the probe lifecycle when the model reports unavailable", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = await writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ available: false, reason: "deviceNotEligible" }) + "\\n");
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const client = new TinyTitleClient();
			const events: string[] = [];
			client.onProgress(event => {
				if (event.modelKey === "afm-core") events.push(event.status);
			});
			await expect(client.downloadModel("afm-core")).resolves.toEqual({
				ok: false,
				error: "deviceNotEligible",
			});
			expect(events).toContain("initiate");
			expect(events).toContain("error");
			expect(events).not.toContain("ready");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("returns no title on modelNotReady and recovers when ready later", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = await writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ error: "apple_fm_failed", reason: "modelNotReady" }) + "\\n");
process.exit(1);
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const client = new TinyTitleClient();
			const events: string[] = [];
			client.onProgress(event => {
				if (event.modelKey === "afm-core") events.push(event.status);
			});
			await expect(client.generate("afm-core", "fix the login button")).resolves.toBeNull();
			expect(events).toContain("error");
			await Bun.write(
				sidecar,
				bunSidecar(`
process.stdout.write(JSON.stringify({ text: "<title>Fix login button</title>" }) + "\\n");
`),
			);
			await expect(client.generate("afm-core", "fix the login button")).resolves.toBe("Fix login button");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps prompt-specific AFM failures request-scoped", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = await writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ error: "apple_fm_failed", reason: "Generation was refused" }) + "\\n");
process.exit(1);
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const client = new TinyTitleClient();
			const events: string[] = [];
			client.onProgress(event => {
				if (event.modelKey === "afm-core") events.push(event.status);
			});
			await expect(client.generate("afm-core", "fix the login button")).resolves.toBeNull();
			expect(events).not.toContain("error");
			await Bun.write(
				sidecar,
				bunSidecar(`
process.stdout.write(JSON.stringify({ text: "<title>Fix login button</title>" }) + "\\n");
`),
			);
			await expect(client.generate("afm-core", "fix the login button")).resolves.toBe("Fix login button");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("recovers after a generation failure whose description mentions unavailability", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = await writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ error: "apple_fm_failed", reason: "The model assets are currently unavailable" }) + "\\n");
process.exit(1);
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const client = new TinyTitleClient();
			const events: string[] = [];
			client.onProgress(event => {
				if (event.modelKey === "afm-core") events.push(event.status);
			});
			await expect(client.generate("afm-core", "fix the login button")).resolves.toBeNull();
			expect(events).not.toContain("error");
			await Bun.write(
				sidecar,
				bunSidecar(`
process.stdout.write(JSON.stringify({ text: "<title>Fix login button</title>" }) + "\\n");
`),
			);
			await expect(client.generate("afm-core", "fix the login button")).resolves.toBe("Fix login button");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it.each([
		{
			name: "empty sidecar text",
			script: bunSidecar('process.stdout.write(JSON.stringify({ text: "   " }) + "\\n");'),
		},
		{ name: "malformed sidecar JSON", script: bunSidecar('process.stdout.write("{invalid}\\n");') },
		{ name: "a killed sidecar", script: bunSidecar('process.kill(process.pid, "SIGKILL");') },
		{ name: "a failed sidecar spawn", script: "#!/nonexistent/omp-afm-test-interpreter\n" },
	])("recovers after $name without disabling AFM", async ({ script }) => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = await writeFakeSidecar(dir, script);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const client = new TinyTitleClient();
			const events: string[] = [];
			client.onProgress(event => {
				if (event.modelKey === "afm-core") events.push(event.status);
			});
			await expect(client.generate("afm-core", "fix the login button")).resolves.toBeNull();
			expect(events).not.toContain("error");
			await Bun.write(
				sidecar,
				bunSidecar(`
process.stdout.write(JSON.stringify({ text: "<title>Fix login button</title>" }) + "\\n");
`),
			);
			await expect(client.generate("afm-core", "fix the login button")).resolves.toBe("Fix login button");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("treats a contended sidecar install lock as request-scoped", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-afm-"));
		const target = path.join(dir, "omp-apple-fm");
		const held = tryAcquireLock(getLockPath(target));
		expect(held).not.toBeNull();
		try {
			const sidecar = await writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ text: "<title>Fix login button</title>" }) + "\\n");
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			// The install path cannot run with the env override set, so take the
			// error a contended install would raise and drive it through the same
			// translation ensureAfmSidecar applies.
			const contended = await withFileLock(target, async () => "unreachable", { retries: 1 }).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(contended).toBeInstanceOf(LockAcquireError);
			const mapped = __internalsForTesting.mapSidecarInstallError(contended);
			const spy = spyOn(appleFm, "completeAfmCore").mockRejectedValue(mapped);
			try {
				const client = new TinyTitleClient();
				const events: string[] = [];
				client.onProgress(event => {
					if (event.modelKey === "afm-core") events.push(event.status);
				});
				await expect(client.generate("afm-core", "fix the login button")).resolves.toBeNull();
				expect(events).not.toContain("error");
				spy.mockRestore();
				await expect(client.generate("afm-core", "fix the login button")).resolves.toBe("Fix login button");
			} finally {
				spy.mockRestore();
			}
		} finally {
			held?.release();
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("disables AFM after a terminal failure", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = await writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ error: "apple_fm_failed", reason: "deviceNotEligible" }) + "\\n");
process.exit(1);
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const client = new TinyTitleClient();
			await expect(client.generate("afm-core", "fix the login button")).resolves.toBeNull();
			await Bun.write(
				sidecar,
				bunSidecar(`
process.stdout.write(JSON.stringify({ text: "<title>Fix login button</title>" }) + "\\n");
`),
			);
			const events: string[] = [];
			client.onProgress(event => {
				if (event.modelKey === "afm-core") events.push(event.status);
			});
			await expect(client.generate("afm-core", "fix the login button")).resolves.toBeNull();
			expect(events).toEqual(["error"]);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
	it("resolves null on abort without disabling AFM", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = await writeFakeSidecar(
				dir,
				bunSidecar(`
await Bun.sleep(1500);
process.stdout.write(JSON.stringify({ text: "<title>Fix login button</title>" }) + "\\n");
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const client = new TinyTitleClient();
			const events: string[] = [];
			client.onProgress(event => {
				if (event.modelKey === "afm-core") events.push(event.status);
			});
			const controller = new AbortController();
			const startedAt = Date.now();
			const pending = client.generate("afm-core", "fix the login button", { signal: controller.signal });
			controller.abort();
			await expect(pending).resolves.toBeNull();
			expect(Date.now() - startedAt).toBeLessThan(1500);
			expect(events).toEqual(["initiate", "ready"]);
			await expect(client.generate("afm-core", "fix the login button")).resolves.toBe("Fix login button");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
	it("returns ok:false when the AFM readiness probe is aborted", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-afm-"));
		const pidPath = path.join(dir, "sidecar.pid");
		const controller = new AbortController();
		let pending: Promise<{ ok: boolean; error?: string }> | undefined;
		try {
			const sidecar = await writeFakeSidecar(
				dir,
				bunSidecar(`
await Bun.write(${JSON.stringify(pidPath)}, String(process.pid));
await Bun.sleep(60_000);
process.stdout.write(JSON.stringify({ available: true, contextSize: 8192 }) + "\\n");
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			const client = new TinyTitleClient();
			const events: string[] = [];
			client.onProgress(event => {
				if (event.modelKey === "afm-core") events.push(event.status);
			});
			pending = client.downloadModel("afm-core", { signal: controller.signal });
			if (!(await Bun.file(pidPath).exists())) {
				const { promise, resolve, reject } = Promise.withResolvers<void>();
				const watcher = fs.watch(dir, () => {
					void Bun.file(pidPath)
						.exists()
						.then(exists => {
							if (exists) resolve();
						});
				});
				// Bound so a spawn hang fails this test instead of the runner timeout.
				const timeout = AbortSignal.timeout(5_000);
				const onTimeout = (): void => reject(new Error(`timed out waiting for sidecar pid file: ${pidPath}`));
				timeout.addEventListener("abort", onTimeout, { once: true });
				try {
					if (await Bun.file(pidPath).exists()) resolve();
					await promise;
				} finally {
					timeout.removeEventListener("abort", onTimeout);
					watcher.close();
				}
			}
			const pid = Number.parseInt((await Bun.file(pidPath).text()).trim(), 10);
			expect(pid).toBeGreaterThan(0);
			process.kill(pid, 0);
			controller.abort();
			await expect(pending).resolves.toEqual({ ok: false });
			expect(events).toEqual(["initiate", "ready"]);
			expect(() => process.kill(pid, 0)).toThrow();
			await Bun.write(
				sidecar,
				bunSidecar(`
process.stdout.write(JSON.stringify({ available: true, contextSize: 8192 }) + "\\n");
`),
			);
			await expect(client.downloadModel("afm-core")).resolves.toEqual({ ok: true });
		} finally {
			controller.abort();
			await pending?.catch(() => {});
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("AFM sidecar cache publication", () => {
	async function writeHelper(dir: string, name: string, contents: string): Promise<string> {
		const helperPath = path.join(dir, name);
		await Bun.write(helperPath, contents);
		return helperPath;
	}

	it("installing one cache identity does not replace another identity's sidecar", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-afm-cache-"));
		const cacheDir = path.join(dir, "apple-fm");
		try {
			const helperA = await writeHelper(dir, "helper-a", "IDENTITY_A\n");
			const helperB = await writeHelper(dir, "helper-b", "IDENTITY_B\n");
			const pathA = await __internalsForTesting.installAfmSidecar(
				cacheDir,
				undefined,
				async () => helperA,
				"arch-a",
			);
			expect(pathA).toBe(path.join(cacheDir, "omp-apple-fm-arch-a"));
			expect(await Bun.file(pathA).text()).toBe("IDENTITY_A\n");
			expect((await fs.promises.stat(pathA)).mode & 0o777).toBe(0o755);

			const pathB = await __internalsForTesting.installAfmSidecar(
				cacheDir,
				undefined,
				async () => helperB,
				"arch-b",
			);
			expect(pathB).toBe(path.join(cacheDir, "omp-apple-fm-arch-b"));
			expect(pathB).not.toBe(pathA);
			expect(await Bun.file(pathA).text()).toBe("IDENTITY_A\n");
			expect(await Bun.file(pathB).text()).toBe("IDENTITY_B\n");
			expect((await fs.promises.stat(pathB)).mode & 0o777).toBe(0o755);

			const again = await __internalsForTesting.installAfmSidecar(
				cacheDir,
				undefined,
				async () => helperB,
				"arch-b",
			);
			expect(again).toBe(pathB);
			expect(await Bun.file(pathA).text()).toBe("IDENTITY_A\n");
			expect(await Bun.file(pathB).text()).toBe("IDENTITY_B\n");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps a published identity sidecar after a crash without deleting another identity", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-afm-cache-"));
		const cacheDir = path.join(dir, "apple-fm");
		const rename = fs.promises.rename.bind(fs.promises);
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
			await rename(source, target);
			if (path.basename(String(target)) === "omp-apple-fm-arch-b") {
				throw new Error("crash after publishing sidecar binary");
			}
		});
		try {
			const helperA = await writeHelper(dir, "helper-a", "IDENTITY_A\n");
			const helperB = await writeHelper(dir, "helper-b", "IDENTITY_B\n");
			const pathA = await __internalsForTesting.installAfmSidecar(
				cacheDir,
				undefined,
				async () => helperA,
				"arch-a",
			);
			expect(pathA).toBe(path.join(cacheDir, "omp-apple-fm-arch-a"));
			const pathB = path.join(cacheDir, "omp-apple-fm-arch-b");
			await expect(
				__internalsForTesting.installAfmSidecar(cacheDir, undefined, async () => helperB, "arch-b"),
			).rejects.toThrow("crash after publishing sidecar binary");
			expect(await Bun.file(pathB).text()).toBe("IDENTITY_B\n");
			expect(await Bun.file(pathA).text()).toBe("IDENTITY_A\n");
			renameSpy.mockRestore();
			await expect(
				__internalsForTesting.installAfmSidecar(cacheDir, undefined, async () => helperB, "arch-b"),
			).resolves.toBe(pathB);
			expect(await Bun.file(pathB).text()).toBe("IDENTITY_B\n");
			expect(await Bun.file(pathA).text()).toBe("IDENTITY_A\n");
		} finally {
			renameSpy.mockRestore();
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});
