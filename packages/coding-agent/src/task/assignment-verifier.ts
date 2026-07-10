/**
 * Semantic assignment-contract verifier.
 *
 * Validates digest-bound child results against parent-authored immutable
 * acceptance checks. Ordinary child data never throws as control flow.
 */

import { createHash } from "node:crypto";
import {
	computeAssignmentContractDigest,
	parseAssignmentContract,
	parseAssignmentResult,
	type AcceptanceCriterion,
	type AcceptanceEvidence,
	type AssignmentContractV1,
	type AssignmentResultV1,
} from "./assignment-contract";
import type { AssignmentFailureClass } from "./recovery-policy";

export type VerificationFailureClass =
	| "contract_mismatch"
	| "missing_evidence"
	| "duplicate_evidence"
	| "placeholder_narrative"
	| "scope_violation"
	| "check_failed"
	| "check_error"
	| "invalid_result";

export interface CommandCheckResult {
	readonly exitCode: number | undefined;
	readonly timedOut: boolean;
	readonly stdout: string;
	readonly stderr: string;
	readonly durationMs?: number;
}

export interface ArtifactStat {
	readonly exists: boolean;
	readonly sizeBytes?: number;
	readonly hashHex?: string;
}

/**
 * Parent-injected runners. Only parent-authored commands/paths from the
 * contract are executed — never child-invented shell text.
 */
export interface AssignmentVerifierRunners {
	runCommand?: (
		command: string,
		params: Readonly<Record<string, unknown>>,
	) => Promise<CommandCheckResult>;
	statArtifact?: (path: string, algorithm?: string) => Promise<ArtifactStat>;
	readText?: (path: string) => Promise<string>;
	parseJson?: (text: string) => unknown;
}

export interface VerifyAssignmentInput {
	readonly contract: AssignmentContractV1;
	readonly result: AssignmentResultV1;
	readonly runners?: AssignmentVerifierRunners;
}

export interface CriterionVerification {
	readonly criterionId: string;
	readonly passed: boolean;
	readonly failureClass?: VerificationFailureClass;
	readonly reason: string;
	readonly details?: Readonly<Record<string, unknown>>;
}

interface AssignmentVerificationResultBase {
	readonly reasons: readonly string[];
	readonly criteria: readonly CriterionVerification[];
}

export interface VerifiedAssignmentResult extends AssignmentVerificationResultBase {
	readonly verified: true;
	readonly failureClass?: never;
}

export interface RejectedAssignmentResult extends AssignmentVerificationResultBase {
	readonly verified: false;
	readonly failureClass: AssignmentFailureClass;
}

export type AssignmentVerificationResult = VerifiedAssignmentResult | RejectedAssignmentResult;
export type VerificationResult = AssignmentVerificationResult;

const PLACEHOLDER_EXACT = new Set([
	"test",
	"todo",
	"tbd",
	"n/a",
	"na",
	"none",
	"placeholder",
	"lorem ipsum",
	"fix me",
	"xxx",
	"...",
	"…",
]);

const PLACEHOLDER_MARKERS = [
	/\{\{[^{}]*\}\}/,
	/<\s*placeholder(?:\s[^>]*)?>/i,
	/<your\s+[^>]+>/i,
	/\[(?:insert|replace|fill)[^\]]*\]/i,
];

