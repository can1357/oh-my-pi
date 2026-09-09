/**
 * CPU and heap profiling wrappers for debug reports.
 */

export interface CpuProfile {
	data: string;
	markdown: string;
}

export interface ProfilerSession {
	/** Stop profiling and return the profile data */
	stop(): Promise<CpuProfile>;
}

/** V8 CPU Profile node structure */
interface CpuProfileNode {
	id: number;
	callFrame?: {
		functionName?: string;
		url?: string;
		lineNumber?: number;
	};
	hitCount?: number;
	children?: number[];
}

/** V8 CPU Profile structure */
interface CpuProfileData {
	nodes?: CpuProfileNode[];
	samples?: number[];
	timeDeltas?: number[];
	startTime?: number;
	endTime?: number;
}

/**
 * Format CPU profile data as markdown for LLM analysis.
 * Extracts top functions by self time and call counts.
 */
function formatProfileAsMarkdown(profileJson: string): string {
	try {
		const profile = JSON.parse(profileJson) as CpuProfileData;
		const nodes = profile.nodes ?? [];

		interface NodeInfo {
			id: number;
			functionName: string;
			url: string;
			lineNumber: number;
			selfTime: number;
			hitCount: number;
		}

		const nodeMap = new Map<number, NodeInfo>();
		for (const node of nodes) {
			nodeMap.set(node.id, {
				id: node.id,
				functionName: node.callFrame?.functionName ?? "(anonymous)",
				url: node.callFrame?.url ?? "",
				lineNumber: node.callFrame?.lineNumber ?? 0,
				selfTime: 0,
				hitCount: node.hitCount ?? 0,
			});
		}

		// Distribute sample times to nodes
		const samples = profile.samples ?? [];
		const timeDeltas = profile.timeDeltas ?? [];
		for (let i = 0; i < samples.length; i++) {
			const nodeId = samples[i];
			const info = nodeId !== undefined ? nodeMap.get(nodeId) : undefined;
			const delta = timeDeltas[i] ?? 0;
			if (info) {
				info.selfTime += delta;
			}
		}

		// Sort by self time and get top functions
		const sorted = Array.from(nodeMap.values())
			.filter(n => n.selfTime > 0 && n.functionName !== "(root)" && n.functionName !== "(idle)")
			.sort((a, b) => b.selfTime - a.selfTime)
			.slice(0, 30);

		if (sorted.length === 0) {
			return "# CPU Profile Summary\n\nNo significant CPU activity recorded.";
		}

		const totalTime = sorted.reduce((sum, n) => sum + n.selfTime, 0);

		const lines = ["# CPU Profile Summary", ""];
		lines.push(`Total profiled time: ${(totalTime / 1000).toFixed(1)}ms`);
		lines.push("");
		lines.push("## Top Functions by Self Time");
		lines.push("");
		lines.push("| Function | Self Time (ms) | % | Location |");
		lines.push("|----------|----------------|---|----------|");

		for (const node of sorted) {
			const selfMs = (node.selfTime / 1000).toFixed(1);
			const pct = ((node.selfTime / totalTime) * 100).toFixed(1);
			const location = node.url ? `${node.url}:${node.lineNumber}` : "-";
			lines.push(`| ${node.functionName} | ${selfMs} | ${pct}% | ${location} |`);
		}

		return lines.join("\n");
	} catch {
		return "# CPU Profile Summary\n\nFailed to parse profile data.";
	}
}

/**
 * Start CPU profiling.
 * Returns a session that can be stopped to get the profile data.
 */
export async function startCpuProfile(): Promise<ProfilerSession> {
	const v8 = await import("node:v8");
	try {
		// Enables `%GetOptimizationStatus` and friends when V8 natives are needed
		// for ad-hoc profiling. Best-effort: Bun does not implement
		// `setFlagsFromString` (oven-sh/bun#1702) but the CPU profiler itself
		// works without it, so swallow the error and continue.
		v8.setFlagsFromString("--allow-natives-syntax");
	} catch {}

	const { Session } = await import("node:inspector/promises");
	const session = new Session();
	session.connect();

	await session.post("Profiler.enable");
	// Default CDP interval is 1ms, which mis-attributes await-resumption samples
	// to the line after `await` (one sparse sample inherits the entire wait). 100µs
	// scatters samples enough to keep CPU vs. async-wait attribution honest.
	await session.post("Profiler.setSamplingInterval", { interval: 100 });
	await session.post("Profiler.start");

	return {
		async stop(): Promise<CpuProfile> {
			const result = await session.post("Profiler.stop");
			await session.post("Profiler.disable");
			session.disconnect();

			const data = JSON.stringify(result.profile, null, 2);
			const markdown = formatProfileAsMarkdown(data);

			return { data, markdown };
		},
	};
}

export interface HeapSnapshot {
	data: string;
}

/**
 * Generate a heap snapshot.
 * Uses Bun's built-in generateHeapSnapshot.
 */
export function generateHeapSnapshotData(): HeapSnapshot {
	// Force GC before snapshot
	Bun.gc(true);

	// Use V8 format for Chrome DevTools compatibility
	const snapshot = Bun.generateHeapSnapshot("v8");

	return {
		data: snapshot,
	};
}
