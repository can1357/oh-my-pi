import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadHooks } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/hooks/loader";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

const HOOK_PATH = path.resolve(import.meta.dir, "../examples/hooks/consurg-guard.ts");

type GuardRequest = {
	toolName: string;
	filePath: string;
	requestType: string;
	toolInput: Record<string, unknown>;
};

type GuardDecision = { decision: "allow" } | { decision: "deny"; message: string };

type GuardContext = {
	hasUI: false;
	cwd: string;
	ui: { notify: () => void };
};

function setEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function invokeHook(toolName: string, input: Record<string, unknown>, cwd = process.cwd()): Promise<unknown> {
	const loaded = await loadHooks([HOOK_PATH], cwd);
	expect(loaded.errors).toEqual([]);
	const handler = loaded.hooks[0]?.handlers.get("tool_call")?.[0];
	expect(handler).toBeDefined();
	return handler!({ type: "tool_call", toolCallId: "test-call", toolName, input }, {
		hasUI: false,
		cwd,
		ui: { notify: () => {} },
	} satisfies GuardContext);
}

async function withGuard(
	decide: (request: GuardRequest) => GuardDecision,
	test: (requests: GuardRequest[]) => Promise<void>,
	options: { cwd?: string; useLockfile?: boolean } = {},
): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const lockPath = path.join(cwd, ".consurg-guard.lock");
	const requests: GuardRequest[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: async request => {
			const payload = (await request.json()) as Record<string, unknown>;
			const toolInput = payload.tool_input;
			const guardRequest: GuardRequest = {
				toolName: typeof payload.tool_name === "string" ? payload.tool_name : "",
				filePath: typeof payload.file_path === "string" ? payload.file_path : "",
				requestType: typeof payload.request_type === "string" ? payload.request_type : "",
				toolInput:
					toolInput !== null && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : {},
			};
			requests.push(guardRequest);
			const decision = decide(guardRequest);
			return Response.json(decision);
		},
	});

	const previousPort = process.env.CONSURG_GUARD_PORT;
	const previousActive = process.env.CONSURG_ACTIVE;
	const previousFailClosed = process.env.CONSURG_FAIL_CLOSED;
	if (options.useLockfile) {
		fs.writeFileSync(lockPath, JSON.stringify({ port: server.port }));
		setEnvironment("CONSURG_GUARD_PORT", undefined);
	} else {
		setEnvironment("CONSURG_GUARD_PORT", String(server.port));
	}
	setEnvironment("CONSURG_ACTIVE", undefined);
	setEnvironment("CONSURG_FAIL_CLOSED", undefined);
	try {
		await test(requests);
	} finally {
		setEnvironment("CONSURG_GUARD_PORT", previousPort);
		setEnvironment("CONSURG_ACTIVE", previousActive);
		setEnvironment("CONSURG_FAIL_CLOSED", previousFailClosed);
		if (options.useLockfile) fs.rmSync(lockPath, { force: true });
		server.stop();
	}
}