function normalizeNarrative(text: string): string {
	return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function isRepeatedFiller(normalized: string): boolean {
	const compact = normalized.replace(/[^a-z0-9]+/g, "");
	if (/^([a-z0-9])\1{5,}$/.test(compact)) return true;

	const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
	if (tokens.length < 3) return false;
	for (let unitLength = 1; unitLength <= Math.floor(tokens.length / 3); unitLength++) {
		if (tokens.length % unitLength !== 0) continue;
		let repeated = true;
		for (let index = unitLength; index < tokens.length; index++) {
			if (tokens[index] !== tokens[index % unitLength]) {
				repeated = false;
				break;
			}
		}
		if (repeated) return true;
	}
	return false;
}

/** True when narrative is placeholder-only or repeated filler. */
export function isPlaceholderNarrative(text: string): boolean {
	const normalized = normalizeNarrative(text);
	if (!normalized) return true;
	if (PLACEHOLDER_MARKERS.some(pattern => pattern.test(text))) return true;
	const literal = normalized.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
	return PLACEHOLDER_EXACT.has(literal) || isRepeatedFiller(normalized);
}

function normalizeRepoPath(value: string, allowRoot: boolean): string | undefined {
	let normalized = value.trim().replaceAll("\\", "/");
	if (allowRoot && (normalized === "." || normalized === "./")) return "";
	while (normalized.startsWith("./")) normalized = normalized.slice(2);
	if (normalized.endsWith("/**")) normalized = normalized.slice(0, -3);
	else if (normalized.endsWith("/*")) normalized = normalized.slice(0, -2);
	normalized = normalized.replace(/\/+$/, "");
	if (
		!normalized ||
		normalized.startsWith("/") ||
		/^[a-z]:\//i.test(normalized) ||
		normalized.includes("\0")
	) {
		return undefined;
	}

	const segments: string[] = [];
	for (const segment of normalized.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return undefined;
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	if (segments.length === 0) return allowRoot ? "" : undefined;
	return segments.join("/");
}

function pathMatches(prefixValue: string, filePath: string): boolean {
	const prefix = normalizeRepoPath(prefixValue, true);
	const normalizedPath = normalizeRepoPath(filePath, false);
	if (prefix === undefined || normalizedPath === undefined) return false;
	return prefix === "" || normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
}

export function isPathInScope(
	filePath: string,
	scope: AssignmentContractV1["scope"],
): boolean {
	const denied = scope.deniedPaths ?? [];
	if (denied.some(prefix => pathMatches(prefix, filePath))) return false;
	return scope.allowedPaths.some(prefix => pathMatches(prefix, filePath));
}

function firstFailure(
	criteria: readonly CriterionVerification[],
): CriterionVerification | undefined {
	return criteria.find(item => !item.passed);
}

function evidenceByCriterion(
	evidence: readonly AcceptanceEvidence[],
): Map<string, AcceptanceEvidence[]> {
	const map = new Map<string, AcceptanceEvidence[]>();
	for (const item of evidence) {
		const list = map.get(item.criterionId) ?? [];
		list.push(item);
		map.set(item.criterionId, list);
	}
	return map;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
		return undefined;
	}
	return value;
}

async function runParentCommand(
	criterion: AcceptanceCriterion,
	runners: AssignmentVerifierRunners | undefined,
): Promise<
	| { ok: true; result: CommandCheckResult; command: string }
	| { ok: false; reason: string; failureClass: VerificationFailureClass }
> {
	const command =
		asString(criterion.params?.command) ??
		asString(criterion.params?.cmd);
	if (!command || !command.trim()) {
		return {
			ok: false,
			failureClass: "check_error",
			reason: `Criterion "${criterion.id}" is missing parent-authored command params`,
		};
	}
	if (!runners?.runCommand) {
		return {
			ok: false,
			failureClass: "check_error",
			reason: `Criterion "${criterion.id}" requires an injected runCommand runner`,
		};
	}
	try {
		const result = await runners.runCommand(command, criterion.params ?? {});
		return { ok: true, result, command };
	} catch (error) {
		return {
			ok: false,
			failureClass: "check_error",
			reason: `Criterion "${criterion.id}" command runner failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

function validateJsonAgainstSchema(
	value: unknown,
	schema: Readonly<Record<string, unknown>>,
): string | undefined {
	const type = asString(schema.type);
	if (type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return "expected object";
		}
		const required = asStringArray(schema.required) ?? [];
		const record = value as Record<string, unknown>;
		for (const key of required) {
			if (!(key in record)) return `missing required property "${key}"`;
		}
		return undefined;
	}
	if (type === "array") {
		return Array.isArray(value) ? undefined : "expected array";
	}
	if (type === "string") {
		return typeof value === "string" ? undefined : "expected string";
	}
	if (type === "number") {
		return typeof value === "number" ? undefined : "expected number";
	}
	if (type === "boolean") {
		return typeof value === "boolean" ? undefined : "expected boolean";
	}
	if (type === "null") {
		return value === null ? undefined : "expected null";
	}
	return undefined;
}

async function verifyCriterion(
	criterion: AcceptanceCriterion,
	contract: AssignmentContractV1,
	result: AssignmentResultV1,
	evidenceItems: readonly AcceptanceEvidence[],
	runners: AssignmentVerifierRunners | undefined,
): Promise<CriterionVerification> {
	if (evidenceItems.length === 0) {
		return {
			criterionId: criterion.id,
			passed: false,
			failureClass: "missing_evidence",
			reason: `Missing evidence for criterion "${criterion.id}"`,
		};
	}
	if (evidenceItems.length > 1) {
		return {
			criterionId: criterion.id,
			passed: false,
			failureClass: "duplicate_evidence",
			reason: `Duplicate evidence for criterion "${criterion.id}"`,
		};
	}

	const evidence = evidenceItems[0];
	if (isPlaceholderNarrative(evidence.summary)) {
		return {
			criterionId: criterion.id,
			passed: false,
			failureClass: "placeholder_narrative",
			reason: `Evidence summary for "${criterion.id}" is placeholder-only`,
			details: { summary: evidence.summary },
		};
	}
	if (!evidence.passed) {
		return {
			criterionId: criterion.id,
			passed: false,
			failureClass: "check_failed",
			reason: `Child reported criterion "${criterion.id}" as failed: ${evidence.summary}`,
		};
	}

	switch (criterion.check) {
		case "changed_file_scope": {
			const outOfScope = result.changedFiles.filter(
				filePath => !isPathInScope(filePath, contract.scope),
			);
			if (outOfScope.length > 0) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "scope_violation",
					reason: `Changed paths outside declared scope: ${outOfScope.join(", ")}`,
					details: { outOfScope },
				};
			}
			if (!evidence.passed) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_failed",
					reason: evidence.summary,
				};
			}
			return {
				criterionId: criterion.id,
				passed: true,
				reason: evidence.summary,
			};
		}
		case "command_exit": {
			const ran = await runParentCommand(criterion, runners);
			if (!ran.ok) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: ran.failureClass,
					reason: ran.reason,
				};
			}
			const expected = asNumber(criterion.params?.expectedExitCode) ?? 0;
			if (ran.result.timedOut) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_failed",
					reason: `Command timed out before exit for "${criterion.id}"`,
					details: { command: ran.command },
				};
			}
			if (ran.result.exitCode !== expected) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_failed",
					reason: `Expected exit ${expected}, got ${String(ran.result.exitCode)}`,
					details: {
						command: ran.command,
						exitCode: ran.result.exitCode,
						stdout: ran.result.stdout,
						stderr: ran.result.stderr,
					},
				};
			}
			return {
				criterionId: criterion.id,
				passed: true,
				reason: evidence.summary,
				details: { command: ran.command, exitCode: ran.result.exitCode },
			};
		}
		case "command_timeout": {
			const ran = await runParentCommand(criterion, runners);
			if (!ran.ok) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: ran.failureClass,
					reason: ran.reason,
				};
			}
			const expectTimeout = asBoolean(criterion.params?.expectTimeout) ?? true;
			if (ran.result.timedOut !== expectTimeout) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_failed",
					reason: expectTimeout
						? `Expected command timeout for "${criterion.id}"`
						: `Unexpected command timeout for "${criterion.id}"`,
					details: {
						command: ran.command,
						timedOut: ran.result.timedOut,
						durationMs: ran.result.durationMs,
					},
				};
			}
			return {
				criterionId: criterion.id,
				passed: true,
				reason: evidence.summary,
				details: {
					command: ran.command,
					timedOut: ran.result.timedOut,
					durationMs: ran.result.durationMs,
				},
			};
		}
		case "command_streams": {
			const ran = await runParentCommand(criterion, runners);
			if (!ran.ok) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: ran.failureClass,
					reason: ran.reason,
				};
			}
			const stdoutIncludes = asString(criterion.params?.stdoutIncludes);
			const stderrIncludes = asString(criterion.params?.stderrIncludes);
			const stdoutExcludes = asString(criterion.params?.stdoutExcludes);
			const stderrExcludes = asString(criterion.params?.stderrExcludes);
			if (stdoutIncludes && !ran.result.stdout.includes(stdoutIncludes)) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_failed",
					reason: `stdout missing expected fragment for "${criterion.id}"`,
					details: { command: ran.command, stdout: ran.result.stdout },
				};
			}
			if (stderrIncludes && !ran.result.stderr.includes(stderrIncludes)) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_failed",
					reason: `stderr missing expected fragment for "${criterion.id}"`,
					details: { command: ran.command, stderr: ran.result.stderr },
				};
			}
			if (stdoutExcludes && ran.result.stdout.includes(stdoutExcludes)) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_failed",
					reason: `stdout contained forbidden fragment for "${criterion.id}"`,
					details: { command: ran.command, stdout: ran.result.stdout },
				};
			}
			if (stderrExcludes && ran.result.stderr.includes(stderrExcludes)) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_failed",
					reason: `stderr contained forbidden fragment for "${criterion.id}"`,
					details: { command: ran.command, stderr: ran.result.stderr },
				};
			}
			return {
				criterionId: criterion.id,
				passed: true,
				reason: evidence.summary,
				details: {
					command: ran.command,
					stdout: ran.result.stdout,
					stderr: ran.result.stderr,
				},
			};
		}
		case "artifact_exists":
		case "artifact_size":
		case "artifact_hash": {
			const artifactPath = asString(criterion.params?.path);
			if (!artifactPath) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_error",
					reason: `Criterion "${criterion.id}" is missing parent-authored path`,
				};
			}
			if (!runners?.statArtifact) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_error",
					reason: `Criterion "${criterion.id}" requires an injected statArtifact runner`,
				};
			}
			const algorithm = asString(criterion.params?.algorithm) ?? "sha256";
			let stat: ArtifactStat;
			try {
				stat = await runners.statArtifact(artifactPath, algorithm);
			} catch (error) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_error",
					reason: `Artifact runner failed for "${criterion.id}": ${
						error instanceof Error ? error.message : String(error)
					}`,
				};
			}
			if (criterion.check === "artifact_exists") {
				const expectExists = asBoolean(criterion.params?.exists) ?? true;
				if (stat.exists !== expectExists) {
					return {
						criterionId: criterion.id,
						passed: false,
						failureClass: "check_failed",
						reason: expectExists
							? `Artifact missing: ${artifactPath}`
							: `Artifact unexpectedly exists: ${artifactPath}`,
					};
				}
				return {
					criterionId: criterion.id,
					passed: true,
					reason: evidence.summary,
					details: { path: artifactPath, exists: stat.exists },
				};
			}
			if (!stat.exists) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_failed",
					reason: `Artifact missing: ${artifactPath}`,
				};
			}
			if (criterion.check === "artifact_size") {
				const minBytes = asNumber(criterion.params?.minBytes);
				const maxBytes = asNumber(criterion.params?.maxBytes);
				const exactBytes = asNumber(criterion.params?.bytes);
				const size = stat.sizeBytes;
				if (size === undefined) {
					return {
						criterionId: criterion.id,
						passed: false,
						failureClass: "check_error",
						reason: `Artifact size unavailable for ${artifactPath}`,
					};
				}
				if (exactBytes !== undefined && size !== exactBytes) {
					return {
						criterionId: criterion.id,
						passed: false,
						failureClass: "check_failed",
						reason: `Expected size ${exactBytes}, got ${size}`,
						details: { path: artifactPath, sizeBytes: size },
					};
				}
				if (minBytes !== undefined && size < minBytes) {
					return {
						criterionId: criterion.id,
						passed: false,
						failureClass: "check_failed",
						reason: `Artifact smaller than minBytes (${size} < ${minBytes})`,
						details: { path: artifactPath, sizeBytes: size },
					};
				}
				if (maxBytes !== undefined && size > maxBytes) {
					return {
						criterionId: criterion.id,
						passed: false,
						failureClass: "check_failed",
						reason: `Artifact larger than maxBytes (${size} > ${maxBytes})`,
						details: { path: artifactPath, sizeBytes: size },
					};
				}
				return {
					criterionId: criterion.id,
					passed: true,
					reason: evidence.summary,
					details: { path: artifactPath, sizeBytes: size },
				};
			}
			const expectedHash = asString(criterion.params?.hash)?.toLowerCase();
			if (!expectedHash) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_error",
					reason: `Criterion "${criterion.id}" is missing parent-authored hash`,
				};
			}
			if (!stat.hashHex) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_error",
					reason: `Artifact hash unavailable for ${artifactPath}`,
				};
			}
			if (stat.hashHex.toLowerCase() !== expectedHash) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_failed",
					reason: `Artifact hash mismatch for ${artifactPath}`,
					details: {
						path: artifactPath,
						expectedHash,
						actualHash: stat.hashHex,
						algorithm,
					},
				};
			}
			return {
				criterionId: criterion.id,
				passed: true,
				reason: evidence.summary,
				details: { path: artifactPath, hash: stat.hashHex, algorithm },
			};
		}
		case "content_match": {
			const artifactPath = asString(criterion.params?.path);
			const includes = asString(criterion.params?.includes);
			const pattern = asString(criterion.params?.pattern);
			if (!artifactPath) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_error",
					reason: `Criterion "${criterion.id}" is missing parent-authored path`,
				};
			}
			if (!runners?.readText) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_error",
					reason: `Criterion "${criterion.id}" requires an injected readText runner`,
				};
			}
			let text: string;
			try {
				text = await runners.readText(artifactPath);
			} catch (error) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_error",
					reason: `readText failed for "${criterion.id}": ${
						error instanceof Error ? error.message : String(error)
					}`,
				};
			}
			if (includes && !text.includes(includes)) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_failed",
					reason: `Content missing expected fragment in ${artifactPath}`,
				};
			}
			if (pattern) {
				const flags = asString(criterion.params?.flags) ?? undefined;
				const re = new RegExp(pattern, flags);
				if (!re.test(text)) {
					return {
						criterionId: criterion.id,
						passed: false,
						failureClass: "check_failed",
						reason: `Content did not match pattern in ${artifactPath}`,
					};
				}
			}
			return {
				criterionId: criterion.id,
				passed: true,
				reason: evidence.summary,
				details: { path: artifactPath },
			};
		}
		case "json_schema": {
			const artifactPath = asString(criterion.params?.path);
			const schema = criterion.params?.schema;
			if (!artifactPath) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_error",
					reason: `Criterion "${criterion.id}" is missing parent-authored path`,
				};
			}
			if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_error",
					reason: `Criterion "${criterion.id}" is missing parent-authored JSON schema`,
				};
			}
			if (!runners?.readText) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_error",
					reason: `Criterion "${criterion.id}" requires an injected readText runner`,
				};
			}
			let text: string;
			try {
				text = await runners.readText(artifactPath);
			} catch (error) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_error",
					reason: `readText failed for "${criterion.id}": ${
						error instanceof Error ? error.message : String(error)
					}`,
				};
			}
			let parsed: unknown;
			try {
				parsed = runners.parseJson ? runners.parseJson(text) : JSON.parse(text);
			} catch (error) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_failed",
					reason: `Invalid JSON in ${artifactPath}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				};
			}
			const schemaError = validateJsonAgainstSchema(
				parsed,
				schema as Readonly<Record<string, unknown>>,
			);
			if (schemaError) {
				return {
					criterionId: criterion.id,
					passed: false,
					failureClass: "check_failed",
					reason: `JSON schema validation failed for ${artifactPath}: ${schemaError}`,
				};
			}
			return {
				criterionId: criterion.id,
				passed: true,
				reason: evidence.summary,
				details: { path: artifactPath },
			};
		}
		default: {
			return {
				criterionId: criterion.id,
				passed: false,
				failureClass: "check_error",
				reason: `Unsupported acceptance check "${String((criterion as AcceptanceCriterion).check)}"`,
			};
		}
	}
}

