import { describe, expect, test } from "bun:test";
import {
	ASSIGNMENT_CONTRACT_VERSION,
	ASSIGNMENT_RESULT_VERSION,
	withAssignmentContractDigest,
	type AssignmentContractV1,
	type AssignmentResultV1,
} from "../../src/task/assignment-contract";
import {
	isPlaceholderNarrative,
	verifyAssignment,
	verifyAssignmentResult,
	type AssignmentVerifierRunners,
} from "../../src/task/assignment-verifier";

function makeContract(
	overrides: Partial<Omit<AssignmentContractV1, "digest" | "version" | "reporting">> = {},
): AssignmentContractV1 {
	return withAssignmentContractDigest({
		version: ASSIGNMENT_CONTRACT_VERSION,
		id: "assign-1",
		revision: 1,
		role: "reviewer",
		workClass: "mechanical",
		autonomy: "bound",
		objective: "Review the patch and report concrete findings",
		deliverables: ["packages/coding-agent/src/task/assignment-verifier.ts"],
		scope: {
			allowedPaths: ["packages/coding-agent/src/task/**"],
			deniedPaths: ["packages/coding-agent/src/task/executor.ts"],
		},
		acceptance: [
			{
				id: "scope",
				description: "Only touch declared task modules",
				check: "changed_file_scope",
			},
			{
				id: "review",
				description: "Provide a real review summary",
				check: "content_match",
				params: {
					path: "local://review.md",
					includes: "finding",
				},
			},
		],
		reporting: ASSIGNMENT_RESULT_VERSION,
		...overrides,
	});
}

function makeResult(
	contract: AssignmentContractV1,
	overrides: Partial<AssignmentResultV1> = {},
): AssignmentResultV1 {
	return {
		version: ASSIGNMENT_RESULT_VERSION,
		contractId: contract.id,
		revision: contract.revision,
		digest: contract.digest,
		status: "success",
		changedFiles: ["packages/coding-agent/src/task/assignment-verifier.ts"],
		evidence: [
			{
				criterionId: "scope",
				passed: true,
				summary: "Changed files stay inside packages/coding-agent/src/task",
			},
			{
				criterionId: "review",
				passed: true,
				summary: "Documented one concrete finding about digest checks",
			},
		],
		...overrides,
	};
}

describe("isPlaceholderNarrative", () => {
	test("rejects literals, template markers, and repeated filler only", () => {
		expect(isPlaceholderNarrative("test")).toBe(true);
		expect(isPlaceholderNarrative("TODO")).toBe(true);
		expect(isPlaceholderNarrative("tbd")).toBe(true);
		expect(isPlaceholderNarrative("n/a")).toBe(true);
		expect(isPlaceholderNarrative("{{insert review}}")).toBe(true);
		expect(isPlaceholderNarrative("<placeholder>")).toBe(true);
		expect(isPlaceholderNarrative("filler filler filler")).toBe(true);
		expect(isPlaceholderNarrative("Resolved the TODO handling regression")).toBe(false);
		expect(isPlaceholderNarrative("finding about missing digest validation")).toBe(false);
	});
});

