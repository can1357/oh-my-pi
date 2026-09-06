import { type } from "@oh-my-pi/omptype";
import type { CodexContextWindows } from "@oh-my-pi/pi-catalog/types";
import { CODEX_CLIENT_VERSION } from "@oh-my-pi/pi-catalog/wire/codex";
import { fetchWithRetry, isRecord } from "@oh-my-pi/pi-utils";
import { isOfficialCodexApiUrl } from "../../stream";
import type { FetchImpl, Model, ToolResultMessage } from "../../types";
import { createCodexHeaders, resolveCodexResponsesUrl } from "../openai-codex-responses";

export interface CodexHistoryNotesAuth {
	readonly provider: string;
	readonly accessToken: string;
	readonly accountId?: string;
	readonly baseUrl?: string;
	readonly headers?: Record<string, string>;
}

export function getCodexContextWindowPolicy(model: Model | null | undefined): CodexContextWindows | undefined {
	if (model?.api !== "openai-codex-responses" || !model.compat || !("contextWindows" in model.compat))
		return undefined;
	return model.compat.contextWindows;
}

export const CODEX_HISTORY_NOTES_ROUTES = [
	"alpha/history/v2/list_windows",
	"alpha/history/v2/list_items",
	"alpha/history/v2/read_item",
	"alpha/history/v2/search_contents",
	"alpha/notes/v2/list_files_by_prefix",
	"alpha/notes/v2/read_file",
	"alpha/notes/v2/search_contents",
	"alpha/notes/v2/append_to_file",
	"alpha/notes/v2/write_file",
] as const;
export type CodexHistoryNotesRoute = (typeof CODEX_HISTORY_NOTES_ROUTES)[number];

export interface CodexHistoryNotesContext {
	readonly sessionId: string;
	readonly agentName: string;
	readonly truncation: { mode: "bytes" | "tokens"; limit: number };
	readonly signal?: AbortSignal;
}

export interface HistoryNotesAgentIdentity {
	readonly kind: "main" | "sub";
	readonly id: string;
}

/** Translate caller identity to the backend's absolute, lowercase agent namespace. */
export function codexHistoryNotesAgentPath(agent: HistoryNotesAgentIdentity): string {
	switch (agent.kind) {
		case "main":
			return "/root";
		case "sub": {
			const name = agent.id.toLowerCase();
			if (/^[a-z0-9_]+$/.test(name) && name !== "root") return `/root/${name}`;
			// Distinct IDs such as Build-Agent and Build_Agent must not share notes.
			const suffix = new Bun.CryptoHasher("sha256").update(agent.id).digest("hex").slice(0, 12);
			return `/root/${name.replace(/[^a-z0-9_]+/g, "_") || "agent"}_${suffix}`;
		}
	}
}

const encryptedRoutes: Partial<Record<CodexHistoryNotesRoute, true>> = {
	"alpha/history/v2/search_contents": true,
	"alpha/notes/v2/search_contents": true,
	"alpha/notes/v2/append_to_file": true,
	"alpha/notes/v2/write_file": true,
};
const imageSchema = type({
	data: "string",
	mime_type: "string",
	"detail?": "'auto' | 'low' | 'high' | 'original' | null",
});

export function canUseCodexHistoryNotes(auth: CodexHistoryNotesAuth): boolean {
	return (
		auth.provider === "openai-codex" && !!auth.accountId && !!auth.accessToken && isOfficialCodexApiUrl(auth.baseUrl)
	);
}

export class CodexHistoryNotesError extends Error {
	constructor(detail: string) {
		super(`Unable to perform operation: ${detail}`);
		this.name = "CodexHistoryNotesError";
	}
}

/** Blind proxy: ciphertext is neither decrypted nor retained outside the caller's tool result. */
export class CodexHistoryNotesBackend {
	constructor(
		readonly resolveAuth: () => Promise<CodexHistoryNotesAuth>,
		readonly fetchOverride?: FetchImpl,
	) {}

	async call(
		route: CodexHistoryNotesRoute,
		args: Record<string, unknown>,
		context: CodexHistoryNotesContext,
	): Promise<ToolResultMessage["content"]> {
		const result = await this.#request(route, args, context, encryptedRoutes[route] === true);
		const images = isRecord(result) ? result.images : undefined;
		const body = isRecord(result)
			? Object.fromEntries(Object.entries(result).filter(([key]) => key !== "images"))
			: result;
		const content: ToolResultMessage["content"] =
			isRecord(body) && typeof body.encrypted_output === "string"
				? [{ type: "encrypted", encryptedContent: body.encrypted_output }]
				: [{ type: "text", text: JSON.stringify(body) }];
		if (images !== undefined) {
			if (!Array.isArray(images))
				throw new CodexHistoryNotesError("History backend returned invalid image content.");
			for (const value of images) {
				const image = imageSchema(value);
				if (image instanceof type.errors)
					throw new CodexHistoryNotesError("History backend returned invalid image content.");
				content.push({
					type: "image",
					data: image.data,
					mimeType: image.mime_type,
					...(image.detail ? { detail: image.detail } : {}),
				});
			}
		}
		return content;
	}

	async threadHint(context: CodexHistoryNotesContext): Promise<string | undefined> {
		try {
			const result = await this.#request("alpha/notes/v2/thread_hint", {}, context, false);
			if (
				!isRecord(result) ||
				typeof result.text !== "string" ||
				!result.text ||
				Buffer.byteLength(result.text, "utf8") > 4000
			)
				return undefined;
			return result.text;
		} catch {
			// Thread hints are optional context; backend failure must stay silent.
			return undefined;
		}
	}

	async #request(
		route: CodexHistoryNotesRoute | "alpha/notes/v2/thread_hint",
		args: Record<string, unknown>,
		context: CodexHistoryNotesContext,
		encryptedArgs: boolean,
	): Promise<unknown> {
		let auth: CodexHistoryNotesAuth;
		try {
			auth = await this.resolveAuth();
		} catch {
			throw new CodexHistoryNotesError("Could not resolve backend authentication.");
		}
		if (!canUseCodexHistoryNotes(auth)) throw new CodexHistoryNotesError("Could not resolve the backend provider.");
		const headers = createCodexHeaders(auth.headers, auth.accountId, auth.accessToken, CODEX_CLIENT_VERSION);
		headers.set("accept", "application/json");
		headers.set("x-openai-tool-output-truncation-policy", JSON.stringify(context.truncation));
		if (encryptedArgs) headers.set("x-openai-encrypted-tool-arguments", "true");
		else headers.delete("x-openai-encrypted-tool-arguments");
		const baseUrl = resolveCodexResponsesUrl(auth.baseUrl).replace(/\/responses$/, "");
		let response: Response;
		try {
			response = await fetchWithRetry(`${baseUrl}/${route}`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					...args,
					context: { session_id: context.sessionId, current_agent_name: context.agentName },
				}),
				signal: context.signal
					? AbortSignal.any([context.signal, AbortSignal.timeout(35_000)])
					: AbortSignal.timeout(35_000),
				maxAttempts: 1,
				timeout: false,
				fetch: this.fetchOverride,
			});
			if (!response.ok) throw new CodexHistoryNotesError("The backend request failed.");
		} catch {
			throw new CodexHistoryNotesError("The backend request failed.");
		}
		try {
			return await response.json();
		} catch {
			throw new CodexHistoryNotesError("The backend returned invalid JSON.");
		}
	}
}
