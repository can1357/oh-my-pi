import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { isDakeraConfigured, loadDakeraConfig } from "../dakera/config";
import { type DocMediaType, docMediaTypeForPath } from "../dakera/ingest";
import saveDocumentDescription from "../prompts/tools/save-document.md" with { type: "text" };
import { cfgMemoryBackend } from "../memory-backend/settings";
import type { ToolSession } from ".";

const saveDocumentSchema = type({
	"path?": type("string").describe("local file to read and import"),
	"url?": type("string").describe("web page to fetch and import"),
	"text?": type("string").describe("literal content to import"),
	"title?": type("string").describe("document title; defaults to the path or URL"),
	"media_type?": type("'text/plain' | 'text/markdown' | 'text/html'").describe(
		"content format; inferred from the source when omitted",
	),
	"document_id?": type("string").describe(
		"stable id; re-saving the same id replaces the document (defaults to a content hash)",
	),
});

export type SaveDocumentParams = typeof saveDocumentSchema.infer;

/** Infer the content format: explicit override, then the source extension, then an HTML sniff for fetched pages. */
function inferMediaType(
	params: SaveDocumentParams,
	origin: string | undefined,
	isUrl: boolean,
	content: string,
): DocMediaType {
	if (params.media_type !== undefined) return params.media_type;
	if (origin !== undefined) {
		const byPath = docMediaTypeForPath(origin);
		if (byPath !== "text/plain") return byPath;
	}
	const head = content.slice(0, 512).toLowerCase();
	if (isUrl && (head.includes("<html") || head.startsWith("<!doctype"))) return "text/html";
	return "text/plain";
}

export class MemorySaveDocumentTool implements AgentTool<typeof saveDocumentSchema> {
	readonly name = "save_document";
	readonly approval = "read" as const;
	readonly label = "Save Document";
	readonly description = saveDocumentDescription;
	readonly parameters = saveDocumentSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Import a document into memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemorySaveDocumentTool | null {
		const backend = cfgMemoryBackend.get(session.settings);
		if (backend !== "dakera") return null;
		if (!isDakeraConfigured(loadDakeraConfig(session.settings))) return null;
		return new MemorySaveDocumentTool(session);
	}

	async execute(_id: string, params: SaveDocumentParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const state = this.session.getDakeraSessionState?.();
			if (!state) {
				throw new Error("Dakera backend is not initialised for this session.");
			}
			const provided = [params.path, params.url, params.text].filter(
				value => value !== undefined && value !== "",
			).length;
			if (provided !== 1) {
				throw new Error("Provide exactly one of `path`, `url`, or `text`.");
			}

			let content: string;
			let origin: string | undefined;
			let isUrl = false;
			const text = params.text;
			const path = params.path;
			const url = params.url;
			if (text !== undefined && text !== "") {
				content = text;
			} else if (path !== undefined && path !== "") {
				origin = path;
				content = await Bun.file(path).text();
			} else if (url !== undefined && url !== "") {
				origin = url;
				isUrl = true;
				const response = await fetch(url, { signal });
				if (!response.ok) {
					throw new Error(`Fetch failed with ${response.status} ${response.statusText}`);
				}
				content = await response.text();
			} else {
				throw new Error("Provide exactly one of `path`, `url`, or `text`.");
			}
			if (content.trim().length === 0) {
				throw new Error("Document content is empty.");
			}

			const title = params.title ?? origin ?? "untitled document";
			const imported = await state.ingestDocument({
				content,
				mediaType: inferMediaType(params, origin, isUrl, content),
				title,
				documentId: params.document_id,
			});
			return {
				content: [{ type: "text", text: `Document imported as ${imported.documentId} (${title}).` }],
				details: { documentId: imported.documentId, jobId: imported.jobId },
			};
		});
	}
}