describe("Consurg guard hook contract", () => {
	it("keeps the documented no-guard default fail-open", async () => {
		const previousPort = process.env.CONSURG_GUARD_PORT;
		const previousActive = process.env.CONSURG_ACTIVE;
		const previousFailClosed = process.env.CONSURG_FAIL_CLOSED;
		setEnvironment("CONSURG_GUARD_PORT", undefined);
		setEnvironment("CONSURG_ACTIVE", undefined);
		setEnvironment("CONSURG_FAIL_CLOSED", undefined);
		try {
			expect(await invokeHook("read", { path: "README.md" })).toBeUndefined();
		} finally {
			setEnvironment("CONSURG_GUARD_PORT", previousPort);
			setEnvironment("CONSURG_ACTIVE", previousActive);
			setEnvironment("CONSURG_FAIL_CLOSED", previousFailClosed);
		}
	});

	it("uses the hook context cwd for lockfile discovery", async () => {
		const tempDir = TempDir.createSync("@consurg-hook-lock-");
		try {
			await withGuard(
				request =>
					request.filePath === "locked.ts"
						? { decision: "deny", message: "locked denied" }
						: { decision: "allow" },
				async () => {
					expect(await invokeHook("read", { path: "locked.ts" }, tempDir.path())).toEqual({
						block: true,
						reason: "locked denied",
					});
				},
				{ cwd: tempDir.path(), useLockfile: true },
			);
		} finally {
			tempDir.removeSync();
		}
	});

	it("evaluates every path in a multi-file call and blocks a denied target", async () => {
		await withGuard(
			request =>
				request.filePath === "secret.ts" ? { decision: "deny", message: "secret denied" } : { decision: "allow" },
			async requests => {
				const result = await invokeHook("edit", { paths: ["allowed.ts", "secret.ts"] });
				expect(result).toEqual({ block: true, reason: "secret denied" });
				expect(requests.map(request => request.filePath)).toEqual(["allowed.ts", "secret.ts"]);
			},
		);
	});

	it("classifies the built-in glob tool as a file request", async () => {
		await withGuard(
			() => ({ decision: "allow" }),
			async requests => {
				expect(await invokeHook("glob", { paths: ["src/**/*.ts"] })).toBeUndefined();
				expect(requests).toEqual([
					{
						toolName: "glob",
						filePath: "src/**/*.ts",
						requestType: "file",
						toolInput: { paths: ["src/**/*.ts"] },
					},
				]);
			},
		);
	});

	it("evaluates pathless search at the workspace root", async () => {
		await withGuard(
			request =>
				request.filePath === "." ? { decision: "deny", message: "workspace denied" } : { decision: "allow" },
			async requests => {
				expect(await invokeHook("search", { pattern: "secret" })).toEqual({
					block: true,
					reason: "workspace denied",
				});
				expect(requests).toEqual([
					expect.objectContaining({ toolName: "search", filePath: ".", requestType: "file" }),
				]);
			},
		);
	});

	it("treats empty search paths as the workspace root", async () => {
		await withGuard(
			request =>
				request.filePath === "." ? { decision: "deny", message: "workspace denied" } : { decision: "allow" },
			async requests => {
				expect(await invokeHook("grep", { pattern: "secret", paths: [] })).toEqual({
					block: true,
					reason: "workspace denied",
				});
				expect(await invokeHook("search", { pattern: "secret", paths: "" })).toEqual({
					block: true,
					reason: "workspace denied",
				});
				expect(requests.map(request => request.filePath)).toEqual([".", "."]);
			},
		);
	});

	it("evaluates edit rename destinations", async () => {
		await withGuard(
			request =>
				request.filePath === "renamed.ts" ? { decision: "deny", message: "rename denied" } : { decision: "allow" },
			async requests => {
				expect(
					await invokeHook("edit", {
						path: "source.ts",
						edits: [{ op: "update", rename: "renamed.ts" }],
					}),
				).toEqual({ block: true, reason: "rename denied" });
				expect(requests.map(request => request.filePath)).toEqual(["source.ts", "renamed.ts"]);
			},
		);
	});

	it("evaluates raw apply-patch sources and destinations", async () => {
		await withGuard(
			request =>
				request.filePath === "renamed.ts" ? { decision: "deny", message: "move denied" } : { decision: "allow" },
			async requests => {
				expect(
					await invokeHook("edit", {
						input: "*** Begin Patch\n*** Update File: source.ts\n*** Move to: renamed.ts\n@@\n-old\n+new\n*** End Patch",
					}),
				).toEqual({ block: true, reason: "move denied" });
				expect(requests.map(request => request.filePath)).toEqual(["source.ts", "renamed.ts"]);
			},
		);
	});

	it("evaluates raw hashline source headers", async () => {
		await withGuard(
			request =>
				request.filePath === "blocked.ts" ? { decision: "deny", message: "header denied" } : { decision: "allow" },
			async requests => {
				expect(await invokeHook("edit", { input: "[blocked.ts#A1B2]\nSWAP 1.=1:\n+replacement" })).toEqual({
					block: true,
					reason: "header denied",
				});
				expect(requests.map(request => request.filePath)).toEqual(["blocked.ts"]);
			},
		);
	});

	it("classifies AST file tools as scoped operations", async () => {
		await withGuard(
			request =>
				request.filePath === "blocked.ts"
					? { decision: "deny", message: "AST path denied" }
					: { decision: "allow" },
			async requests => {
				expect(await invokeHook("ast_grep", { paths: ["blocked.ts"] })).toEqual({
					block: true,
					reason: "AST path denied",
				});
				expect(await invokeHook("ast_edit", { paths: ["blocked.ts"] })).toEqual({
					block: true,
					reason: "AST path denied",
				});
				expect(requests.map(request => request.toolName)).toEqual(["ast_grep", "ast_edit"]);
			},
		);
	});

	it("guards known and generic path-bearing tools", async () => {
		await withGuard(
			request => {
				if (request.filePath === "src/**") return { decision: "deny", message: "scope denied" };
				if (request.filePath === ".") return { decision: "deny", message: "workspace denied" };
				if (request.filePath === "input.png") return { decision: "deny", message: "image denied" };
				if (request.filePath === "reference.png") return { decision: "deny", message: "reference denied" };
				if (request.filePath === "lsp.ts") return { decision: "deny", message: "LSP denied" };
				if (request.filePath === "lsp-renamed.ts") return { decision: "deny", message: "LSP move denied" };
				return { decision: "allow" };
			},
			async requests => {
				expect(
					await invokeHook("context_oracle", { action: "diagnostics", file: "source.ts", scope: "src/**" }),
				).toEqual({
					block: true,
					reason: "scope denied",
				});
				expect(await invokeHook("inspect_image", { path: "input.png", question: "Inspect this image" })).toEqual({
					block: true,
					reason: "image denied",
				});
				expect(await invokeHook("generate_image", { subject: "test", input: [{ path: "reference.png" }] })).toEqual(
					{
						block: true,
						reason: "reference denied",
					},
				);
				expect(await invokeHook("lsp", { action: "diagnostics", file: "lsp.ts" })).toEqual({
					block: true,
					reason: "LSP denied",
				});
				expect(
					await invokeHook("lsp", { action: "rename_file", file: "lsp-source.ts", new_name: "lsp-renamed.ts" }),
				).toEqual({
					block: true,
					reason: "LSP move denied",
				});
				expect(await invokeHook("context_oracle", { action: "ask", query: "where is auth handled?" })).toEqual({
					block: true,
					reason: "workspace denied",
				});
				expect(await invokeHook("context_oracle", { action: "symbol", symbol: "AgentSession", scope: "" })).toEqual(
					{
						block: true,
						reason: "workspace denied",
					},
				);
				expect(requests.map(request => request.filePath)).toEqual([
					"source.ts",
					"src/**",
					"input.png",
					"reference.png",
					"lsp.ts",
					"lsp-source.ts",
					"lsp-renamed.ts",
					".",
					".",
				]);
			},
		);
	});

	it("blocks a denied single path", async () => {
		await withGuard(
			request =>
				request.filePath === "forbidden.ts" ? { decision: "deny", message: "path denied" } : { decision: "allow" },
			async () => {
				expect(await invokeHook("write", { path: "forbidden.ts" })).toEqual({
					block: true,
					reason: "path denied",
				});
			},
		);
	});

	it("blocks uninspectable targeted input in configured fail-closed mode", async () => {
		await withGuard(
			() => ({ decision: "allow" }),
			async requests => {
				const previousFailClosed = process.env.CONSURG_FAIL_CLOSED;
				setEnvironment("CONSURG_FAIL_CLOSED", "1");
				try {
					expect(await invokeHook("read", { paths: ["known.ts", 42] })).toEqual({
						block: true,
						reason: "Consurg guard cannot inspect this targeted call (fail-closed mode)",
					});
					expect(await invokeHook("context_oracle", { action: "ask", query: "q", file: 42 })).toEqual({
						block: true,
						reason: "Consurg guard cannot inspect this targeted call (fail-closed mode)",
					});
					expect(requests).toHaveLength(0);
				} finally {
					setEnvironment("CONSURG_FAIL_CLOSED", previousFailClosed);
				}
			},
		);
	});
});