function rejectedVerification(reasons: readonly string[]): AssignmentVerificationResult {
	return {
		verified: false,
		failureClass: "acceptance",
		reasons: Object.freeze([...reasons]),
		criteria: Object.freeze([] as CriterionVerification[]),
	};
}

async function verifyParsedAssignment(
	contract: AssignmentContractV1,
	result: AssignmentResultV1,
	runners?: AssignmentVerifierRunners,
): Promise<AssignmentVerificationResult> {
	const reasons: string[] = [];
	const criteria: CriterionVerification[] = [];

	if (result.contractId !== contract.id) {
		return rejectedVerification([
			`Result contractId "${result.contractId}" does not match contract id "${contract.id}"`,
		]);
	}
	if (result.revision !== contract.revision) {
		return rejectedVerification([
			`Result revision ${result.revision} does not match contract revision ${contract.revision}`,
		]);
	}

	const expectedDigest = computeAssignmentContractDigest(contract);
	if (result.digest !== contract.digest || result.digest !== expectedDigest) {
		return rejectedVerification(["Result digest does not match parent contract digest"]);
	}

	if (result.summary !== undefined && isPlaceholderNarrative(result.summary)) {
		return rejectedVerification(["Result summary is placeholder-only"]);
	}
	const placeholderBlocker = result.blockers?.find(isPlaceholderNarrative);
	if (placeholderBlocker !== undefined) {
		return rejectedVerification([`Result blocker is placeholder-only: ${placeholderBlocker}`]);
	}

	const outOfScope = result.changedFiles.filter(filePath => !isPathInScope(filePath, contract.scope));
	if (outOfScope.length > 0) {
		return rejectedVerification([`Changed paths outside declared scope: ${outOfScope.join(", ")}`]);
	}

	const byId = evidenceByCriterion(result.evidence);
	for (const [criterionId, items] of byId) {
		if (!contract.acceptance.some(criterion => criterion.id === criterionId)) {
			return rejectedVerification([`Evidence references unknown criterion "${criterionId}"`]);
		}
		if (items.length > 1) {
			return rejectedVerification([`Duplicate evidence for criterion "${criterionId}"`]);
		}
	}

	for (const criterion of contract.acceptance) {
		const items = byId.get(criterion.id) ?? [];
		let verified: CriterionVerification;
		try {
			verified = await verifyCriterion(criterion, contract, result, items, runners);
		} catch (error) {
			verified = {
				criterionId: criterion.id,
				passed: false,
				failureClass: "check_error",
				reason: `Acceptance check "${criterion.id}" failed safely: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
		criteria.push(verified);
		if (!verified.passed) reasons.push(verified.reason);
	}

	const failed = firstFailure(criteria);
	if (failed) {
		return {
			verified: false,
			failureClass: "acceptance",
			reasons: Object.freeze(reasons),
			criteria: Object.freeze(criteria),
		};
	}

	if (result.status !== "success") {
		return {
			verified: false,
			failureClass: "acceptance",
			reasons: Object.freeze([`Result status "${result.status}" is not verified success`]),
			criteria: Object.freeze(criteria),
		};
	}

	return {
		verified: true,
		reasons: Object.freeze([] as string[]),
		criteria: Object.freeze(criteria),
	};
}

/**
 * Verify a digest-bound result. Malformed contract/result data and runner
 * failures return typed rejection rather than escaping as child-data control
 * flow.
 */
export async function verifyAssignment(
	contractInput: AssignmentContractV1,
	resultInput: AssignmentResultV1,
	runners?: AssignmentVerifierRunners,
): Promise<VerificationResult> {
	try {
		const parsedContract = parseAssignmentContract(contractInput);
		if (!parsedContract.ok) {
			return rejectedVerification(
				parsedContract.diagnostics.map(diagnostic => `Invalid contract: ${diagnostic.message}`),
			);
		}

		const parsedResult = parseAssignmentResult(resultInput);
		if (!parsedResult.ok) {
			return rejectedVerification(
				parsedResult.diagnostics.map(diagnostic => `Invalid result: ${diagnostic.message}`),
			);
		}
		return await verifyParsedAssignment(parsedContract.contract, parsedResult.result, runners);
	} catch (error) {
		return rejectedVerification([
			`Assignment verification rejected malformed data: ${error instanceof Error ? error.message : String(error)}`,
		]);
	}
}

/** Object-input compatibility wrapper for integration callers. */
export async function verifyAssignmentResult(
	input: VerifyAssignmentInput,
): Promise<VerificationResult> {
	return await verifyAssignment(input.contract, input.result, input.runners);
}

/** Helper for tests/callers that hash artifact bytes with a known algorithm. */
export function hashBytes(data: string | Uint8Array, algorithm = "sha256"): string {
	return createHash(algorithm).update(data).digest("hex");
}
