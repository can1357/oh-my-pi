/** Gallery fixtures for the code-intelligence tools (lsp, debug). */
import type { GalleryFixture } from "./types";

export const codeintelFixtures: Record<string, GalleryFixture> = {
	lsp: {
		label: "LSP",
		streamingArgs: {
			action: "references",
			file: "src/server/auth.ts",
		},
		args: {
			action: "references",
			file: "src/server/auth.ts",
			line: 42,
			symbol: "validateToken",
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"Found 6 reference(s):",
						"  src/server/auth.ts:42:14",
						"    41: ",
						"    42: export function validateToken(token: string): Claims {",
						"    43:   const claims = verifyJwt(token);",
						"  src/server/auth.ts:118:21",
						'    117:   if (!header) throw new HttpError(401, "missing token");',
						"    118:   const claims = validateToken(stripBearer(header));",
						"    119:   return claims.sub;",
						"  src/server/middleware/session.ts:57:18",
						"    56:   const token = req.cookies.session;",
						"    57:   const claims = validateToken(token);",
						"    58:   req.userId = claims.sub;",
						"  src/server/router.ts:153:20",
						"    152: router.use(async (req, res, next) => {",
						"    153:   req.claims = await validateToken(req.token);",
						"    154:   next();",
						"  test/auth.test.ts:24:9",
						'    23: it("rejects expired tokens", () => {',
						"    24:   expect(() => validateToken(expired)).toThrow(/expired/);",
						"    25: });",
						"  test/auth.test.ts:41:9",
						'    40: it("accepts valid tokens", () => {',
						"    41:   const claims = validateToken(signed);",
						'    42:   expect(claims.sub).toBe("u_123");',
					].join("\n"),
				},
			],
			details: {
				serverName: "typescript-language-server",
				action: "references",
				success: true,
				request: {
					action: "references",
					file: "src/server/auth.ts",
					line: 42,
					symbol: "validateToken",
				},
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: "No language server found for this file",
				},
			],
			isError: true,
			details: {
				serverName: "typescript-language-server",
				action: "references",
				success: false,
				request: {
					action: "references",
					file: "src/server/auth.ts",
					line: 42,
					symbol: "validateToken",
				},
			},
		},
	},

	debug: {
		label: "Debug",
		streamingArgs: {
			action: "stack_trace",
		},
		args: {
			action: "stack_trace",
			levels: 20,
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"Stack trace:",
						"- #1000 validate_token @ app/server.py:42:14",
						"- #1001 authenticate @ app/server.py:88:9",
						"- #1002 handle_request @ app/router.py:153:20",
						"- #1003 dispatch @ app/router.py:97:5",
						"- #1004 <module> @ app/server.py:212:1",
					].join("\n"),
				},
			],
			details: {
				action: "stack_trace",
				success: true,
				snapshot: {
					id: "dbg-1",
					adapter: "debugpy",
					cwd: "/Users/dev/project",
					program: "./app/server.py",
					status: "stopped",
					launchedAt: "2026-06-06T14:21:08.412Z",
					lastUsedAt: "2026-06-06T14:22:55.901Z",
					threadId: 1,
					frameId: 1000,
					stopReason: "breakpoint",
					stopDescription: "breakpoint 2",
					frameName: "validate_token",
					instructionPointerReference: "0x00000001000034a8",
					source: { name: "server.py", path: "app/server.py" },
					line: 42,
					column: 14,
					breakpointFiles: 1,
					breakpointCount: 2,
					functionBreakpointCount: 0,
					outputBytes: 248,
					outputTruncated: false,
					needsConfigurationDone: false,
				},
				stackFrames: [
					{
						id: 1000,
						name: "validate_token",
						source: { name: "server.py", path: "app/server.py" },
						line: 42,
						column: 14,
					},
					{
						id: 1001,
						name: "authenticate",
						source: { name: "server.py", path: "app/server.py" },
						line: 88,
						column: 9,
					},
					{
						id: 1002,
						name: "handle_request",
						source: { name: "router.py", path: "app/router.py" },
						line: 153,
						column: 20,
					},
					{
						id: 1003,
						name: "dispatch",
						source: { name: "router.py", path: "app/router.py" },
						line: 97,
						column: 5,
					},
					{
						id: 1004,
						name: "<module>",
						source: { name: "server.py", path: "app/server.py" },
						line: 212,
						column: 1,
					},
				],
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: "No active debug session. Launch or attach first.",
				},
			],
			isError: true,
			details: {
				action: "stack_trace",
				success: false,
			},
		},
	},
};
