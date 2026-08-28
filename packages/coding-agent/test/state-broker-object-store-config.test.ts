import { describe, expect, test } from "bun:test";
import type { ObjectStore, SettingsLike } from "@oh-my-pi/pi-coding-agent/state-broker/object-store";
import { resolveObjectStore } from "@oh-my-pi/pi-coding-agent/state-broker/object-store";

// These tests pin the config-value indirection contract for object-store
// credentials: the shipped docs advertise forms like `accessKeyId: !cat
// ~/.omp/s3-key` and env-var-name indirection, so `resolveObjectStore` MUST
// pass every credential/connection setting through the caller-supplied
// resolver before handing anything to `Bun.S3Client`. They use only plain
// local fakes — no `Bun.S3Client` mock, no global mutation, no log assertions
// — so they are safe under the concurrent full suite.

/** Plain fake settings backed by a record; mirrors the production `get` shape. */
function makeSettings(values: Record<string, unknown>): SettingsLike {
	return { get: (key: string) => values[key] };
}

/**
 * A resolver that records which raw values it was consulted with, so a test can
 * assert the credential keys actually flowed through the indirection layer
 * rather than the literal being forwarded. `map` translates a raw value to its
 * resolved value; unlisted raws pass through unchanged.
 */
function recordingResolver(map: Record<string, string> = {}): {
	resolve: (raw: string) => Promise<string | undefined>;
	seen: string[];
} {
	const seen: string[] = [];
	return {
		seen,
		resolve: async (raw: string) => {
			seen.push(raw);
			return raw in map ? map[raw] : raw;
		},
	};
}

/** True when the value is a live {@link ObjectStore} rather than the undefined fallback. */
function isStore(value: ObjectStore | undefined): value is ObjectStore {
	return value !== undefined && typeof value.put === "function" && typeof value.get === "function";
}

describe("resolveObjectStore config-value indirection", () => {
	test("resolves indirection forms for both credentials before constructing the client", async () => {
		// Raws are indirection forms (a `!cat` command and an env-var name). If the
		// literals were forwarded unresolved this store would still build (they are
		// non-empty), so the load-bearing assertion is that the resolver was
		// consulted with exactly those raws — proving resolution happened first.
		const { resolve, seen } = recordingResolver({
			"!cat ~/.omp/s3-key": "AKIAREALKEYID",
			OMP_S3_SECRET: "realsecretvalue",
		});
		const store = await resolveObjectStore(
			makeSettings({
				"objects.backend": "s3",
				"objects.s3.bucket": "my-bucket",
				"objects.s3.accessKeyId": "!cat ~/.omp/s3-key",
				"objects.s3.secretAccessKey": "OMP_S3_SECRET",
			}),
			resolve,
		);

		expect(isStore(store)).toBe(true);
		expect(seen).toContain("!cat ~/.omp/s3-key");
		expect(seen).toContain("OMP_S3_SECRET");
	});

	test("treats a present setting that resolves to empty as missing", async () => {
		// The credential is configured, but the indirection yields an empty string
		// (e.g. the referenced env var is unset). That MUST count as missing and
		// degrade to local-only rather than being forwarded as an empty credential.
		const { resolve } = recordingResolver({ OMP_S3_SECRET_UNSET: "" });
		const store = await resolveObjectStore(
			makeSettings({
				"objects.backend": "s3",
				"objects.s3.bucket": "my-bucket",
				"objects.s3.accessKeyId": "AKIAREALKEYID",
				"objects.s3.secretAccessKey": "OMP_S3_SECRET_UNSET",
			}),
			resolve,
		);

		expect(store).toBeUndefined();
	});

	test("degrades to undefined when the resolver rejects for a key", async () => {
		// An unreadable credential file (`!cat` of a missing path) surfaces as a
		// rejected promise from the async resolver. Startup MUST NOT crash; it
		// degrades to local-only exactly like a missing key.
		const resolve = (raw: string): Promise<string | undefined> => {
			if (raw === "!cat /missing/s3-key") return Promise.reject(new Error("no such file"));
			return Promise.resolve(raw);
		};
		let store: ObjectStore | undefined;
		await expect(
			(async () => {
				store = await resolveObjectStore(
					makeSettings({
						"objects.backend": "s3",
						"objects.s3.bucket": "my-bucket",
						"objects.s3.accessKeyId": "!cat /missing/s3-key",
						"objects.s3.secretAccessKey": "whatever",
					}),
					resolve,
				);
			})(),
		).resolves.toBeUndefined();
		expect(store).toBeUndefined();
	});

	test("short-circuits before touching the resolver when backend is not s3", async () => {
		// When object storage is off the resolver must never be consulted — no
		// credential work should happen for a disabled backend.
		const { resolve, seen } = recordingResolver();
		const store = await resolveObjectStore(
			makeSettings({
				"objects.backend": "off",
				"objects.s3.bucket": "my-bucket",
				"objects.s3.accessKeyId": "AKIAREALKEYID",
				"objects.s3.secretAccessKey": "realsecretvalue",
			}),
			resolve,
		);

		expect(store).toBeUndefined();
		expect(seen).toEqual([]);
	});
});
