/**
 * Every place in this repository that can create a model request says who owns it. The rules, and
 * the walk that enforces them, are in `helpers/model-request-ownership.ts`; its own self-test,
 * `model-request-ownership-selftest.test.ts`, shows it rejects each form of an unowned request.
 *
 * To add a request that outlives disposal, write `// model-request: outlives-disposal — <why>` above
 * the line that creates it. A site with no declaration fails here, with its location.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { checkModelRequestOwnership } from "./helpers/model-request-ownership";

describe("model request ownership", () => {
	it("every site that can create a model request declares who owns it", async () => {
		const report = await checkModelRequestOwnership(path.join(import.meta.dir, "../.."));

		const byOwner = new Map<string, number>();
		for (const site of report.sites) byOwner.set(site.owner ?? "?", (byOwner.get(site.owner ?? "?") ?? 0) + 1);
		console.log(
			`${report.sites.length} model-request sites in ${report.packageCount} packages: ${[...byOwner].map(([owner, count]) => `${owner} ${count}`).join(", ")}`,
		);
		if (report.problems.length > 0) {
			const listing = report.sites
				.map(site => `${site.owner ?? "?"}\t${site.file}:${site.line}\t${site.use} ${site.name}`)
				.sort()
				.join("\n");
			console.log(`Model request sites:\n${listing}`);
		}
		expect(report.problems).toEqual([]);
		// The walk found the primitives; an empty inventory would pass vacuously.
		expect(report.sites.length).toBeGreaterThan(300);
		// Parsing every source file of every walked package takes seconds.
	}, 300_000);
});
