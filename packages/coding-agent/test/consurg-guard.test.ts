import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadHooks } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/hooks/loader";

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
	ui: { notify: () => void };
};

function setEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function invokeHook(toolName: string, input: Record<string, unknown>): Promise<unknown> {
	const loaded = await loadHooks([HOOK_PATH], process.cwd());
	expect(loaded.errors).toEqual([]);
	const handler = loaded.hooks[0]?.handlers.get("tool_call")?.[0];
	expect(handler).toBeDefined();
	return handler!({ type: "tool_call", toolCallId: "test-call", toolName, input }, {
		hasUI: false,
		ui: { notify: () => {} },
	} satisfies GuardContext);
}

async function withGuard(
	decide: (request: GuardRequest) => GuardDecision,
	test: (requests: GuardRequest[]) => Promise<void>,
): Promise<void> {
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
	setEnvironment("CONSURG_GUARD_PORT", String(server.port));
	setEnvironment("CONSURG_ACTIVE", undefined);
	setEnvironment("CONSURG_FAIL_CLOSED", undefined);
	try {
		await test(requests);
	} finally {
		setEnvironment("CONSURG_GUARD_PORT", previousPort);
		setEnvironment("CONSURG_ACTIVE", previousActive);
		setEnvironment("CONSURG_FAIL_CLOSED", previousFailClosed);
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
					expect(requests).toHaveLength(0);
				} finally {
					setEnvironment("CONSURG_FAIL_CLOSED", previousFailClosed);
				}
			},
		);
	});
});
