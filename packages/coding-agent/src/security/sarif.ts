import { pathToFileURL } from "node:url";
import type { SecurityFinding, SecurityScanBundle } from "./contracts";

function sarifLevel(finding: SecurityFinding): "error" | "warning" | "note" | "none" {
	switch (finding.severity.level) {
		case "critical":
		case "high":
			return "error";
		case "medium":
			return "warning";
		case "low":
			return "note";
		default:
			return "none";
	}
}

export function exportSecurityBundleToSarif(bundle: SecurityScanBundle): Record<string, unknown> {
	const rules = new Map<string, SecurityFinding>();
	for (const finding of bundle.findings) {
		if (!rules.has(finding.ruleId)) rules.set(finding.ruleId, finding);
	}
	return {
		$schema: "https://json.schemastore.org/sarif-2.1.0.json",
		version: "2.1.0",
		runs: [
			{
				tool: {
					driver: {
						name: bundle.scan.producer.name,
						version: bundle.scan.producer.version,
						informationUri: "https://omp.sh",
						rules: [...rules.values()].map(finding => ({
							id: finding.ruleId,
							name: finding.ruleId,
							shortDescription: { text: finding.title },
							fullDescription: { text: finding.summary },
							properties: {
								tags: [...finding.taxonomy.cwe, ...(finding.taxonomy.tags ?? [])],
								"security-severity": finding.severity.score,
							},
						})),
					},
				},
				results: bundle.findings.map(finding => ({
					ruleId: finding.ruleId,
					level: sarifLevel(finding),
					message: { text: finding.summary },
					locations: finding.occurrences.flatMap(occurrence =>
						occurrence.locations.map(location => ({
							physicalLocation: {
								artifactLocation: { uri: location.path, uriBaseId: "%SRCROOT%" },
								region: {
									startLine: location.startLine,
									endLine: location.endLine,
									startColumn: location.startColumn,
									endColumn: location.endColumn,
								},
							},
						})),
					),
					fingerprints: { "omp-security/v1": finding.fingerprint },
					properties: {
						findingId: finding.id,
						confidence: finding.confidence.level,
						validation: finding.validation.status,
						disposition: finding.disposition.status,
						category: finding.taxonomy.category,
						"security-severity": finding.severity.score,
					},
				})),
				originalUriBaseIds: {
					"%SRCROOT%": { uri: pathToFileURL(bundle.scan.target.repositoryRoot).href.replace(/\/?$/, "/") },
				},
			},
		],
	};
}
