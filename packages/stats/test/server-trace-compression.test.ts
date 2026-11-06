/**
 * The trace/entry payloads are the multi-MB responses. Verify the dashboard
 * sends them gzip-encoded when the client advertises gzip, while a 304 stays
 * bodyless and unencoded.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { startServer } from "@oh-my-pi/omp-stats/server";
import { buildSessionTrace } from "@oh-my-pi/omp-stats/trace";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-trace-gzip-");

const T = 1_700_000_000_000;
const PROJECT = "--tmp--proj--";
const iso = (ms: number) => new Date(ms).toISOString();

async function writeRoot(): Promise<string> {
	const projectDir = path.join(getSessionsDir(), PROJECT);
	const file = path.join(projectDir, "1700000000000_gzip.jsonl");
	await fs.mkdir(projectDir, { recursive: true });
	const entries = [
		{ type: "session", version: 3, id: "sess", timestamp: iso(T), cwd: "/tmp/proj" },
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: iso(T + 1000),
			message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: T + 1000 },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: iso(T + 2000),
			message: {
				role: "assistant",
				model: "m-1",
				provider: "p",
				api: "openai-completions",
				timestamp: T + 1500,
				duration: 500,
				completedAt: T + 2000,
				stopReason: "stop",
				content: [{ type: "text", text: "ok" }],
			},
		},
	];
	await Bun.write(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

describe("trace response compression", () => {
	it("gzip-encodes trace responses and leaves 304 bodyless", async () => {
		const file = await writeRoot();
		await buildSessionTrace(file); // warm the transcript cache
		const server = await startServer(0, "127.0.0.1");
		try {
			const endpoint = `http://127.0.0.1:${server.port}/api/session/trace?file=${encodeURIComponent(file)}`;
			const first = await fetch(endpoint, { headers: { "Accept-Encoding": "gzip" } });
			expect(first.status).toBe(200);
			expect(first.headers.get("content-encoding")).toBe("gzip");
			expect(first.headers.get("vary")).toContain("Accept-Encoding");
			const etag = first.headers.get("ETag");
			expect(etag).toBeTruthy();
			const trace = (await first.json()) as { file: string };
			expect(trace.file).toBe(file);

			const cached = await fetch(endpoint, {
				headers: { "Accept-Encoding": "gzip", "If-None-Match": etag! },
			});
			expect(cached.status).toBe(304);
			expect(cached.headers.get("content-encoding")).toBeNull();
			expect(await cached.text()).toBe("");
		} finally {
			server.stop();
		}
	});

	it("honors an explicit gzip;q=0 over a wildcard", async () => {
		const file = await writeRoot();
		const server = await startServer(0, "127.0.0.1");
		try {
			const endpoint = `http://127.0.0.1:${server.port}/api/session/trace?file=${encodeURIComponent(file)}`;
			const response = await fetch(endpoint, { headers: { "Accept-Encoding": "gzip;q=0, *;q=1" } });
			expect(response.status).toBe(200);
			expect(response.headers.get("content-encoding")).toBeNull();
			expect(((await response.json()) as { file: string }).file).toBe(file);
		} finally {
			server.stop();
		}
	});

	it("still gzips when only a wildcard permits it", async () => {
		const file = await writeRoot();
		const server = await startServer(0, "127.0.0.1");
		try {
			const endpoint = `http://127.0.0.1:${server.port}/api/session/trace?file=${encodeURIComponent(file)}`;
			const response = await fetch(endpoint, { headers: { "Accept-Encoding": "*;q=1" } });
			expect(response.headers.get("content-encoding")).toBe("gzip");
		} finally {
			server.stop();
		}
	});
});
