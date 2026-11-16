import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ensureAgyInstalled, resolveAgyBinary, updateAgyBinary } from "../src/providers/antigravity-cli/binary";
import type { FetchImpl } from "../src/types";

/** Serves a release manifest and archive in memory without running an installer or contacting Google. */
async function release(
	version: string,
	executable: string,
	checksum?: string,
): Promise<{ fetch: FetchImpl; requests: string[] }> {
	const payload = await new Bun.Archive({ antigravity: executable }, { compress: "gzip" }).bytes();
	const requests: string[] = [];
	const manifest = {
		version,
		url: `https://storage.googleapis.com/antigravity-public/${version}/cli.tar.gz`,
		sha512: checksum ?? new Bun.CryptoHasher("sha512").update(payload).digest("hex"),
	};
	const fetchRelease: FetchImpl = async input => {
		const url = input instanceof Request ? input.url : String(input);
		requests.push(url);
		return url.endsWith(".json") ? Response.json(manifest) : new Response(payload);
	};
	return { fetch: fetchRelease, requests };
}

/**
 * Serves a release body one chunk per read, advancing the fake clock `gapMs` before each chunk.
 * After `silentAfter` chunks the connection stays open without sending, as a stalled proxy does.
 */
async function trickle(gapMs: number, silentAfter = Infinity): Promise<{ fetch: FetchImpl; silent: Promise<void> }> {
	const payload = await new Bun.Archive({ antigravity: "slow executable" }, { compress: "gzip" }).bytes();
	const manifest = {
		version: "1.5.9",
		url: "https://storage.googleapis.com/antigravity-public/1.5.9/cli.tar.gz",
		sha512: new Bun.CryptoHasher("sha512").update(payload).digest("hex"),
	};
	const silent = Promise.withResolvers<void>();
	const fetchRelease: FetchImpl = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.endsWith(".json")) return Response.json(manifest);
		const size = Math.ceil(payload.length / 5);
		const signal = init?.signal;
		let chunks = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				start(controller) {
					signal?.addEventListener("abort", () => controller.error(signal.reason));
				},
				pull(controller) {
					if (chunks >= silentAfter) {
						silent.resolve();
						return Promise.withResolvers<void>().promise;
					}
					vi.advanceTimersByTime(gapMs);
					controller.enqueue(payload.subarray(chunks * size, ++chunks * size));
					if (chunks * size >= payload.length) controller.close();
				},
			},
			{ highWaterMark: 0 },
		);
		return new Response(body, { headers: { "content-length": String(payload.length) } });
	};
	return { fetch: fetchRelease, silent: silent.promise };
}

afterEach(() => {
	vi.useRealTimers();
});

function managedBinary(directory: string, version = "1.5.9"): string {
	return path.join(directory, version, process.platform === "win32" ? "agy.exe" : "agy");
}

async function executable(file: string, script: string): Promise<void> {
	await Bun.write(file, script);
	await fs.chmod(file, 0o755);
}

it("concurrent first-use requests install one verified executable without running the profile installer", async () => {
	using temp = TempDir.createSync("@omp-agy-download-");
	const directory = temp.join("bin");
	const remote = await release("1.5.9", "downloaded executable bytes");
	const paths = await Promise.all([
		ensureAgyInstalled(directory, remote.fetch),
		ensureAgyInstalled(directory, remote.fetch),
	]);
	expect(paths[0]).toBe(paths[1]);
	expect(await Bun.file(paths[0]!).text()).toBe("downloaded executable bytes");
	expect(remote.requests.filter(url => url.endsWith(".tar.gz"))).toHaveLength(1);
	await ensureAgyInstalled(directory, remote.fetch);
	expect(remote.requests).toHaveLength(2);
});

