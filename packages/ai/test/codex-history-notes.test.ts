import { describe, expect, test } from "bun:test";
import {
	CODEX_HISTORY_NOTES_ROUTES,
	CodexHistoryNotesBackend,
	codexHistoryNotesAgentPath,
	type CodexHistoryNotesAuth,
	type CodexHistoryNotesContext,
} from "../src/providers/openai-codex/history-notes";

const auth: CodexHistoryNotesAuth = {
	provider: "openai-codex",
	accessToken: "test-token",
	accountId: "account",
	baseUrl: "https://chatgpt.com/backend-api",
};
const context: CodexHistoryNotesContext = {
	sessionId: "session-id",
	agentName: "/root/worker",
	truncation: { mode: "tokens", limit: 6000 },
};

describe("Codex history notes backend", () => {
	test("maps OMP main and mixed-case sub identities to native backend paths", () => {
		expect(codexHistoryNotesAgentPath({ kind: "main", id: "Main" })).toBe("/root");
		expect(codexHistoryNotesAgentPath({ kind: "sub", id: "BuildWorker" })).toBe("/root/buildworker");
	});

	test("keeps unsupported or reserved agent identifiers valid and distinct", () => {
		const names = ["Build-Agent", "Build_Agent", "root", ""].map(id =>
			codexHistoryNotesAgentPath({ kind: "sub", id }),
		);
		for (const name of names) expect(name).toMatch(/^\/root\/(?!root$)[a-z0-9_]+$/);
		expect(new Set(names).size).toBe(names.length);
	});

	test.each([...CODEX_HISTORY_NOTES_ROUTES])(
		"posts %s with session-scoped context and exact protocol headers",
		async route => {
			let requestUrl: string | undefined;
			let requestInit: RequestInit | undefined;
			const backend = new CodexHistoryNotesBackend(
				async () => auth,
				async (url, init) => {
					requestUrl = String(url);
					requestInit = init;
					return Response.json({
						encrypted_output: "ciphertext",
						images: [{ data: "aW1hZ2U=", mime_type: "image/png", detail: "high" }],
					});
				},
			);
			const result = await backend.call(
				route,
				{ query: "encrypted-query", context: { session_id: "wrong" } },
				context,
			);
			expect(requestUrl).toBe(`https://chatgpt.com/backend-api/codex/${route}`);
			expect(requestInit?.method).toBe("POST");
			expect(JSON.parse(String(requestInit?.body))).toEqual({
				query: "encrypted-query",
				context: { session_id: "session-id", current_agent_name: "/root/worker" },
			});
			const headers = new Headers(requestInit?.headers);
			expect(headers.get("authorization")).toBe("Bearer test-token");
			expect(headers.get("chatgpt-account-id")).toBe("account");
			expect(headers.get("x-openai-tool-output-truncation-policy")).toBe('{"mode":"tokens","limit":6000}');
			const encrypted =
				route.endsWith("/search_contents") || route.endsWith("/append_to_file") || route.endsWith("/write_file");
			expect(headers.get("x-openai-encrypted-tool-arguments")).toBe(encrypted ? "true" : null);
			expect(headers.has("x-codex-window-id")).toBe(false);
			expect(result).toEqual([
				{ type: "encrypted", encryptedContent: "ciphertext" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png", detail: "high" },
			]);
		},
	);

	test.each([
		{ ...auth, provider: "openai" },
		{ ...auth, accountId: undefined },
		{ ...auth, baseUrl: "https://proxy.example/codex" },
		{ ...auth, baseUrl: "https://chatgpt.com.evil.example/backend-api" },
	])("rejects non-Codex or non-OAuth routes before sending credentials", async credentials => {
		let sent = false;
		const backend = new CodexHistoryNotesBackend(
			async () => credentials,
			async () => {
				sent = true;
				return Response.json({});
			},
		);
		await expect(backend.call("alpha/notes/v2/read_file", { path: "checkpoint" }, context)).rejects.toThrow(
			"Unable to perform operation: Could not resolve the backend provider.",
		);
		expect(sent).toBe(false);
	});

	test("maps invalid backend JSON without exposing response bytes", async () => {
		const backend = new CodexHistoryNotesBackend(
			async () => auth,
			async () => new Response("secret-invalid-json"),
		);
		await expect(backend.call("alpha/notes/v2/read_file", {}, context)).rejects.toThrow(
			"Unable to perform operation: The backend returned invalid JSON.",
		);
	});

	test("maps backend request failures and keeps thread hints silent", async () => {
		const backend = new CodexHistoryNotesBackend(
			async () => auth,
			async () => new Response("secret error", { status: 500 }),
		);
		await expect(backend.call("alpha/notes/v2/read_file", {}, context)).rejects.toThrow(
			"Unable to perform operation: The backend request failed.",
		);
		expect(await backend.threadHint(context)).toBeUndefined();
	});

	test("enforces the hint byte ceiling rather than its character count", async () => {
		let hint = "é".repeat(2000);
		const backend = new CodexHistoryNotesBackend(
			async () => auth,
			async () => Response.json({ text: hint }),
		);
		expect(await backend.threadHint(context)).toBe(hint);
		hint += "é";
		expect(await backend.threadHint(context)).toBeUndefined();
	});

	test("falls back to JSON text without duplicating image attachments", async () => {
		const backend = new CodexHistoryNotesBackend(
			async () => auth,
			async () => Response.json({ status: "ready", images: [] }),
		);
		expect(await backend.call("alpha/notes/v2/list_files_by_prefix", {}, context)).toEqual([
			{ type: "text", text: '{"status":"ready"}' },
		]);
	});
});