describe("verifyAssignmentResult", () => {
	test("literal \"test\" review result fails as placeholder narrative", async () => {
		const contract = makeContract();
		const result = makeResult(contract, {
			evidence: [
				{
					criterionId: "scope",
					passed: true,
					summary: "Changed files stay inside packages/coding-agent/src/task",
				},
				{
					criterionId: "review",
					passed: true,
					summary: "test",
				},
			],
		});
		const verified = await verifyAssignmentResult({
			contract,
			result,
			runners: {
				readText: async () => "finding: digest mismatch handling looks correct",
			},
		});
		expect(verified.verified).toBe(false);
		expect(verified.failureClass).toBe("acceptance");
	});

	test("wrong digest/revision cannot verify", async () => {
		const contract = makeContract();
		const wrongDigest = makeResult(contract, { digest: "0".repeat(64) });
		const digestResult = await verifyAssignmentResult({ contract, result: wrongDigest });
		expect(digestResult.verified).toBe(false);
		expect(digestResult.failureClass).toBe("acceptance");

		const wrongRevision = makeResult(contract, { revision: 99 });
		const revisionResult = await verifyAssignmentResult({ contract, result: wrongRevision });
		expect(revisionResult.verified).toBe(false);
		expect(revisionResult.failureClass).toBe("acceptance");

		const wrongId = makeResult(contract, { contractId: "assign-other" });
		const idResult = await verifyAssignment(contract, wrongId);
		expect(idResult.verified).toBe(false);
		expect(idResult.failureClass).toBe("acceptance");
	});

	test("missing and duplicate criterion evidence fail closed", async () => {
		const contract = makeContract();
		const missing = makeResult(contract, {
			evidence: [
				{
					criterionId: "scope",
					passed: true,
					summary: "Changed files stay inside packages/coding-agent/src/task",
				},
			],
		});
		const missingResult = await verifyAssignmentResult({ contract, result: missing });
		expect(missingResult.verified).toBe(false);
		expect(missingResult.failureClass).toBe("acceptance");

		const duplicate = makeResult(contract, {
			evidence: [
				{
					criterionId: "scope",
					passed: true,
					summary: "Changed files stay inside packages/coding-agent/src/task",
				},
				{
					criterionId: "scope",
					passed: true,
					summary: "Second scope claim is still not allowed",
				},
				{
					criterionId: "review",
					passed: true,
					summary: "Documented one concrete finding about digest checks",
				},
			],
		});
		const duplicateResult = await verifyAssignmentResult({ contract, result: duplicate });
		expect(duplicateResult.verified).toBe(false);
		expect(duplicateResult.failureClass).toBe("acceptance");
	});

	test("undeclared changed files fail scope checks", async () => {
		const contract = makeContract();
		const result = makeResult(contract, {
			changedFiles: ["packages/coding-agent/src/tools/eval.ts"],
		});
		const verified = await verifyAssignmentResult({ contract, result });
		expect(verified.verified).toBe(false);
		expect(verified.failureClass).toBe("acceptance");
	});

	test("denied prefixes win and sibling prefixes do not match", async () => {
		const contract = makeContract();
		const denied = await verifyAssignment(
			contract,
			makeResult(contract, { changedFiles: ["packages/coding-agent/src/task/executor.ts"] }),
		);
		expect(denied.verified).toBe(false);

		const sibling = await verifyAssignment(
			contract,
			makeResult(contract, { changedFiles: ["packages/coding-agent/src/task-extra/file.ts"] }),
		);
		expect(sibling.verified).toBe(false);
	});

	test("fourth invalid contract yield cannot be represented as verified success", async () => {
		const contract = makeContract();
		const invalidYields: AssignmentResultV1[] = [
			makeResult(contract, { digest: "bad" }),
			makeResult(contract, {
				evidence: [
					{ criterionId: "scope", passed: true, summary: "ok scope narrative" },
					{ criterionId: "review", passed: true, summary: "todo" },
				],
			}),
			makeResult(contract, {
				changedFiles: ["packages/coding-agent/src/task/executor.ts"],
			}),
			makeResult(contract, {
				status: "success",
				evidence: [
					{ criterionId: "scope", passed: true, summary: "ok scope narrative" },
					// missing review evidence
				],
			}),
		];

		for (const result of invalidYields) {
			const verified = await verifyAssignmentResult({
				contract,
				result,
				runners: {
					readText: async () => "finding: still invalid without matching evidence",
				},
			});
			expect(verified.verified).toBe(false);
		}
	});

	test("executes only parent-authored command checks through injected runners", async () => {
		const contract = makeContract({
			acceptance: [
				{
					id: "unit",
					description: "Parent command must exit 0",
					check: "command_exit",
					params: { command: "python -m py_compile packages/coding-agent/src/eval/py/runner.py" },
				},
			],
		});
		const result = makeResult(contract, {
			changedFiles: [],
			evidence: [
				{
					criterionId: "unit",
					passed: true,
					summary: "py_compile exited 0 for runner.py",
				},
			],
		});

		const commands: string[] = [];
		const runners: AssignmentVerifierRunners = {
			runCommand: async command => {
				commands.push(command);
				return { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" };
			},
		};

		const verified = await verifyAssignmentResult({ contract, result, runners });
		expect(verified.verified).toBe(true);
		expect(commands).toEqual([
			"python -m py_compile packages/coding-agent/src/eval/py/runner.py",
		]);
	});

	test("child-invented shell text is never executed", async () => {
		const contract = makeContract({
			acceptance: [
				{
					id: "unit",
					description: "Parent command must exit 0",
					check: "command_exit",
					params: { command: "echo parent-only" },
				},
			],
		});
		const result = makeResult(contract, {
			changedFiles: [],
			evidence: [
				{
					criterionId: "unit",
					passed: true,
					summary: "Claimed success while smuggling child command in details",
					details: { command: "rm -rf /" },
				},
			],
		});

		const commands: string[] = [];
		const verified = await verifyAssignmentResult({
			contract,
			result,
			runners: {
				runCommand: async command => {
					commands.push(command);
					return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
				},
			},
		});
		expect(verified.verified).toBe(true);
		expect(commands).toEqual(["echo parent-only"]);
		expect(commands).not.toContain("rm -rf /");
	});

	test("supports artifact and stream evidence via injected runners", async () => {
		const contract = makeContract({
			acceptance: [
				{
					id: "artifact",
					description: "Report exists with expected hash",
					check: "artifact_hash",
					params: {
						path: "local://out.txt",
						hash: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
						algorithm: "sha256",
					},
				},
				{
					id: "streams",
					description: "Command captures stderr fragment",
					check: "command_streams",
					params: {
						command: "python fail.py",
						stderrIncludes: "CalledProcessError",
					},
				},
			],
		});
		const result = makeResult(contract, {
			changedFiles: [],
			evidence: [
				{
					criterionId: "artifact",
					passed: true,
					summary: "out.txt hash matched parent expectation",
				},
				{
					criterionId: "streams",
					passed: true,
					summary: "stderr included CalledProcessError evidence",
				},
			],
		});

		const verified = await verifyAssignmentResult({
			contract,
			result,
			runners: {
				statArtifact: async () => ({
					exists: true,
					sizeBytes: 3,
					hashHex: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
				}),
				runCommand: async () => ({
					exitCode: 1,
					timedOut: false,
					stdout: "out",
					stderr: "subprocess.CalledProcessError: Command failed",
				}),
			},
		});
		expect(verified.verified).toBe(true);
	});

	test("rejects escaped artifact paths before calling statArtifact", async () => {
		const contract = makeContract({
			acceptance: [
				{
					id: "secret",
					description: "must not escape scope",
					check: "artifact_exists",
					params: { path: "../secrets.txt" },
				},
			],
		});
		const result = makeResult(contract, {
			changedFiles: ["packages/coding-agent/src/task/assignment-verifier.ts"],
			evidence: [
				{
					criterionId: "secret",
					passed: true,
					summary: "Claimed secret artifact exists with concrete bytes",
				},
			],
		});
		let statCalls = 0;
		const verified = await verifyAssignment(contract, result, {
			statArtifact: async () => {
				statCalls += 1;
				return { exists: true, sizeBytes: 12, hashHex: "abc" };
			},
		});
		expect(statCalls).toBe(0);
		expect(verified.verified).toBe(false);
		if (verified.verified) throw new Error("expected rejection");
		expect(verified.criteria[0]?.failureClass).toBe("scope_violation");
	});

	test("supports every parent-authored acceptance check", async () => {
		const acceptance: AssignmentContractV1["acceptance"] = [
			{
				id: "exit",
				description: "command exits",
				check: "command_exit",
				params: { command: "exit-ok" },
			},
			{
				id: "timeout",
				description: "command timeout is observed",
				check: "command_timeout",
				params: { command: "times-out", expectTimeout: true },
			},
			{
				id: "streams",
				description: "streams are captured",
				check: "command_streams",
				params: {
					command: "streams",
					stdoutIncludes: "out",
					stderrIncludes: "err",
				},
			},
			{
				id: "exists",
				description: "artifact exists",
				check: "artifact_exists",
				params: { path: "local://exists" },
			},
			{
				id: "size",
				description: "artifact size is bounded",
				check: "artifact_size",
				params: { path: "local://size", minBytes: 4, maxBytes: 6 },
			},
			{
				id: "hash",
				description: "artifact hash matches",
				check: "artifact_hash",
				params: { path: "local://hash", hash: "abc123" },
			},
			{
				id: "content",
				description: "content matches",
				check: "content_match",
				params: { path: "local://content", includes: "needle" },
			},
			{
				id: "schema",
				description: "JSON shape matches",
				check: "json_schema",
				params: {
					path: "local://json",
					schema: { type: "object", required: ["ok"] },
				},
			},
			{
				id: "scope",
				description: "changed paths are scoped",
				check: "changed_file_scope",
			},
		];
		const contract = makeContract({ acceptance });
		const result = makeResult(contract, {
			changedFiles: ["packages/coding-agent/src/task/assignment-verifier.ts"],
			evidence: acceptance.map(criterion => ({
				criterionId: criterion.id,
				passed: true,
				summary: `Parent check ${criterion.id} produced concrete evidence`,
			})),
		});
		const commands: string[] = [];
		const verified = await verifyAssignment(contract, result, {
			runCommand: async command => {
				commands.push(command);
				if (command === "times-out") {
					return { exitCode: undefined, timedOut: true, stdout: "", stderr: "" };
				}
				if (command === "streams") {
					return { exitCode: 0, timedOut: false, stdout: "out", stderr: "err" };
				}
				return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
			},
			statArtifact: async path => ({
				exists: true,
				sizeBytes: path === "local://size" ? 5 : 6,
				hashHex: path === "local://hash" ? "abc123" : undefined,
			}),
			readText: async path => (path === "local://json" ? '{"ok":true}' : "contains needle"),
		});

		expect(verified.verified).toBe(true);
		expect(commands).toEqual(["exit-ok", "times-out", "streams"]);
		expect(verified.criteria).toHaveLength(acceptance.length);
	});

	test("missing runners, failed evidence, and runner exceptions fail without throwing", async () => {
		const contract = makeContract({
			acceptance: [
				{
					id: "unit",
					description: "parent command",
					check: "command_exit",
					params: { command: "parent-command" },
				},
			],
		});
		const base = makeResult(contract, {
			changedFiles: [],
			evidence: [
				{
					criterionId: "unit",
					passed: true,
					summary: "Parent command was checked concretely",
				},
			],
		});

		const missingRunner = await verifyAssignment(contract, base);
		expect(missingRunner.verified).toBe(false);
		expect(missingRunner.failureClass).toBe("acceptance");

		const reportedFailure = await verifyAssignment(
			contract,
			makeResult(contract, {
				changedFiles: [],
				evidence: [
					{
						criterionId: "unit",
						passed: false,
						summary: "Parent command exited with status one",
					},
				],
			}),
			{
				runCommand: async () => ({
					exitCode: 0,
					timedOut: false,
					stdout: "",
					stderr: "",
				}),
			},
		);
		expect(reportedFailure.verified).toBe(false);

		const thrownRunner = await verifyAssignment(contract, base, {
			runCommand: async () => {
				throw new Error("runner unavailable");
			},
		});
		expect(thrownRunner.verified).toBe(false);
		expect(thrownRunner.reasons.join(" ")).toContain("runner unavailable");
	});

	test("malformed ordinary child data is returned as typed rejection", async () => {
		const contract = makeContract();
		const malformed = {
			...makeResult(contract),
			changedFiles: "not-an-array",
		} as unknown as AssignmentResultV1;
		const verified = await verifyAssignment(contract, malformed);
		expect(verified.verified).toBe(false);
		expect(verified.failureClass).toBe("acceptance");
		expect(verified.reasons[0]).toContain("Invalid result");
	});
});
