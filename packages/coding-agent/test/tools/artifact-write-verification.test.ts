/**
 * Contract: a tool that allocates an artifact path publishes its id only after
 * the bytes are verified on disk.
 *
 * `ArtifactManager.save()` routes through `writeArtifact()`, which stages a
 * sibling temp file and checks the written byte count, the on-disk size, and
 * readability before an atomic rename. The `allocateOutputArtifact()` +
 * caller-writes shape bypassed that helper and wrote with a bare `Bun.write()`,
 * so a short write published an id for a truncated file — the same failure
 * reproduced for #9646, at call sites #9649 did not reach.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { saveArtifactText } from "@oh-my-pi/pi-coding-agent/tools/gh-common";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

let testDir: string;
let artifactsDir: string;

function makeSession(): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	let nextArtifactId = 0;
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		allocateOutputArtifact: async (toolType: string) => {
			const id = String(nextArtifactId++);
			return { id, path: path.join(artifactsDir, `${id}.${toolType}.log`) };
		},
		settings: Settings.isolated({ "fetch.enabled": true }),
	} as unknown as ToolSession;
}

/**
 * Model the #9646 short write: writes inside the artifacts directory land
 * partially and report the truncated count. Every other write passes through so
 * the mock cannot disturb unrelated files.
 */
function shortWriteArtifacts(): void {
	const realWrite = Bun.write.bind(Bun);
	vi.spyOn(Bun, "write").mockImplementation(async (target, content) => {
		if (typeof target === "string" && target.startsWith(artifactsDir)) {
			await realWrite(target, String(content).slice(0, 3));
			return 3;
		}
		return realWrite(target as Parameters<typeof realWrite>[0], content as string);
	});
}

beforeEach(() => {
	testDir = path.join(os.tmpdir(), `omp-artifact-write-verification-${Snowflake.next()}`);
	artifactsDir = path.join(testDir, "session");
	fs.mkdirSync(artifactsDir, { recursive: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	removeSyncWithRetries(testDir);
});

describe("gh result artifacts", () => {
	it("publishes no artifact id when the write falls short", async () => {
		shortWriteArtifacts();

		const artifactId = await saveArtifactText(makeSession(), "gh", "full run watch result body");

		// An id here would be advertised as artifact://<id> by
		// appendArtifactReference() while the file holds 3 of 26 bytes.
		expect(artifactId).toBeUndefined();
		// Neither the destination nor a staging file survives.
		expect(fs.readdirSync(artifactsDir)).toEqual([]);
	});

	it("publishes the artifact id and the whole body on a good write", async () => {
		const body = "full run watch result body";

		const artifactId = await saveArtifactText(makeSession(), "gh", body);

		expect(artifactId).toBe("0");
		expect(fs.readFileSync(path.join(artifactsDir, "0.gh.log"), "utf8")).toBe(body);
	});
});

describe("read URL artifacts", () => {
	/** Long enough that the read output truncates and needs a spill artifact. */
	const LONG_BODY = "content line\n".repeat(40_000);

	function stubLoadPage(body: string): void {
		vi.spyOn(scrapers, "loadPage").mockImplementation(async (requestedUrl: string) => ({
			ok: true,
			status: 200,
			finalUrl: requestedUrl,
			contentType: "text/plain",
			content: body,
		}));
	}

	it("publishes no artifact id when the spill write falls short", async () => {
		stubLoadPage(LONG_BODY);
		shortWriteArtifacts();

		const result = await new ReadTool(makeSession()).execute("call", { path: "https://example.com/big.txt" });
		const truncation = result.details?.meta?.truncation;

		// Truncation metadata proves this is the path that spills an artifact.
		if (!truncation) throw new Error("expected the read output to truncate");
		// This id is what the renderer turns into `artifact://<id>`; publishing it
		// would point the caller at 3 bytes of the withheld output.
		expect(truncation.artifactId).toBeUndefined();
		// Neither the destination nor a staging file survives.
		expect(fs.readdirSync(artifactsDir)).toEqual([]);
	});

	it("publishes the artifact id once the spill write is verified", async () => {
		stubLoadPage(LONG_BODY);

		const result = await new ReadTool(makeSession()).execute("call", { path: "https://example.com/big.txt" });
		const truncation = result.details?.meta?.truncation;

		if (!truncation) throw new Error("expected the read output to truncate");
		expect(truncation.artifactId).toBe("0");
		// The spilled artifact holds every byte the preview was cut from, which is
		// exactly what verifying the write before publishing the id guarantees.
		expect(truncation.totalBytes).toBeGreaterThan(truncation.outputBytes);
		expect(fs.statSync(path.join(artifactsDir, "0.read.log")).size).toBe(truncation.totalBytes);
	});
});
