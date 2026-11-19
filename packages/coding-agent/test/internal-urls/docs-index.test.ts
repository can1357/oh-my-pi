import { describe, expect, it } from "bun:test";
import { gzipSync } from "node:zlib";
import { decodeDocsIndex } from "@oh-my-pi/pi-coding-agent/internal-urls/docs-index";
import { buildDocsIndexPayload } from "../../scripts/generate-docs-index";

function embed(files: readonly string[], bodies: readonly string[]): string {
	return `${JSON.stringify(files)}\n${Buffer.from(gzipSync(Buffer.from(JSON.stringify(bodies)))).toString("base64")}`;
}

const files = ["agent.md", "tools/read.md"];
const bodies = ["agent body", "read body"];
const embedPayload = embed(files, bodies);

// The embed path only runs in compiled binaries / the npm bundle; dev tests
// otherwise exercise the disk fallback (empty placeholder), so a regression in
// the two-line `<filenames>\n<gzip bodies>` parsing would ship broken `omp://`
// docs undetected. These cover the populated-embed decode directly.
describe("decodeDocsIndex (embedded docs path)", () => {
	it("lists filenames from the first line without inflating the blob", () => {
		// A deliberately corrupt blob: filenames must resolve anyway, proving the
		// listing path never decodes the gzip body.
		const index = decodeDocsIndex(`${JSON.stringify(files)}\n@@@not-a-valid-gzip-blob@@@`);
		expect(index?.filenames).toEqual(files);
	});

	it("resolves bodies by index-aligned path, lazily, on first read", async () => {
		const index = decodeDocsIndex(embedPayload);
		expect(index).not.toBeNull();
		expect(await index?.getBody("agent.md")).toBe("agent body");
		expect(await index?.getBody("tools/read.md")).toBe("read body");
		expect(await index?.getBody("missing.md")).toBeUndefined();
	});

	it("returns null when there is no newline separator (empty placeholder)", () => {
		expect(decodeDocsIndex("")).toBeNull();
	});
});

describe("shipped docs embed (generator↔runtime contract)", () => {
	// bundle-dist.ts writes buildDocsIndexPayload().payload to
	// dist/docs-index.generated.txt, which docs-index.ts reads back via
	// decodeDocsIndex for npm/SDK consumers. If the generator's encoding and the
	// runtime decoder drift, the shipped embed silently fails to resolve, so
	// assert the real generator output round-trips through the runtime decoder.
	it("decodes the real generator payload with round-tripped filenames and bodies", async () => {
		const payload = await buildDocsIndexPayload();
		const index = decodeDocsIndex(payload.payload);
		expect(index).not.toBeNull();
		expect(index?.filenames).toEqual([...payload.files]);
		const first = payload.files[0];
		expect(first).toBeDefined();
		expect(await index?.getBody(first)).toBe(payload.bodies[0]);
	});
});