it("a corrupt update preserves the previous binary and a subsequent valid release replaces only the current pointer", async () => {
	using temp = TempDir.createSync("@omp-agy-upgrade-");
	const directory = temp.join("bin");
	const initial = await release("1.5.9", "version one");
	const original = await ensureAgyInstalled(directory, initial.fetch);
	await Bun.write(path.join(directory, "install.json"), JSON.stringify({ version: "1.5.9", checkedAt: 0 }));
	const corrupt = await release("1.6.0", "version two", "0".repeat(128));
	await expect(updateAgyBinary(directory, corrupt.fetch)).rejects.toThrow("SHA-512");
	expect(await Bun.file(original).text()).toBe("version one");
	expect((await Bun.file(path.join(directory, "install.json")).json()).version).toBe("1.5.9");
	const valid = await release("1.6.0", "version two");
	const upgraded = await updateAgyBinary(directory, valid.fetch);
	expect(upgraded).not.toBe(original);
	expect(await Bun.file(upgraded).text()).toBe("version two");
	expect(await Bun.file(original).text()).toBe("version one");
	expect(await ensureAgyInstalled(directory, valid.fetch)).toBe(upgraded);
});

it("a slow release that keeps sending installs even when the whole download outlasts the stall window", async () => {
	vi.useFakeTimers();
	using temp = TempDir.createSync("@omp-agy-slow-");
	// Five chunks 50 s apart: 250 s in total, never 60 s without data.
	const remote = await trickle(50_000);
	const binary = await ensureAgyInstalled(temp.join("bin"), remote.fetch);
	expect(await Bun.file(binary).text()).toBe("slow executable");
});

it("a download that stops sending fails as a stalled download and installs nothing", async () => {
	vi.useFakeTimers();
	using temp = TempDir.createSync("@omp-agy-stall-");
	const directory = temp.join("bin");
	const remote = await trickle(1_000, 2);
	const install = ensureAgyInstalled(directory, remote.fetch);
	await remote.silent;
	vi.advanceTimersByTime(60_000);
	await expect(install).rejects.toThrow(/Antigravity CLI download stalled: no data for 60s after .+ of /);
	expect(await Bun.file(path.join(directory, "install.json")).exists()).toBe(false);
});
it("uses a compatible agy from PATH without downloading the managed release", async () => {
	using temp = TempDir.createSync("@omp-agy-path-");
	const requests: string[] = [];
	const binary = await resolveAgyBinary(
		async input => {
			requests.push(String(input));
			throw new Error("network");
		},
		{
			directory: temp.join("bin"),
			which: () => "/opt/agy/bin/agy",
			probe: async () => "1.5.9 (build 42)",
		},
	);
	expect(binary).toBe("/opt/agy/bin/agy");
	expect(requests).toEqual([]);
});

it("falls back to the managed release when the PATH agy is too old", async () => {
	using temp = TempDir.createSync("@omp-agy-old-");
	const directory = temp.join("bin");
	const remote = await release("1.5.9", "managed executable");
	const binary = await resolveAgyBinary(remote.fetch, {
		directory,
		which: () => "/opt/agy/bin/agy",
		probe: async () => "1.5.8",
	});
	expect(binary).toBe(managedBinary(directory));
	expect(await Bun.file(binary).text()).toBe("managed executable");
});

it("falls back when the PATH agy probe fails or reports no version", async () => {
	using temp = TempDir.createSync("@omp-agy-probe-");
	const directory = temp.join("bin");
	const remote = await release("1.5.9", "managed executable");
	for (const probe of [
		async () => {
			throw new Error("probe failed");
		},
		async () => undefined,
	]) {
		const binary = await resolveAgyBinary(remote.fetch, { directory, which: () => "/opt/agy/bin/agy", probe });
		expect(binary).toBe(managedBinary(directory));
	}
});

it("keeps PI_AGY_PATH ahead of PATH discovery", async () => {
	using temp = TempDir.createSync("@omp-agy-override-");
	const previous = process.env.PI_AGY_PATH;
	process.env.PI_AGY_PATH = "/override/agy";
	try {
		const binary = await resolveAgyBinary(
			async () => {
				throw new Error("network");
			},
			{
				directory: temp.join("bin"),
				which: () => "/opt/agy/bin/agy",
				probe: async () => "1.5.9",
			},
		);
		expect(binary).toBe("/override/agy");
	} finally {
		if (previous === undefined) delete process.env.PI_AGY_PATH;
		else process.env.PI_AGY_PATH = previous;
	}
});

