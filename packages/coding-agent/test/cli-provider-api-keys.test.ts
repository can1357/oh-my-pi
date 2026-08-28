import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import {
	installProviderApiKeys,
	readProviderApiKeyBundle,
	readProviderApiKeyBundleFd,
} from "@oh-my-pi/pi-coding-agent/cli/provider-api-keys";
import { mergeAuthHeaderSources } from "@oh-my-pi/pi-coding-agent/config/custom-models";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { $ } from "bun";

const roots: string[] = [];
const providerApiKeysModuleUrl = pathToFileURL(path.join(import.meta.dir, "../src/cli/provider-api-keys.ts")).href;

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Read-then-install pairing used by the runtime bundle path. */
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

	it("recognizes the equals-form descriptor flag after a missing credential-file value", () => {
		const parsed = parseArgs(["--provider-api-keys", "--provider-api-keys-fd=7"]);
		expect(parsed.providerApiKeys).toBe("");
		expect(parsed.providerApiKeysFd).toBe("7");
		expect(parsed.messages).toEqual([]);
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

	it("materializes runtime-only auth headers for authHeader providers without a configured key", () => {
		// authHeader: true with no apiKey and no static headers is valid when the
		// credential comes exclusively from the runtime bundle; the resolver must
		// consult the override instead of returning no headers at all.
		const headers = mergeAuthHeaderSources([], true, undefined, () => "runtime-key");
		expect(headers?.Authorization).toBe("Bearer runtime-key");
	});
});
