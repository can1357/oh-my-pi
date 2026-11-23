/**
 * Read and search tools under the OS sandbox, on files omp itself wrote (a fetched web page, an
 * archive member's scratch copy, an internal URL's backing file): those live outside every
 * container root, so omp reads them itself instead of asking the container. A request to the
 * contained host for such a file would be refused on a real Linux sandbox, which hides the host's
 * temp dir. The contained cases skip where no backend exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { ContainedFileAccess } from "@oh-my-pi/pi-coding-agent/sandbox/file-access";
import type { HostRequest } from "@oh-my-pi/pi-coding-agent/sandbox/host-protocol";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { InternalResource, ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AstGrepTool } from "@oh-my-pi/pi-coding-agent/tools/ast-grep";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import {
	beginContainedSandboxTest,
	CONTAINED_SOURCE_RUNS,
	type ContainedSandboxTest,
	containedToolSession,
	endContainedSandboxTest,
	outcome,
	SANDBOX_BACKEND_PRESENT,
} from "../helpers/sandbox-test-state";

const PNG = encodeRawPng(new Uint8Array(3 * 2 * 3), 3, 2, 3);

let fixture: ContainedSandboxTest;
let workspace: string;

function toolSession(): ToolSession {
	return containedToolSession(fixture);
}

beforeEach(async () => {
	fixture = await beginContainedSandboxTest("contained-omp-files");
	({ workspace } = fixture);
});

afterEach(() => endContainedSandboxTest(fixture));

/** The paths the container was asked to open (`file.identify`) while a spy was installed. */
function identifiedPaths(spy: { mock: { calls: unknown[][] } }): string[] {
	return spy.mock.calls
		.map(([request]) => request as HostRequest)
		.filter(request => request.op === "file.identify")
		.map(request => request.path);
}

describe.skipIf(!SANDBOX_BACKEND_PRESENT || !CONTAINED_SOURCE_RUNS)("omp-owned files under the sandbox", () => {
	it("loads an archive's image member from its scratch copy without asking the container", async () => {
		const tar = await new Bun.Archive({ "pic.png": PNG }).bytes();
		fs.writeFileSync(path.join(workspace, "bundle.tar"), tar);
		const request = vi.spyOn(ContainedFileAccess.prototype, "request");

		const result = await new ReadTool(toolSession()).execute("call-archive-image", { path: "bundle.tar:pic.png" });

		expect(result.content.some(part => part.type === "image")).toBe(true);
		expect(identifiedPaths(request).filter(file => path.basename(file) === "member")).toEqual([]);
	});

	it("reads a binary internal URL from its backing file without asking the container", async () => {
		const handler: ProtocolHandler = {
			scheme: "bintest",
			spec: { backing: "remote", selectors: "opaque", immutable: true },
			async resolve(url): Promise<InternalResource<Buffer>> {
				return { url: url.href, content: PNG, contentType: "image/png", size: PNG.length };
			},
		};
		InternalUrlRouter.instance().register(handler);
		try {
			const request = vi.spyOn(ContainedFileAccess.prototype, "request");

			const result = await new ReadTool(toolSession()).execute("call-binary-url", { path: "bintest://pic" });

			expect(result.content.some(part => part.type === "image")).toBe(true);
			expect(identifiedPaths(request).filter(file => file.includes("omp-resource"))).toEqual([]);
		} finally {
			InternalUrlRouter.instance().unregister("bintest");
		}
	});

	it("lists a content-sniffed SQLite file's tables through the container's sqlite read", async () => {
		const dbPath = path.join(workspace, "state.vscdb");
		const db = new Database(dbPath);
		db.run("CREATE TABLE ItemTable (key TEXT, value TEXT)");
		db.close();
		const request = vi.spyOn(ContainedFileAccess.prototype, "request");

		const listing = await outcome(new ReadTool(toolSession()).execute("call-sniffed-db", { path: "state.vscdb" }));

		expect(listing).toContain("ItemTable");
		const ops = request.mock.calls.map(([message]) => (message as HostRequest).op);
		expect(ops).toContain("sqlite.read");
	});
});

describe.skipIf(!SANDBOX_BACKEND_PRESENT || !CONTAINED_SOURCE_RUNS)("fetched web pages under the sandbox", () => {
	let server: ReturnType<typeof Bun.serve>;
	let pageUrl: string;

	beforeEach(() => {
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () =>
				new Response("const WEB_NEEDLE_5 = 1;\n", { headers: { "content-type": "text/plain; charset=utf-8" } }),
		});
		pageUrl = `http://127.0.0.1:${server.port}/page.txt`;
	});

	afterEach(async () => {
		await server.stop(true);
	});

	it("greps a fetched page in omp, not in the container host", async () => {
		const native = vi.spyOn(ContainedFileAccess.prototype, "native");

		const found = await outcome(
			new GrepTool(toolSession()).execute("call-web", { pattern: "WEB_NEEDLE_\\d", path: pageUrl }),
		);

		expect(found).toContain("WEB_NEEDLE_5");
		expect(native).not.toHaveBeenCalled();
	});

	it("searches a fetched page with ast_grep in omp, not in the container host", async () => {
		const native = vi.spyOn(ContainedFileAccess.prototype, "native");

		const found = await outcome(
			new AstGrepTool(toolSession()).execute("call-web-ast", {
				pat: "const WEB_NEEDLE_5 = $V",
				lang: "typescript",
				path: pageUrl,
			}),
		);

		expect(found).toContain("WEB_NEEDLE_5");
		expect(native).not.toHaveBeenCalled();
	});
});
