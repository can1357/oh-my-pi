export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface ReducibleFinding {
	id: string;
	severity: FindingSeverity;
	title?: string;
	files?: string[];
	duplicateOf?: string;
}

export interface ReducibleCoverage {
	signalsAssigned: number;
	signalsCleared: number;
	signalsConfirmed: number;
}

export interface ReducibleMapOutput {
	coverage: ReducibleCoverage;
	processedSignalIds: readonly string[];
	findings: readonly ReducibleFinding[];
	ledgerValid: boolean;
}

export interface ReducedOutput extends ReducibleMapOutput {
	severity: FindingSeverity;
}

export interface ReducerTreeGroup {
	id: string;
	inputIndexes: number[];
}

export interface ReducerTreeLayer {
	level: number;
	groups: ReducerTreeGroup[];
}

export interface ReducerTreePlan {
	leafCount: number;
	fanIn: number;
	layers: ReducerTreeLayer[];
	depth: number;
	reducerCount: number;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
	info: 0,
	low: 1,
	medium: 2,
	high: 3,
	critical: 4,
};

function normalizeReducerFanIn(fanIn: number, leafCount: number): number {
	if (fanIn === Number.POSITIVE_INFINITY) return Math.max(2, leafCount);
	const floored = Math.floor(fanIn);
	return Number.isFinite(floored) && floored >= 2 ? floored : 2;
}

function normalizeLeafCount(leafCount: number): number {
	const floored = Math.floor(leafCount);
	return Number.isFinite(floored) && floored > 0 ? floored : 0;
}

export function maxSeverity(left: FindingSeverity, right: FindingSeverity): FindingSeverity {
	return SEVERITY_RANK[left] >= SEVERITY_RANK[right] ? left : right;
}
function mergeFindings(key: string, left: ReducibleFinding, right: ReducibleFinding): ReducibleFinding {
	const severity = maxSeverity(left.severity, right.severity);
	const titleCandidates = [left, right]
		.filter(finding => finding.severity === severity && finding.title)
		.map(finding => finding.title as string)
		.sort();
	const files = [...new Set([...(left.files ?? []), ...(right.files ?? [])])].sort();
	return {
		id: key,
		severity,
		...(titleCandidates[0] ? { title: titleCandidates[0] } : {}),
		...(files.length > 0 ? { files } : {}),
		...(left.duplicateOf || right.duplicateOf ? { duplicateOf: key } : {}),
	};
}

export function mergeReducerOutputs(outputs: readonly ReducibleMapOutput[]): ReducedOutput {
	const processedSignalIds = new Set<string>();
	const findings = new Map<string, ReducibleFinding>();
	let coverage: ReducibleCoverage = { signalsAssigned: 0, signalsCleared: 0, signalsConfirmed: 0 };
	let ledgerValid = true;
	let severity: FindingSeverity = "info";

	for (const output of outputs) {
		coverage = {
			signalsAssigned: coverage.signalsAssigned + output.coverage.signalsAssigned,
			signalsCleared: coverage.signalsCleared + output.coverage.signalsCleared,
			signalsConfirmed: coverage.signalsConfirmed + output.coverage.signalsConfirmed,
		};
		for (const signalId of output.processedSignalIds) processedSignalIds.add(signalId);
		for (const finding of output.findings) {
			const key = finding.duplicateOf ?? finding.id;
			const existing = findings.get(key);
			findings.set(key, existing ? mergeFindings(key, existing, finding) : { ...finding, id: key });
			severity = maxSeverity(severity, finding.severity);
		}
		ledgerValid = ledgerValid && output.ledgerValid;
	}

	return {
		coverage,
		processedSignalIds: [...processedSignalIds].sort(),
		findings: [...findings.values()].sort((left, right) => left.id.localeCompare(right.id)),
		ledgerValid,
		severity,
	};
}

export function buildReducerTreePlan(leafCount: number, fanIn: number): ReducerTreePlan {
	const normalizedLeafCount = normalizeLeafCount(leafCount);
	const normalizedFanIn = normalizeReducerFanIn(fanIn, normalizedLeafCount);
	let currentCount = normalizedLeafCount;
	const layers: ReducerTreeLayer[] = [];
	let reducerCount = 0;
	let level = 0;
	while (currentCount > 1) {
		const groups: ReducerTreeGroup[] = [];
		for (let start = 0; start < currentCount; start += normalizedFanIn) {
			const inputIndexes: number[] = [];
			for (let index = start; index < Math.min(start + normalizedFanIn, currentCount); index += 1) {
				inputIndexes.push(index);
			}
			groups.push({ id: `reduce_${level}_${groups.length}`, inputIndexes });
		}
		layers.push({ level, groups });
		reducerCount += groups.length;
		currentCount = groups.length;
		level += 1;
	}
	return {
		leafCount: normalizedLeafCount,
		fanIn: normalizedFanIn,
		layers,
		depth: layers.length,
		reducerCount,
	};
}
