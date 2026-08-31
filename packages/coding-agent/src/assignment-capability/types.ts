export const ASSIGNMENT_CAPABILITY_SCHEMA = "juiz.assignment-capability/1" as const;

/** Immutable launch inputs supplied by the runtime that owns the Herdr pane. */
export interface AssignmentCapabilityLaunchOptions {
	readonly schema: typeof ASSIGNMENT_CAPABILITY_SCHEMA;
	readonly herdrSocketPath: string;
	readonly pane: string;
	readonly session: string;
	readonly juizGatewayArgv: readonly [string, ...string[]];
}

export type AssignmentCapabilityScope = "assignment.execution.request" | "assignment.complete" | "assignment.revoke";

export interface AssignmentCapabilityRecord {
	readonly schema: typeof ASSIGNMENT_CAPABILITY_SCHEMA;
	readonly capability: string;
	readonly generation: number;
	readonly thread: string;
	readonly participant: string;
	readonly session: string;
	readonly leaseGeneration: number;
	readonly delivery: string;
	readonly resource: string;
	readonly assignment: string;
	readonly preparationDigest: string;
	readonly scopes: readonly AssignmentCapabilityScope[];
	readonly authorityProvenance: string;
	readonly issuedAt: string;
	readonly expiresAt: string;
	readonly renewalDeadline: string;
	readonly maxOperationDurationMillis: number;
	readonly revocationGeneration: number;
	readonly herdrBinding: string;
	readonly herdrGeneration: number;
	readonly herdrProofKeyDigest: string;
	readonly controllerPolicyDigest: string;
}

export interface AssignmentCapabilityNotice {
	readonly delivery: string;
	readonly capability: AssignmentCapabilityRecord;
	readonly capabilityToken: string;
}

export interface AssignmentCapabilityBinding {
	readonly binding: string;
	readonly generation: number;
	readonly workspace: string;
	readonly pane: string;
	readonly session: string;
	readonly holderSecret: string;
	readonly herdrProofKey: string;
	readonly observedAt: string;
}

export interface AssignmentExecuteInput {
	readonly toolCall: string;
	readonly tool: "write" | "edit" | "ast_edit" | "lsp";
	readonly tier: "write";
	readonly effectiveArgs: unknown;
	readonly effectiveArgsDigest: string;
}

export interface AssignmentTerminalReceipt {
	readonly attempt: string;
	readonly launchDigest: string;
	readonly disposition: "succeeded" | "failed" | "indeterminate";
	readonly checkpointDigest: string;
	readonly promotion: "promoted" | "quarantined" | "failed" | "indeterminate";
	readonly cleanup: "completed" | "retained";
	readonly fenceGeneration: number;
	readonly fencePhase: string;
	readonly reconciliation: unknown;
}

export interface AssignmentExecuteResult {
	readonly toolResult: unknown;
	readonly receipt: AssignmentTerminalReceipt;
}

export interface AssignmentCompletionReceipt {
	readonly capability: string;
	readonly generation: number;
	readonly revocationGeneration: number;
	readonly state: "revoked";
	readonly assignmentState: "completed-unlanded";
	readonly denialProofDigest: string;
	readonly requestAttempt: string;
}

export interface AssignmentCompletionResult {
	readonly toolResult: unknown;
	readonly completion: AssignmentCompletionReceipt;
}
