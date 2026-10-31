import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { DakeraApi } from "@oh-my-pi/pi-coding-agent/dakera/client";
import { loadDakeraConfig } from "@oh-my-pi/pi-coding-agent/dakera/config";
import { DakeraSessionState } from "@oh-my-pi/pi-coding-agent/dakera/state";
import { docIdFor, docMediaTypeForPath, docTextOf, docIngestSourceFor } from "@oh-my-pi/pi-coding-agent/dakera/ingest";
import { MemorySaveDocumentTool } from "@oh-my-pi/pi-coding-agent/tools/memory-save-document";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { asGlobalFetch } from "./helpers/fetch-mock";

interface Captured {
	method: string;
	url: string;
	body: Record<string, unknown>;
}
const requests: Captured[] = [];

function serve(respond: (request: Captured) => unknown): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch((input, init) => {
			const captured: Captured = {
				method: String(init?.method ?? "GET"),
				url: String(input),
				body: (init?.body === undefined ? {} : JSON.parse(String(init.body))) as Record<string, unknown>,
			};
			requests.push(captured);
			const reply = respond(captured) ?? {};
			if (isRecord(reply) && typeof reply.status === "number") {
				return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
			}
			return new Response(JSON.stringify(reply), { status: 200 });
		}),
	);
}
afterEach(() => {
	vi.restoreAllMocks();
	requests.length = 0;
});

const importRequests = (): Captured[] => requests.filter(r => r.url.endsWith("/v1/memory/documents"));

