/**
 * Regression: trace ETags must stay fixed-size even when the child-transcript
 * fingerprint is large. The dashboard echoes the ETag in `If-None-Match`; an
 * unbounded fingerprint makes that request header exceed Bun's 16 KiB limit
 * and the next poll fails with HTTP 431.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { handleApi } from "@oh-my-pi/omp-stats/server";
import { buildSessionTrace, TRACE_ETAG_VERSION, traceFingerprintForEtag } from "@oh-my-pi/omp-stats/trace";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-trace-etag-");

const T = 1_700_000_000_000;
const PROJECT = "--tmp--proj--";
const STEM = "1700000000000_etag";
const ROOT_BASE = `${STEM}.jsonl`;

async function writeHeavyFixture(childCount: number): Promise<string> {
	const projectDir = path.join(getSessionsDir(), PROJECT);
	const rootFile = path.join(projectDir, ROOT_BASE);
	const childDir = path.join(projectDir, STEM);
	await fs.mkdir(childDir, { recursive: true });
	await Bun.write(
		rootFile,
		`${JSON.stringify({ type: "session", version: 3, id: "root", timestamp: new Date(T).toISOString() })}\n`,
	);
	const child = `${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: new Date(T).toISOString() })}\n`;
	for (let i = 0; i < childCount; i++) {
		// Long names mirror nested subagent transcripts and make the unbounded
		// fingerprint exceed the header budget quickly.
		const name = `agent-${String(i).padStart(4, "0")}-${"x".repeat(48)}.jsonl`;
		await Bun.write(path.join(childDir, name), child);
	}
	return rootFile;
}

describe("trace ETag", () => {
	it("hashes an oversized child fingerprint to a fixed-size header value", async () => {
		const rootFile = await writeHeavyFixture(400);
		const fingerprint = await traceFingerprintForEtag(rootFile);
		expect(fingerprint).toBeDefined();
		// The raw fingerprint is intentionally large; only its digest is sent back.
		expect(fingerprint?.childFingerprint.length).toBeGreaterThan(16 * 1024);

		const trace = await buildSessionTrace(rootFile, fingerprint);
		const wireEtag = `"${TRACE_ETAG_VERSION}:${trace.etag}"`;
		expect(wireEtag.length).toBeLessThan(128);
		expect(new TextEncoder().encode(`If-None-Match: ${wireEtag}`).length).toBeLessThan(1024);

		// The HTTP layer must emit that same compact value and still revalidate.
		const url = `http://127.0.0.1/api/session/trace?file=${encodeURIComponent(rootFile)}`;
		const first = await handleApi(new Request(url));
		expect(first.status).toBe(200);
		const responseEtag = first.headers.get("ETag");
		expect(responseEtag).toBe(wireEtag);
		await first.arrayBuffer();

		const revalidated = await handleApi(new Request(url, { headers: { "If-None-Match": responseEtag! } }));
		expect(revalidated.status).toBe(304);
	});
});
