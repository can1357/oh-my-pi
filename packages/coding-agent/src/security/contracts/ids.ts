import type { SecurityLocation } from "./types";

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(record).sort()) {
		const item = record[key];
		if (item !== undefined) result[key] = canonicalize(item);
	}
	return result;
}

export function canonicalSecurityJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function normalizeFingerprintPath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function compareNormalizedLocationValues(
	left: string | number | undefined,
	right: string | number | undefined,
): number {
	if (left === right) return 0;
	if (left === undefined) return -1;
	if (right === undefined) return 1;
	if (typeof left === "number" && typeof right === "number") {
		const leftNaN = Number.isNaN(left);
		const rightNaN = Number.isNaN(right);
		if (leftNaN || rightNaN) return leftNaN ? (rightNaN ? 0 : -1) : 1;
		return left - right;
	}
	return String(left) < String(right) ? -1 : 1;
}

const NORMALIZED_LOCATION_SORT_KEYS = ["path", "startLine", "endLine", "startColumn", "endColumn", "role"] as const;

function normalizedLocations(
	locations: readonly SecurityLocation[],
): Array<Record<string, string | number | undefined>> {
	return locations
		.map(location => ({
			path: normalizeFingerprintPath(location.path),
			startLine: location.startLine,
			endLine: location.endLine,
			startColumn: location.startColumn,
			endColumn: location.endColumn,
			role: location.role,
		}))
		.sort((left, right) => {
			for (const key of NORMALIZED_LOCATION_SORT_KEYS) {
				const comparison = compareNormalizedLocationValues(left[key], right[key]);
				if (comparison !== 0) return comparison;
			}
			return 0;
		});
}

export interface SecurityFindingFingerprintInput {
	ruleId: string;
	category: string;
	anchor?: string;
	locations: readonly SecurityLocation[];
}

export function createSecurityFindingFingerprint(input: SecurityFindingFingerprintInput): string {
	const digest = Bun.SHA256.hash(
		canonicalSecurityJson({
			ruleId: input.ruleId.trim().toLowerCase(),
			category: input.category.trim().toLowerCase(),
			anchor: input.anchor?.trim().toLowerCase() || undefined,
			locations: normalizedLocations(input.locations),
		}),
		"hex",
	);
	return `omp-security/v1:sha256:${digest}`;
}

export function createSecurityFindingId(fingerprint: string): string {
	return `secf_${Bun.SHA256.hash(fingerprint, "hex").slice(0, 24)}`;
}

export function createSecurityOccurrenceId(fingerprint: string, locations: readonly SecurityLocation[]): string {
	const material = canonicalSecurityJson({ fingerprint, locations: normalizedLocations(locations) });
	return `seco_${Bun.SHA256.hash(material, "hex").slice(0, 24)}`;
}

export function createSecurityEvidenceId(fingerprint: string, label: string, ordinal: number): string {
	return `sece_${Bun.SHA256.hash(canonicalSecurityJson({ fingerprint, label, ordinal }), "hex").slice(0, 24)}`;
}

export function createSecurityScanId(randomUuid: () => string = () => Bun.randomUUIDv7()): string {
	return `secscan_${randomUuid().replaceAll("-", "")}`;
}

export function createSecurityPlanId(fingerprint: string): string {
	return `secplan_${Bun.SHA256.hash(fingerprint, "hex").slice(0, 24)}`;
}

export function encodeSecurityProjectKey(repositoryRoot: string): string {
	const normalized = repositoryRoot.replaceAll("\\", "/").replace(/\/$/, "");
	const readable = normalized
		.replace(/^\//, "")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(-80);
	return `${readable || "project"}-${Bun.SHA256.hash(normalized, "hex").slice(0, 12)}`;
}