it("installs the managed release when no agy is on PATH", async () => {
	using temp = TempDir.createSync("@omp-agy-missing-");
	const directory = temp.join("bin");
	const remote = await release("1.5.9", "managed executable");
	const binary = await resolveAgyBinary(remote.fetch, { directory, which: () => null });
	expect(binary).toBe(managedBinary(directory));
});

it.skipIf(process.platform === "win32")("reads the installed CLI version through agy acp --version", async () => {
	using temp = TempDir.createSync("@omp-agy-version-");
	const cli = temp.join("agy");
	await executable(cli, "#!/bin/sh\nprintf '1.5.9\\n'\n");
	const binary = await resolveAgyBinary(
		async () => {
			throw new Error("network");
		},
		{ directory: temp.join("bin"), which: () => cli },
	);
	expect(binary).toBe(cli);
});

it.skipIf(process.platform === "win32")("rejects an installed CLI below the supported version", async () => {
	using temp = TempDir.createSync("@omp-agy-version-old-");
	const cli = temp.join("agy");
	await executable(cli, "#!/bin/sh\nprintf '1.5.8\\n'\n");
	const directory = temp.join("bin");
	const remote = await release("1.5.9", "managed executable");
	const binary = await resolveAgyBinary(remote.fetch, { directory, which: () => cli });
	expect(binary).toBe(managedBinary(directory));
});

it.skipIf(process.platform === "win32")("re-probes a CLI path after its version changes", async () => {
	using temp = TempDir.createSync("@omp-agy-reprobe-");
	const cli = temp.join("agy");
	const directory = temp.join("bin");
	const remote = await release("1.5.9", "managed executable");
	const resolve = () => resolveAgyBinary(remote.fetch, { directory, which: () => cli });

	await executable(cli, "#!/bin/sh\nprintf '1.5.8\\n'\n");
	expect(await resolve()).toBe(managedBinary(directory));

	await executable(cli, "#!/bin/sh\nprintf '1.5.9\\n'\n");
	expect(await resolve()).toBe(cli);

	await executable(cli, "#!/bin/sh\nprintf '1.5.8\\n'\n");
	expect(await resolve()).toBe(managedBinary(directory));
});

it("accepts a newer CLI and rejects prerelease or malformed versions", async () => {
	using temp = TempDir.createSync("@omp-agy-versions-");
	const directory = temp.join("bin");
	const remote = await release("1.5.9", "managed executable");
	for (const [version, compatible] of [
		["1.5.10", true],
		["1.5.10+abc.def", true],
		["1.5.9-rc.1", false],
		["1.6.0-rc.1", false],
		["1.5.10+.", false],
		["1.5.9junk", false],
	] as const) {
		const binary = await resolveAgyBinary(remote.fetch, {
			directory,
			which: () => "/opt/agy/bin/agy",
			probe: async () => version,
		});
		expect(binary).toBe(compatible ? "/opt/agy/bin/agy" : managedBinary(directory));
	}
});

it.skipIf(process.platform === "win32")("ignores relative PATH entries during discovery", async () => {
	using temp = TempDir.createSync("@omp-agy-relative-");
	const bin = temp.join("bin");
	await executable(path.join(bin, "agy"), "#!/bin/sh\nprintf '1.5.9\\n'\n");
	const directory = temp.join("managed");
	const remote = await release("1.5.9", "managed executable");
	const previous = process.env.PATH;
	process.env.PATH = path.relative(process.cwd(), bin);
	try {
		const binary = await resolveAgyBinary(remote.fetch, { directory });
		expect(binary).toBe(managedBinary(directory));
	} finally {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
	}
});
