/**
 * Bun preload script that traces module resolution.
 * Usage: bun --preload ./scripts/trace-loader.ts <script>
 */

const startTime = Bun.nanoseconds();
const resolved = new Set<string>();

Bun.plugin({
	name: "trace-loader",
	setup(build) {
		// Trace module resolution (doesn't interfere with loading)
		build.onResolve({ filter: /.*/ }, args => {
			// Skip if already traced this path
			if (resolved.has(args.path)) {
				return undefined;
			}
			resolved.add(args.path);

			const elapsed = ((Bun.nanoseconds() - startTime) / 1e6).toFixed(1);
			// Only trace local/project files, not node_modules
			if (!args.path.includes("node_modules") && !args.path.startsWith("node:")) {
				const shortPath = args.path.replace(process.cwd(), ".");
				process.stderr.write(`[${elapsed}ms] resolve: ${shortPath}\n`);
			}

			// Return undefined to let Bun handle resolution normally
			return undefined;
		});
	},
});

process.stderr.write(`[trace-loader] preload active\n`);
