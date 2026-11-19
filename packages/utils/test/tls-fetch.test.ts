import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { __resetExtraCaCache, ExtraCaError, type FetchImpl, wrapFetchForExtraCa } from "@oh-my-pi/pi-utils/tls-fetch";

const SAMPLE_PEM =
	"-----BEGIN CERTIFICATE-----\nMIIBkTCCATegAwIBAgIUF/sample/extra/ca/for/tests/1234567=\n-----END CERTIFICATE-----\n";
const SECONDARY_PEM =
	"-----BEGIN CERTIFICATE-----\nMIIBkTCCATegAwIBAgIUF/sample/extra/ca/for/tests/SECOND=\n-----END CERTIFICATE-----\n";

type CapturedInit = RequestInit & { tls?: { ca?: string | string[] } };

function makeRecordingFetch(): { fetchImpl: FetchImpl; calls: CapturedInit[] } {
	const calls: CapturedInit[] = [];
	const fetchImpl: FetchImpl = async (_input, init) => {
		calls.push((init ?? {}) as CapturedInit);
		return new Response("ok");
	};
	return { fetchImpl, calls };
}

describe("wrapFetchForExtraCa", () => {
	let tmpDir: string;
	let originalEnv: string | undefined;

	beforeEach(async () => {
		__resetExtraCaCache();
		originalEnv = Bun.env.NODE_EXTRA_CA_CERTS;
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extra-ca-"));
	});

	afterEach(async () => {
		__resetExtraCaCache();
		if (originalEnv === undefined) delete Bun.env.NODE_EXTRA_CA_CERTS;
		else Bun.env.NODE_EXTRA_CA_CERTS = originalEnv;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("returns the original fetch when NODE_EXTRA_CA_CERTS is unset", async () => {
		delete Bun.env.NODE_EXTRA_CA_CERTS;
		const { fetchImpl, calls } = makeRecordingFetch();

		const wrapped = wrapFetchForExtraCa(fetchImpl);
		expect(wrapped).toBe(fetchImpl);

		await wrapped("https://example.test/v1");
		expect(calls).toHaveLength(1);
		expect(calls[0].tls).toBeUndefined();
	});

	it("loads the CA bundle from a path and seeds the system root store", async () => {
		const caPath = path.join(tmpDir, "corp.pem");
		await Bun.write(caPath, SAMPLE_PEM);
		Bun.env.NODE_EXTRA_CA_CERTS = caPath;

		const { fetchImpl, calls } = makeRecordingFetch();
		const wrapped = wrapFetchForExtraCa(fetchImpl);
		await wrapped("https://corp.example/v1");

		expect(calls).toHaveLength(1);
		const ca = calls[0].tls?.ca;
		expect(ca).toContain(SAMPLE_PEM);
		// Default trust must remain — Bun's tls.ca REPLACES the system store
		// when set, so the wrapper has to prepend tls.rootCertificates.
		expect((ca as string[]).slice(0, tls.rootCertificates.length)).toEqual([...tls.rootCertificates]);
	});

	it("accepts an extensionless path per Node's NODE_EXTRA_CA_CERTS contract", async () => {
		const caPath = path.join(tmpDir, "corp-ca");
		await Bun.write(caPath, SAMPLE_PEM);
		Bun.env.NODE_EXTRA_CA_CERTS = caPath;

		const { fetchImpl, calls } = makeRecordingFetch();
		const wrapped = wrapFetchForExtraCa(fetchImpl);
		await wrapped("https://corp.example/v1");

		expect(calls[0].tls?.ca).toContain(SAMPLE_PEM);
	});

	it("accepts an inline PEM and expands escaped \\n", async () => {
		Bun.env.NODE_EXTRA_CA_CERTS = SAMPLE_PEM.replace(/\n/g, "\\n");

		const { fetchImpl, calls } = makeRecordingFetch();
		const wrapped = wrapFetchForExtraCa(fetchImpl);
		await wrapped("https://corp.example/v1");

		expect(calls[0].tls?.ca).toContain(SAMPLE_PEM);
	});

	it("appends to existing tls.ca without re-seeding system roots", async () => {
		const caPath = path.join(tmpDir, "corp.pem");
		await Bun.write(caPath, SAMPLE_PEM);
		Bun.env.NODE_EXTRA_CA_CERTS = caPath;

		const { fetchImpl, calls } = makeRecordingFetch();
		const wrapped = wrapFetchForExtraCa(fetchImpl);
		// Simulate the Anthropic Foundry path: caller already curated the CA
		// list with their own roots. Wrapper must append, not re-seed.
		await wrapped("https://corp.example/v1", { tls: { ca: [SECONDARY_PEM] } } as RequestInit);

		const ca = calls[0].tls?.ca as string[];
		expect(ca).toEqual([SECONDARY_PEM, SAMPLE_PEM]);
	});

	it("invalidates the cache when the bundle file is rewritten", async () => {
		const caPath = path.join(tmpDir, "rotating.pem");
		await Bun.write(caPath, SAMPLE_PEM);
		Bun.env.NODE_EXTRA_CA_CERTS = caPath;

		const { fetchImpl, calls } = makeRecordingFetch();
		const wrapped = wrapFetchForExtraCa(fetchImpl);
		await wrapped("https://corp.example/v1");
		expect(calls[0].tls?.ca).toContain(SAMPLE_PEM);

		// Bump mtime so the path@mtime cache key changes.
		const future = new Date(Date.now() + 5_000);
		await fs.utimes(caPath, future, future);
		await Bun.write(caPath, SECONDARY_PEM);
		await fs.utimes(caPath, future, future);

		await wrapped("https://corp.example/v1");
		const ca = calls[1].tls?.ca as string[];
		expect(ca).toContain(SECONDARY_PEM);
		expect(ca).not.toContain(SAMPLE_PEM);
	});

	it("throws ExtraCaError when the configured path does not exist", async () => {
		Bun.env.NODE_EXTRA_CA_CERTS = path.join(tmpDir, "missing.pem");

		const { fetchImpl } = makeRecordingFetch();
		const wrapped = wrapFetchForExtraCa(fetchImpl);
		await expect(wrapped("https://corp.example/v1")).rejects.toBeInstanceOf(ExtraCaError);
	});

	it("is idempotent — wrapping a wrapped fetch returns the same reference", async () => {
		const caPath = path.join(tmpDir, "corp.pem");
		await Bun.write(caPath, SAMPLE_PEM);
		Bun.env.NODE_EXTRA_CA_CERTS = caPath;

		const { fetchImpl } = makeRecordingFetch();
		const once = wrapFetchForExtraCa(fetchImpl);
		const twice = wrapFetchForExtraCa(once);
		expect(twice).toBe(once);
	});
});
