import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import {
	CONNECT_FLAG_COMPRESSED,
	CONNECT_FLAG_END_STREAM,
	CONNECT_MAX_FRAME_BYTES,
	ConnectFrameDecoder,
	encodeConnectFrame,
} from "../src/providers/cursor/connect";
import { cursorChecksum, inferenceRequestHeaders, RUN_INFERENCE_PATH } from "../src/providers/cursor/headers";
import type { CursorMachineIdentity, IdentityDependencies } from "../src/providers/cursor/identity";
import {
	deriveHostMachineId,
	deriveMacMachineId,
	executeIdentityCommand,
	firstUsableMac,
	loadCursorMachineIdentity,
	machineIdCommand,
	normalizeHardwareId,
} from "../src/providers/cursor/identity";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const decoded = (value: Uint8Array): string => new TextDecoder().decode(value);
const identity: CursorMachineIdentity = {
	machineId: "a".repeat(64),
	macMachineId: "b".repeat(64),
	machineIdSource: "host",
};

function dependencies(overrides: Partial<IdentityDependencies> = {}): IdentityDependencies {
	return {
		platform: "linux",
		arch: "x64",
		env: {},
		execute: async () => "0123456789abcdef\n",
		interfaces: () => ({ ethernet: [{ mac: "AA-BB-CC-DD-EE-FF" }] }),
		createUuid: () => "123e4567-e89b-42d3-a456-426614174000",
		...overrides,
	};
}

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cursor-identity-"));
	try {
		await run(directory);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

describe("Cursor managed-inference wire", () => {
	test("decodes one-byte chunks, gzip, trailers, and rejects hostile lengths", () => {
		const input = Buffer.concat([
			encodeConnectFrame(text("alpha")),
			encodeConnectFrame(gzipSync(text("beta")), CONNECT_FLAG_COMPRESSED),
			encodeConnectFrame(text("{}"), CONNECT_FLAG_END_STREAM),
		]);
		const decoder = new ConnectFrameDecoder();
		const frames = [...input].flatMap(byte => decoder.push(Uint8Array.of(byte)));
		decoder.end();
		expect(frames.map(({ body }) => decoded(body))).toEqual(["alpha", "beta", "{}"]);
		expect(frames.map(({ compressed, endOfStream }) => ({ compressed, endOfStream }))).toEqual([
			{ compressed: false, endOfStream: false },
			{ compressed: true, endOfStream: false },
			{ compressed: false, endOfStream: true },
		]);

		const prefix = new Uint8Array(5);
		new DataView(prefix.buffer).setUint32(1, CONNECT_MAX_FRAME_BYTES + 1, false);
		expect(() => new ConnectFrameDecoder().push(prefix)).toThrow("exceeds");

		const truncated = new ConnectFrameDecoder();
		truncated.push(encodeConnectFrame(text("tail")).subarray(0, 7));
		expect(() => truncated.end()).toThrow("mid-frame");
	});

	test("builds the exact IDE identity headers while rejecting caller overrides", () => {
		const requestId = "123e4567-e89b-42d3-a456-426614174000";
		const clientKey = "c".repeat(64);
		expect(cursorChecksum(identity, 1_700_000_000_000)).toBe(`Vfb45Bi9${"a".repeat(64)}/${"b".repeat(64)}`);
		const headers = inferenceRequestHeaders({
			token: "token-0123456789abcdefghijklmnopqrstuvwxyz",
			ghostMode: false,
			identity,
			requestId,
			clientKey,
			callerHeaders: { Authorization: "attacker", Connection: "close", "x-trace": "kept" },
			nowMs: 1_700_000_000_000,
			timezone: "America/Sao_Paulo",
			platform: "linux",
			arch: "x64",
		});
		expect(headers).toMatchObject({
			":path": RUN_INFERENCE_PATH,
			authorization: "Bearer token-0123456789abcdefghijklmnopqrstuvwxyz",
			"x-cursor-client-commit": "2ba48ff3f7514cc4643c52ca9f7b3173d9b66130",
			"x-cursor-client-type": "ide",
			"x-cursor-client-version": "3.18.9",
			"x-trace": "kept",
		});
		expect(headers.connection).toBeUndefined();
	});

	test("bounds and concurrently drains the host identity command", async () => {
		expect(await executeIdentityCommand("head -c 131072 /dev/zero >&2; printf done", "linux", {}, 1_000)).toBe(
			"done",
		);
		const started = performance.now();
		await expect(executeIdentityCommand("sleep 30", "linux", {}, 25)).rejects.toThrow("Timed out");
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	test("derives Cursor's platform and MAC identity exactly", async () => {
		expect(machineIdCommand("darwin", "arm64", {})).toBe("ioreg -rd1 -c IOPlatformExpertDevice");
		expect(
			normalizeHardwareId("darwin", '    "IOPlatformUUID" = "ABC-123"\n    "IOPlatformSerialNumber" = "ignored"'),
		).toBe("abc-123");
		expect(await deriveHostMachineId(dependencies())).toBe(
			"9f9f5111f7b27a781f1f1ddde5ebc2dd2b796bfc7365c9c28b548e564176929f",
		);
		const interfaces = {
			loopback: [{ mac: "00:00:00:00:00:00" }],
			virtual: [{ mac: "AC-DE-48-00-11-22" }],
			ethernet: [{ mac: "AA-BB-CC-DD-EE-FF" }],
		};
		expect(firstUsableMac(interfaces)).toBe("AA-BB-CC-DD-EE-FF");
		expect(deriveMacMachineId({ interfaces: () => interfaces })).toBe(
			"4ede89a251930543e704b69f048db754f41e528296cf963d8ba66238781e429b",
		);
		expect(deriveMacMachineId({ interfaces: () => ({ loopback: [{ mac: "00:00:00:00:00:00" }] }) })).toBeUndefined();
	});

	test("persists one owner-only fallback and rejects corrupt identity", async () => {
		await withTempDir(async directory => {
			const fallback = "123e4567-e89b-42d3-a456-426614174000";
			const deps = dependencies({ platform: "aix", interfaces: () => ({}), createUuid: () => fallback });
			expect(await loadCursorMachineIdentity(directory, deps)).toEqual({
				machineId: fallback,
				machineIdSource: "fallback",
			});
			const identityPath = path.join(directory, "cursor", "identity.json");
			expect((await fs.stat(identityPath)).mode & 0o777).toBe(0o600);
			expect(await fs.readFile(identityPath, "utf8")).toBe(`${JSON.stringify({ machineId: fallback })}\n`);
			await fs.chmod(identityPath, 0o600);
			await fs.writeFile(identityPath, '{"machineId":"bad"}\n');
			await expect(loadCursorMachineIdentity(directory, deps)).rejects.toThrow(
				"Persisted Cursor fallback identity is invalid",
			);
		});
	});

	test("serializes concurrent fallback identity creation", async () => {
		await withTempDir(async directory => {
			let nextUuid = 0;
			const identities = await Promise.all(
				Array.from({ length: 8 }, () =>
					loadCursorMachineIdentity(
						directory,
						dependencies({
							platform: "aix",
							interfaces: () => ({}),
							createUuid: () => `123e4567-e89b-42d3-a456-${String(++nextUuid).padStart(12, "0")}`,
						}),
					),
				),
			);
			expect(new Set(identities.map(identity => identity.machineId))).toEqual(
				new Set(["123e4567-e89b-42d3-a456-000000000001"]),
			);
			const identityPath = path.join(directory, "cursor", "identity.json");
			expect((await fs.stat(identityPath)).mode & 0o777).toBe(0o600);
		});
	});
});
