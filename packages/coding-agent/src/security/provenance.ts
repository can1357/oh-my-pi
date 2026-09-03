import type { SecurityAccountRef, SecurityProducer, SecurityProvenance, SecurityScan } from "./contracts";
import { canonicalSecurityJson } from "./contracts";

export const CODEX_SECURITY_UPSTREAM = {
	repository: "https://github.com/openai/codex-security",
	revision: "f22d4a36f26d16287bcdfd707b369116e02a08c3",
	packageVersion: "0.1.1",
	pluginVersion: "0.1.14",
	archiveSha256: "13745c495b7c5cf5273cf2115df86b9c3ec3056f43151c869e004aa3f30bcffb",
} as const;

export const OMP_SECURITY_WORKFLOW_VERSION = "1.0.0";

export function createNativeSecurityProducer(): SecurityProducer {
	return {
		kind: "omp-native",
		name: "OMP Native Security",
		version: OMP_SECURITY_WORKFLOW_VERSION,
	};
}

export function createSecurityCredentialAffinity(account: SecurityAccountRef): string {
	return `omp-security-credential/v1:sha256:${Bun.SHA256.hash(canonicalSecurityJson(account), "hex")}`;
}
const PRIVATE_SECURITY_KEYS = new Set([
	"account",
	"accountid",
	"accesstoken",
	"apikey",
	"credentialid",
	"email",
	"organizationid",
	"organizationname",
	"orgid",
	"orgname",
	"refreshtoken",
	"secret",
	"sessionid",
	"token",
]);

export function redactPrivateSecurityMetadata(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactPrivateSecurityMetadata);
	if (!value || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
		if (PRIVATE_SECURITY_KEYS.has(normalizedKey)) continue;
		result[key] = redactPrivateSecurityMetadata(item);
	}
	return result;
}

export function createPublicSecurityScan(scan: SecurityScan, options: { includePlan?: boolean } = {}): unknown {
	const plan =
		options.includePlan && scan.plan
			? {
					...scan.plan,
					account: {
						provider: scan.plan.account.provider,
						credentialAffinity: createSecurityCredentialAffinity(scan.plan.account),
					},
				}
			: undefined;
	return redactPrivateSecurityMetadata({
		...scan,
		plan,
	});
}

export function createNativeSecurityProvenance(options: {
	createdAt: string;
	account: SecurityAccountRef;
	planFingerprint: string;
	workflowFingerprint: string;
	sessionId?: string;
	operationId?: string;
}): SecurityProvenance {
	const producer = createNativeSecurityProducer();
	const metadata: Record<string, unknown> = {
		planFingerprint: options.planFingerprint,
		workflowFingerprint: options.workflowFingerprint,
		credentialAffinity: createSecurityCredentialAffinity(options.account),
	};
	if (options.sessionId !== undefined) {
		metadata.sessionAffinity = `omp-security-session/v1:sha256:${Bun.SHA256.hash(options.sessionId, "hex")}`;
	}
	if (options.operationId !== undefined) metadata.operationId = options.operationId;
	return {
		producer,
		createdAt: options.createdAt,
		upstream: { ...CODEX_SECURITY_UPSTREAM },
		metadata,
	};
}

export function createSecurityWorkflowFingerprint(inputs: readonly string[]): string {
	return `omp-security-workflow/v1:sha256:${Bun.SHA256.hash(
		canonicalSecurityJson({
			workflowVersion: OMP_SECURITY_WORKFLOW_VERSION,
			upstream: CODEX_SECURITY_UPSTREAM,
			inputs,
		}),
		"hex",
	)}`;
}
