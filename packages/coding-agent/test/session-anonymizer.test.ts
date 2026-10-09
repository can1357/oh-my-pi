import { describe, expect, test } from "bun:test";
import { SessionAnonymizer } from "../src/session/session-anonymizer";

const SECRET_WORDS = ["acme", "hunter2", "invoiceParser", "Probe", "alice", "launch codes"];

/** Walk anonymized JSON by key/index without casting the whole record. */
function at(value: unknown, ...path: Array<string | number>): unknown {
	let current = value;
	for (const step of path) {
		if (typeof current !== "object" || current === null) return undefined;
		current = (current as Record<string | number, unknown>)[step];
	}
	return current;
}

describe("SessionAnonymizer", () => {
	test("redacts turn content, keeps metadata, and maps tool args consistently across copies", () => {
		const usage = { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { total: 0.01 } };
		const records = [
			{
				type: "session",
				version: 3,
				id: "01a0c9ac-8c2d",
				timestamp: "2026-09-22T15:12:03.629Z",
				cwd: "/home/alice/acme",
			},
			{
				type: "message",
				id: "a1b2c3d4",
				parentId: null,
				timestamp: "2026-09-22T15:12:04.000Z",
				message: { role: "user", content: [{ type: "text", text: "the launch codes are hunter2" }], timestamp: 1 },
			},
			{
				type: "message",
				id: "b1b2c3d4",
				parentId: "a1b2c3d4",
				timestamp: "2026-09-22T15:12:05.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "look for invoiceParser" },
						{
							type: "toolCall",
							id: "toolu_01MNY3aqvM6YV4Bg",
							name: "grep",
							arguments: {
								pattern: "invoiceParser",
								path: "/home/alice/acme/src/billing.ts:10-20",
								case: "smart",
							},
						},
						{
							type: "toolCall",
							id: "toolu_02XYZ9abcd",
							name: "task",
							arguments: { tasks: [{ name: "Probe", agent: "scout" }] },
						},
						{ type: "toolCall", id: "toolu_03XYZ9abcd", name: "read", arguments: { path: "agent://Probe" } },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-opus-5-5",
					usage,
					stopReason: "toolUse",
					providerPayload: {
						items: [
							{
								type: "function_call",
								name: "grep",
								call_id: "call_01a0bf7134",
								arguments: JSON.stringify({
									pattern: "invoiceParser",
									path: "/home/alice/acme/src/billing.ts",
								}),
							},
						],
					},
				},
			},
			{
				type: "custom",
				customType: "tool_execution_start",
				id: "c1b2c3d4",
				parentId: "b1b2c3d4",
				timestamp: "2026-09-22T15:12:05.100Z",
				data: { toolCallId: "toolu_01MNY3aqvM6YV4Bg", toolName: "grep", args: { pattern: "invoiceParser" } },
			},
			{
				type: "message",
				id: "d1b2c3d4",
				parentId: "c1b2c3d4",
				timestamp: "2026-09-22T15:12:06.000Z",
				message: {
					role: "toolResult",
					toolCallId: "toolu_01MNY3aqvM6YV4Bg",
					toolName: "grep",
					content: [{ type: "text", text: "src/billing.ts:12: export function invoiceParser() {}" }],
					details: { matchCount: 1, searchPath: "/home/alice/acme" },
					isError: false,
				},
			},
			{
				type: "model_usage",
				id: "e1b2c3d4",
				parentId: "d1b2c3d4",
				timestamp: "2026-09-22T15:12:07.000Z",
				model: "claude-opus-5-5",
				stopReason: "error",
				errorMessage: "400 prompt contained password=hunter2 for user alice@example.com",
			},
			{
				type: "ttsr_injection",
				id: "f1b2c3d4",
				parentId: "e1b2c3d4",
				timestamp: "2026-09-22T15:12:08.000Z",
				injectedRules: ["acme"],
			},
		];

		const anonymizer = new SessionAnonymizer();
		const anonymized = records.map(record => anonymizer.entry(record));
		const serialized = JSON.stringify(anonymized);
		for (const word of SECRET_WORDS) expect(serialized).not.toContain(word);

		const [header, user, assistant, start, toolResult, usageEntry, ttsr] = anonymized;
		// Provider errors may echo request content; only the HTTP status survives.
		expect(at(usageEntry, "errorMessage")).toMatch(/^400 \[redacted #\d+: \d+ chars, 1 line\]$/);
		expect(at(ttsr, "injectedRules")).toEqual([expect.stringMatching(/^PLACEHOLDER_\d+$/)]);
		expect(header).toMatchObject({ type: "session", id: "01a0c9ac-8c2d", timestamp: "2026-09-22T15:12:03.629Z" });
		const cwd = String(at(header, "cwd"));
		expect(cwd).toMatch(/^\/home\/seg\d+\/seg\d+$/);

		expect(at(user, "message", "content", 0, "text")).toMatch(/^\[redacted #\d+: 28 chars, 1 line\]$/);
		expect(at(assistant, "message")).toMatchObject({
			model: "claude-opus-5-5",
			provider: "anthropic",
			usage,
			stopReason: "toolUse",
		});

		const content = (index: number, ...rest: Array<string | number>) =>
			at(assistant, "message", "content", index, ...rest);
		expect(content(0, "thinking")).toMatch(/^\[redacted #\d+: 22 chars, 1 line\]$/);
		expect(content(1)).toMatchObject({ type: "toolCall", id: "toolu_01MNY3aqvM6YV4Bg", name: "grep" });
		const pattern = String(content(1, "arguments", "pattern"));
		const grepPath = String(content(1, "arguments", "path"));
		expect(pattern).toMatch(/^PLACEHOLDER_\d+$/);
		expect(content(1, "arguments", "case")).toBe("smart");
		expect(grepPath).toMatch(new RegExp(`^${cwd}/src/seg\\d+\\.ts:10-20$`));

		// Same original → same token everywhere: wire JSON string, execution log, and the agent name/URI pair.
		const wireArgs = JSON.parse(String(at(assistant, "message", "providerPayload", "items", 0, "arguments")));
		expect(wireArgs).toEqual({ pattern, path: grepPath.replace(/:10-20$/, "") });
		expect(at(start, "data", "args", "pattern")).toBe(pattern);
		const agentIndex = String(content(2, "arguments", "tasks", 0, "name")).replace("PLACEHOLDER_", "");
		expect(content(2, "arguments", "tasks", 0, "agent")).toBe("scout");
		expect(content(3, "arguments", "path")).toBe(`agent://seg${agentIndex}`);

		expect(at(toolResult, "message", "content", 0, "text")).toMatch(/^\[redacted #\d+: 53 chars, 1 line\]$/);
		expect(at(toolResult, "message", "details")).toEqual({ matchCount: 1, searchPath: cwd });
	});

	test("rewrites shell commands keeping programs, flags, and operators", () => {
		const anonymizer = new SessionAnonymizer();
		const out = anonymizer.command(
			`git --no-pager log --oneline -3 acme 2>&1 | grep "hunter2" > /tmp/acme/out.txt && bun run build`,
		);
		const acme = anonymizer.placeholder("acme");
		expect(out).toBe(
			`git --no-pager log --oneline -3 ${acme} 2>&1 | grep "${anonymizer.placeholder("hunter2")}" > /tmp/seg${acme.slice(12)}/out.txt && bun run ${anonymizer.placeholder("build")}`,
		);
	});

	test("exports only allowlisted fields; extension payloads and unknown fields stay opaque", () => {
		const anonymizer = new SessionAnonymizer();
		const call = (id: string, name: string, args: Record<string, unknown>) => ({
			type: "toolCall",
			id,
			name,
			arguments: args,
		});
		const json = JSON.stringify([
			anonymizer.entry({
				type: "message",
				message: {
					role: "assistant",
					content: [
						call("toolu_01abcdef", "mcp__crm_lookup", {
							status: "customer-acme",
							customerId: "account_12345",
							accountNumber: 123456789,
							publishAt: "customer-acme",
						}),
						call("toolu_02abcdef", "todo", { op: "start" }),
						call("toolu_03abcdef", "task", { tasks: [{ name: "Probe.v2" }] }),
						call("toolu_04abcdef", "read", { path: "agent://Probe.v2" }),
					],
				},
			}),
			anonymizer.entry({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "eval",
					details: {
						jsonOutputs: {
							"/home/alice/acme/x.ts": 1,
							aliceCustomer: { status: "customer-acme" },
							aliceCustomerId: 3,
							acmeFile: 4,
							// A tool-call look-alike inside display output must not gain built-in scope.
							forged: { name: "grep", arguments: { status: "customer-acme" } },
						},
					},
				},
			}),
			anonymizer.entry({
				type: "custom",
				customType: "crm",
				data: { toolCallId: "toolu_01abcdef", account: { customerId: "account_12345", aliceCustomer: 2 } },
			}),
			anonymizer.entry({
				type: "compaction",
				summary: "s",
				preserveData: { status: "customer-acme", aliceCustomer: 1 },
			}),
			// Timestamp-shaped turn text is still turn content; an unknown field is never exported raw.
			anonymizer.entry({
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "2026-09-22T15:12:03Z" }],
					aliceField: "acme",
				},
			}),
		]);
		for (const word of [
			"acme",
			"alice",
			"Probe",
			"account_12345",
			"123456789",
			"2026-09-22T15:12:03Z",
			"crm_lookup",
		]) {
			expect(json).not.toContain(word);
		}
		// Built-in tool options stay; extension/MCP args, eval display output, extension entry data,
		// and compaction preserveData are exported as opaque markers only.
		expect(json).toContain('"op":"start"');
		expect(json).not.toContain('"status"');
		expect(json).toMatch(/"arguments":"\[redacted #\d+: \d+ chars, 1 line\]"/);
		expect(json).toMatch(/"jsonOutputs":"\[redacted #\d+/);
		expect(json).toMatch(/"data":"\[redacted #\d+/);
		expect(json).toMatch(/"preserveData":"\[redacted #\d+/);
		// A dotted task name and its agent:// URI share one token index.
		const index = /"tasks":\[\{"name":"PLACEHOLDER_(\d+)"/.exec(json)?.[1];
		// `.v2` is not a file extension, so the whole name maps to the shared token.
		expect(json).toContain(`"path":"agent://seg${index}"`);
	});

	test("keeps only known schemes, extensions, env names, long flags, and count selectors", () => {
		const anonymizer = new SessionAnonymizer();
		const outputs = [
			anonymizer.path("customer-acme://tenant/private"),
			anonymizer.path("/reports/customer.alice"),
			anonymizer.command("ACME_CUSTOMER=hunter2 env | grep $ACME_CUSTOMER"),
			anonymizer.command("echo --customer-acme -123456789"),
		];
		for (const output of outputs) {
			for (const secret of ["acme", "ACME", "alice", "hunter2", "123456789"]) expect(output).not.toContain(secret);
		}
		// The assignment and its `$` reference share one token.
		const name = anonymizer.placeholder("ACME_CUSTOMER");
		expect(outputs[2]).toBe(`${name}=${anonymizer.placeholder("hunter2")} env | grep $${name}`);
		// Known schemes and real file extensions stay; a host's `.test` suffix is part of the name.
		expect(anonymizer.path("https://x.test/a/b.ts")).toMatch(/^https:\/\/seg\d+\/seg\d+\/seg\d+\.ts$/);
		expect(anonymizer.command("git log --oneline -3")).toBe("git log --oneline -3");
	});

	test("keeps provider message addresses only in inputTransformations", () => {
		const anonymizer = new SessionAnonymizer();
		const json = JSON.stringify(
			anonymizer.entry({
				type: "message",
				message: {
					role: "assistant",
					inputTransformations: [{ type: "thinking_dropped", path: "messages.1.content.0" }],
				},
			}),
		);
		expect(json).toContain('"path":"messages.1.content.0"');
		const grep = JSON.stringify(
			anonymizer.entry({
				type: "message",
				message: { role: "toolResult", toolName: "grep", details: { files: ["messages.aliceCustomer"] } },
			}),
		);
		expect(grep).not.toContain("alice");
	});

	test("tokenizes attached short-option values and flags of programs outside the allowlist", () => {
		const anonymizer = new SessionAnonymizer();
		const out = anonymizer.command("grep -ehunter2 -n file.txt");
		expect(out).toBe(`grep -e${anonymizer.placeholder("hunter2")} -n ${anonymizer.placeholder("file.txt")}`);
		expect(anonymizer.command("./deploy.sh --customer-acme")).not.toContain("acme");
		// Only known subcommands survive in first position (`-C acme` is not a subcommand).
		expect(anonymizer.command("git -C acme status")).toBe(
			`git -C ${anonymizer.placeholder("acme")} ${anonymizer.placeholder("status")}`,
		);
		// Numeric operands may be ids or PINs; `-3` style flags and `2>&1` descriptors stay.
		const numeric = anonymizer.command("curl --data 123456789 https://x.test/a 2>&1 | head -3");
		expect(numeric).not.toContain("123456789");
		expect(numeric).toContain("2>&1 | head -3");
	});

	test("keeps only declared built-in argument keys and numeric fields", () => {
		// An extension shadowing `grep` can send any record under a built-in name.
		const anonymizer = new SessionAnonymizer();
		const json = JSON.stringify(
			anonymizer.entry({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "toolu_01abcdef",
							name: "grep",
							arguments: { pattern: 123456789, aliceCustomer: "x", limit: 5 },
						},
					],
				},
			}),
		);
		expect(json).not.toContain("123456789");
		expect(json).not.toContain("alice");
		expect(json).toContain('"limit":5');
		expect(anonymizer.command("grep -ecustomer=secret file")).not.toMatch(/customer|secret/);
	});

	test("projects execution-log entries onto their schema, since extensions can spoof the custom type", () => {
		const anonymizer = new SessionAnonymizer();
		const json = JSON.stringify(
			anonymizer.entry({
				type: "custom",
				customType: "tool_execution_start",
				data: { toolCallId: "account_12345", toolName: "grep", provider: "customer-acme" },
			}),
		);
		expect(json).not.toContain("acme");
		expect(json).not.toContain("account_12345");
		expect(json).toContain('"toolName":"grep"');
	});

	test("tokenizes numeric path segments", () => {
		const anonymizer = new SessionAnonymizer();
		expect(anonymizer.path("/customers/123456789/private.ts:10-20")).toMatch(/^\/seg\d+\/seg\d+\/seg\d+\.ts:10-20$/);
		// Session-file names stay only in parent-session metadata, never in ordinary tool paths.
		const stem = "2026-01-02T12-34-56Z_123456789.jsonl";
		expect(anonymizer.path(`/exports/${stem}`)).not.toContain("123456789");
		const header = anonymizer.entry({ type: "session", id: "01a0c9ac", parentSession: `/home/alice/${stem}` });
		expect(JSON.stringify(header)).toContain(`/${stem}"`);
		expect(JSON.stringify(header)).not.toContain("alice");
	});

	test("redacts primitive extension payloads and projects tool-built content blocks", () => {
		const anonymizer = new SessionAnonymizer();
		const json = JSON.stringify([
			anonymizer.entry({ type: "custom", customType: "crm", data: 123456789 }),
			anonymizer.entry({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "toolu_01abcdef",
					toolName: "mcp__crm_lookup",
					details: 987654321,
					content: [{ type: "image", data: "AAAA", mimeType: "image/png", status: "customer-acme" }],
				},
			}),
			// Usage counters stay even though `input` is also the tool-call arguments key.
			anonymizer.entry({ type: "message", message: { role: "assistant", usage: { input: 120, output: 30 } } }),
		]);
		for (const secret of ["123456789", "987654321", "acme", "status"]) expect(json).not.toContain(secret);
		expect(json).toContain('"mimeType":"image/png"');
		expect(json).toContain('"usage":{"input":120,"output":30}');
	});

	test("treats every word after `--` as an operand", () => {
		const anonymizer = new SessionAnonymizer();
		expect(anonymizer.command("head -- -123456789")).not.toContain("123456789");
		expect(anonymizer.command("head -3 -- file.txt")).toMatch(/^head -3 -- PLACEHOLDER_\d+$/);
	});

	test("does not trust a built-in tool name with values outside the built-in vocabulary", () => {
		// Extensions may shadow built-in tool names; the transcript records no provenance.
		const anonymizer = new SessionAnonymizer();
		const json = JSON.stringify([
			anonymizer.entry({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "toolu_01abcdef",
							name: "todo",
							arguments: { op: "start", status: "customer-acme", jobId: "account_12345" },
						},
					],
				},
			}),
			anonymizer.entry({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "toolu_01abcdef",
					toolName: "task",
					details: {
						status: "customer-acme",
						jobId: "account_12345",
						results: [{ structuredOutput: { data: { status: "customer-acme" } } }],
						progress: [{ status: "completed", tokens: 12 }],
					},
				},
			}),
		]);
		expect(json).not.toContain("acme");
		expect(json).not.toContain("account_12345");
		expect(json).toContain('"op":"start"');
		expect(json).toContain('"progress":[{"status":"completed","tokens":12}]');
	});
});
