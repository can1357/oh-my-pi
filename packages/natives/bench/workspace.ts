import { listWorkspace } from "../native";

const root = Bun.argv[2];
if (!root) throw new Error("Usage: bun bench/workspace.ts DIRECTORY");
for (let iteration = 0; iteration < 5; iteration++) {
	const started = performance.now();
	const result = await listWorkspace({ path: root, maxDepth: 5, hidden: true, collectAgentsMd: true });
	console.log(
		JSON.stringify({
			iteration,
			elapsedMs: performance.now() - started,
			entries: result.entries.length,
			first: result.entries[0]?.path,
			last: result.entries.at(-1)?.path,
			agentsMdFiles: result.agentsMdFiles,
			truncated: result.truncated,
		}),
	);
}
