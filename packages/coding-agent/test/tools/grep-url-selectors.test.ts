import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type InternalResource,
	type InternalUrl,
	InternalUrlRouter,
	type ProtocolHandler,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// Compact JSON: the rendered form (`"marker": "RAWMARKER"`) and the raw bytes
// (`"marker":"RAWMARKER"`) differ only in whitespace, so a pattern pins which
// one the search actually saw.
const JSON_BODY = '{"marker":"RAWMARKER","n":1}';
const RAW_PATTERN = '"marker":"RAWMARKER"';
const RENDERED_PATTERN = '"marker": "RAWMARKER"';

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

function registerVirtualDocs(docs: Record<string, string>): void {
	const handler: ProtocolHandler = {
		scheme: "virtual",
		spec: { backing: "virtual", selectors: "lines", immutable: true },
		async resolve(url: InternalUrl): Promise<InternalResource> {
			const name = `${url.rawHost || url.hostname}${url.rawPathname ?? url.pathname}`.replace(/^\//, "");
			const content = docs[name];
			if (content === undefined) throw new Error(`Virtual doc not found: ${name}`);
			return {
				url: url.href,
				content,
				contentType: "text/plain",
				size: Buffer.byteLength(content, "utf-8"),
			};
		},
	};
	InternalUrlRouter.instance().register(handler);
}

describe("grep URL selectors against a live HTTP server", () => {
	let testDir: string;
	let server: Bun.Server<undefined>;
	let origin: string;
	let requestedPaths: string[];

	function createSession(): ToolSession {
		const sessionFile = path.join(testDir, "session.jsonl");
		let nextArtifactId = 0;
		return {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => sessionFile,
			getArtifactsDir: () => path.join(testDir, "artifacts"),
			getSessionSpawns: () => "*",
			allocateOutputArtifact: async toolType => {
				const id = String(nextArtifactId++);
				return { id, path: path.join(testDir, `${id}.${toolType}.log`) };
			},
			settings: Settings.isolated({
				"fetch.enabled": true,
				"grep.contextBefore": 0,
				"grep.contextAfter": 0,
			}),
		};
	}

	async function grep(pattern: string, scope: string) {
		const tools = await createTools(createSession());
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		return tool!.execute("grep-url-sel", { pattern, path: scope });
	}

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-url-selectors-"));
		requestedPaths = [];
		InternalUrlRouter.resetForTests();
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				requestedPaths.push(new URL(request.url).pathname);
				if (new URL(request.url).pathname === "/data.json") {
					return new Response(JSON_BODY, { headers: { "content-type": "application/json" } });
				}
				return new Response("not found\n", {
					status: 404,
					headers: { "content-type": "text/plain" },
				});
			},
		});
		origin = `http://127.0.0.1:${server.port}`;
	});

	afterEach(async () => {
		server.stop(true);
		InternalUrlRouter.resetForTests();
		await removeWithRetries(testDir);
	});

	it("without a selector, searches the rendered response", async () => {
		// Control: proves the raw and rendered forms are separable by pattern,
		// so a match below is attributable to the selector and nothing else.
		const rendered = resultText(await grep(RENDERED_PATTERN, `${origin}/data.json`));
		const raw = resultText(await grep(RAW_PATTERN, `${origin}/data.json`));

		expect(rendered).toContain("RAWMARKER");
		expect(raw).toBe("No matches found");
	});

	it(":raw searches the raw response bytes", async () => {
		const raw = resultText(await grep(RAW_PATTERN, `${origin}/data.json:raw`));
		const rendered = resultText(await grep(RENDERED_PATTERN, `${origin}/data.json:raw`));

		expect(raw).toContain("RAWMARKER");
		expect(rendered).toBe("No matches found");
		// The selector is a display mode, never part of the request.
		expect(requestedPaths).toEqual(["/data.json", "/data.json"]);
	});

	it(":conflicts on an external URL is rejected instead of reaching the request", async () => {
		// `:conflicts` is a git index display mode; an HTTP response has no index
		// stages, so there is nothing for it to select. Silently dropping it is
		// what happened before, and the compound form proved the selector can
		// reach the wire.
		await expect(grep(RAW_PATTERN, `${origin}/data.json:conflicts`)).rejects.toThrow(/conflicts/);
		await expect(grep(RAW_PATTERN, `${origin}/data.json:conflicts:raw`)).rejects.toThrow(/conflicts/);
		expect(requestedPaths).toEqual([]);
	});

	it("rejects a selector chunk that is not a URL selector instead of requesting it", async () => {
		// `splitPathAndSel` only peels chunks it recognises as selectors, so a
		// recognised-but-unpeelable one reaches the URL parser with nothing
		// extracted. `clean` then keeps the entry verbatim, so the chunk would be
		// requested as part of the URL. `img` is such a chunk: read accepts it on
		// files, the URL parser has no such mode.
		//
		// Contrast with a chunk read rejects as a selector entirely (`:abc`):
		// there `split.sel` is undefined, so the entry is a literal URL carrying a
		// `:abc` segment, and grep requests it exactly as `read` does. That is
		// correct, so it is deliberately not asserted here.
		await expect(grep(RAW_PATTERN, `${origin}/data.json:img`)).rejects.toThrow(/not a URL selector/);
		// Two range groups is the other shape: the URL parser refuses it outright.
		await expect(grep(RAW_PATTERN, `${origin}/data.json:1-1:1-2`)).rejects.toThrow(/multiple range groups/);
		expect(requestedPaths).toEqual([]);
	});

	it("rejects a tail selector rather than silently searching the whole response", async () => {
		// `:-10` means "the last 10 lines", resolved against a line count that does
		// not exist before the fetch. Search filters matches by absolute line, so
		// accepting it would widen to the entire response instead.
		await expect(grep(RAW_PATTERN, `${origin}/data.json:-10`)).rejects.toThrow(/tail selector/);
		expect(requestedPaths).toEqual([]);
	});

	it("applies a line range to a URL that carries a query string", async () => {
		// `?` is a glob char, so the local-path "not a glob" guard used to reject
		// this entry outright. A remote URL is never a local glob, so the entry must
		// reach the fetch and still be filtered by line. The range spans the whole
		// body because an `application/json` response renders across several lines,
		// so a tight range would exclude the marker for an unrelated reason. The
		// entry carries no `:raw`, so the pattern is the bare marker — this case is
		// about scope resolution, not raw mode, which the `:raw` case above pins.
		const text = resultText(await grep("RAWMARKER", `${origin}/data.json?v=2:1-10`));
		expect(text).toContain("RAWMARKER");
	});

	it("diverges from read on :conflicts, and says so rather than searching the wrong resource", async () => {
		// The divergence is deliberate and is what the rejection protects: `read`
		// resolves the compound form by requesting `…/data.json:conflicts`
		// verbatim, so grep rejecting it is the opposite of matching read. It is
		// the right way round — a selector meant as a display mode would otherwise
		// silently search a resource other than the one named. Asserting read's
		// behaviour here keeps the divergence honest: if read is ever fixed to
		// reject `:conflicts` too, this test fails and the pair is reconciled.
		const readTool = (await createTools(createSession())).find(entry => entry.name === "read")!;
		await readTool.execute("read-conflicts", { path: `${origin}/data.json:conflicts:raw` });
		expect(requestedPaths).toEqual(["/data.json:conflicts"]);

		await expect(grep(RAW_PATTERN, `${origin}/data.json:conflicts:raw`)).rejects.toThrow(/conflicts/);
		// Rejection happens before any fetch, so the path above was read's alone.
		expect(requestedPaths).toEqual(["/data.json:conflicts"]);
	});

	it("a selector-capable internal URL still searches the whole resource", async () => {
		// Deliberate, documented behavior for internal URIs: their display modes
		// carry no meaning for content search, so they are accepted and the
		// resource is searched whole.
		registerVirtualDocs({ "doc.md": "alpha\nneedle in virtual content\nomega\n" });
		const conflicts = resultText(await grep("needle", "virtual://doc.md:conflicts"));
		const raw = resultText(await grep("needle", "virtual://doc.md:raw"));

		expect(conflicts).toContain("needle in virtual content");
		expect(raw).toContain("needle in virtual content");
	});
});