describe("dakera document ingest", () => {
	it("posts the import wire body and reads the job handle", async () => {
		serve(() => ({ job_id: "job1", document_id: "doc-1", status_url: "/jobs/job1" }));
		const config = loadDakeraConfig(Settings.isolated({ "dakera.apiUrl": "http://dakera.local" }));
		const client = new DakeraApi({ baseUrl: config.apiUrl ?? "http://dakera.local" });

		const result = await client.importDocument("omp", {
			content: "# Title\nbody",
			mediaType: "text/markdown",
			title: "Title",
			documentId: "doc-1",
		});

		expect(result).toEqual({ jobId: "job1", documentId: "doc-1", statusUrl: "/jobs/job1" });
		expect(importRequests()[0]?.body).toEqual({
			agent_id: "omp",
			content: "# Title\nbody",
			media_type: "text/markdown",
			title: "Title",
			document_id: "doc-1",
		});
	});

	// Replace-on-refetch semantics hang off these ids: the same source identity must
	// produce the same id (a later import replaces), different sources must not collide.
	it("derives stable, source-distinct document ids", () => {
		expect(docIdFor("web", "https://example.com/a")).toBe(docIdFor("web", "https://example.com/a"));
		expect(docIdFor("web", "https://example.com/a")).not.toBe(docIdFor("web", "https://example.com/b"));
		expect(docIdFor("gh", "o", "r", "p")).not.toBe(docIdFor("gh", "o", "r", "q"));
	});

	it("extracts source identity per tool: github path metadata, web url, context7 library", () => {
		const github = docIngestSourceFor("mcp__github_get_file_contents");
		expect(
			github?.extract({ owner: "acme", repo: "widgets", path: "docs/guide.md", ref: "main" }, "doc text"),
		).toEqual({
			content: "doc text",
			mediaType: "text/markdown",
			title: "acme/widgets/docs/guide.md",
			documentId: docIdFor("gh", "acme", "widgets", "docs/guide.md"),
		});

		const web = docIngestSourceFor("mcp__searxng_web_url_read");
		expect(web?.extract({ url: "https://example.com/docs" }, "page text")).toEqual({
			content: "page text",
			mediaType: "text/markdown",
			title: "https://example.com/docs",
			documentId: docIdFor("web", "https://example.com/docs"),
		});

		const context7 = docIngestSourceFor("mcp__context7_query_docs");
		const ingest = context7?.extract({ libraryId: "/vercel/ai", topic: "streaming" }, "doc text");
		expect(ingest?.title).toBe("context7 /vercel/ai streaming");
		expect(ingest?.documentId).toBe(docIdFor("ctx7", "/vercel/ai", "streaming"));
		expect(github?.extract({ owner: "acme" }, "doc text")).toBeUndefined();
		expect(docMediaTypeForPath("page.html")).toBe("text/html");
		expect(
			docTextOf({
				content: [
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
				],
			}),
		).toBe("a\nb");
	});

	// Auto-ingest: a successful whitelisted tool result becomes a document import
	// with the derived id; errors and unlisted tools must never touch the store.
	it("auto-imports whitelisted tool results and ignores everything else", async () => {
		serve(() => ({ job_id: "job1", document_id: "doc-1", status_url: "/jobs/job1" }));
		const config = loadDakeraConfig(
			Settings.isolated({
				"dakera.apiUrl": "http://dakera.local",
				"dakera.ingestToolResults": "mcp__github_get_file_contents",
			}),
		);
		let handler: ((event: unknown) => void) | undefined;
		const state = new DakeraSessionState({
			sessionId: "sess-1",
			client: new DakeraApi({ baseUrl: config.apiUrl ?? "http://dakera.local" }),
			agentId: "omp",
			config,
			session: {
				sessionManager: { getEntries: () => [], getSessionId: () => "sess-1" },
				subscribe: (fn: (event: unknown) => void) => {
					handler = fn;
					return () => undefined;
				},
			} as never,
		});
		state.attachSessionListeners();

		handler?.({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "mcp__github_get_file_contents",
			args: { owner: "acme", repo: "widgets", path: "docs/guide.md" },
		});
		handler?.({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "mcp__github_get_file_contents",
			result: { content: [{ type: "text", text: "doc text ".repeat(50) }] },
		});
		handler?.({
			type: "tool_execution_start",
			toolCallId: "t2",
			toolName: "bash",
			args: {},
		});
		handler?.({
			type: "tool_execution_end",
			toolCallId: "t2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "x".repeat(400) }] },
		});
		handler?.({
			type: "tool_execution_start",
			toolCallId: "t3",
			toolName: "mcp__github_get_file_contents",
			args: { owner: "acme", repo: "widgets", path: "docs/other.md" },
		});
		handler?.({
			type: "tool_execution_end",
			toolCallId: "t3",
			toolName: "mcp__github_get_file_contents",
			result: { content: [{ type: "text", text: "y".repeat(400) }] },
			isError: true,
		});
		await state.awaitPending();

		expect(importRequests()).toHaveLength(1);
		expect(importRequests()[0]?.body.document_id).toBe(docIdFor("gh", "acme", "widgets", "docs/guide.md"));
	});

	it("save_document imports exactly one source and infers the media type", async () => {
		serve(() => ({ job_id: "job1", document_id: "doc-1", status_url: "/jobs/job1" }));
		const config = loadDakeraConfig(Settings.isolated({ "dakera.apiUrl": "http://dakera.local" }));
		const state = new DakeraSessionState({
			sessionId: "sess-1",
			client: new DakeraApi({ baseUrl: config.apiUrl ?? "http://dakera.local" }),
			agentId: "omp",
			config,
			session: { sessionManager: { getEntries: () => [], getSessionId: () => "sess-1" } } as never,
		});
		const tool = new MemorySaveDocumentTool({
			settings: Settings.isolated({ "dakera.apiUrl": "http://dakera.local", "memory.backend": "dakera" }),
			getDakeraSessionState: () => state,
		} as unknown as ToolSession);

		const ok = await tool.execute("call-1", { text: "# Guide\ncontent", title: "Guide" });
		expect(ok.details).toEqual({ documentId: "doc-1", jobId: "job1" });
		expect(importRequests()[0]?.body).toMatchObject({
			content: "# Guide\ncontent",
			media_type: "text/plain",
			title: "Guide",
		});
		await expect(tool.execute("call-2", {})).rejects.toThrow("exactly one");
		await expect(tool.execute("call-3", { text: "a", path: "b" })).rejects.toThrow("exactly one");
	});
});
