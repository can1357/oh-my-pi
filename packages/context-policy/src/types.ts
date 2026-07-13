export const CONTEXT_CATEGORIES = [
	"raw_capture",
	"extracted_text",
	"session_summary",
	"workflow_state",
	"preference",
	"audit_action",
	"final_deliverable",
	"error_log",
	"temporary",
	"quarantine",
] as const;

export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];
export type ContextPolicyVersion = "context-retention/v1";
export type ConsentScope = "none" | "session" | "project" | "selected_apps" | "device" | "trusted_devices";
export type Durability = "ephemeral" | "rebuildable" | "authoritative" | "record";
export type Sensitivity = "public" | "internal" | "confidential" | "restricted";

export interface ArtifactProvenance {
	sourceType: string;
	sourceApplication?: string;
	capturedAt: string;
	confidence: number;
}

export interface ContextArtifactPolicy {
	policyVersion: ContextPolicyVersion;
	category: ContextCategory;
	durability: Durability;
	userId: string;
	deviceId: string;
	projectId?: string;
	caseId?: string;
	sessionId: string;
	createdAt: string;
	expiresAt?: string;
	transitionToColdAt?: string;
	sensitivity: Sensitivity;
	provenance: ArtifactProvenance;
	queryable: boolean;
	immutable: boolean;
	legalHold?: boolean;
	parentArtifactIds?: string[];
}

export interface ConsentRecord {
	userId: string;
	deviceId: string;
	identityVerified: boolean;
	enabled: boolean;
	scope: ConsentScope;
	sessionId?: string;
	projectIds?: string[];
	applicationIds?: string[];
	remoteStorageEnabled: boolean;
	grantedAt?: string;
	revokedAt?: string;
	policyVersion: ContextPolicyVersion;
}

export interface ContextCategoryRetention {
	ttlDays?: number;
	coldAfterDays?: number;
	ttlMode?: "case_closed_plus_days" | "governed";
	daysAfterClose?: number;
	queryable: boolean;
	immutable?: boolean;
	governed?: boolean;
}

export interface ContextRetentionPolicy {
	version: ContextPolicyVersion;
	enabledByDefault: false;
	remoteStorageEnabledByDefault: false;
	categories: Record<ContextCategory, ContextCategoryRetention>;
	hardRules: {
		requireExplicitConsent: true;
		requireVerifiedIdentity: true;
		requireCategory: true;
		requireProvenance: true;
		encryptBeforeRemoteUpload: true;
		denyCrossUserReads: true;
		denyCrossProjectReadsByDefault: true;
		denyRawPromptInjection: true;
		cascadeDeletion: true;
		minimumFreeDiskBytes: number;
		minimumFreeDiskPercent: number;
	};
}
