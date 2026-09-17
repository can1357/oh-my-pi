import * as fs from "node:fs/promises";
import { type } from "arktype";
import { acquireNativeTaskIntegrationLock } from "../../../src/operational/native-task-lock";
import { DurableRunner } from "../../../src/operational/runner";
import { OperationalStore } from "../../../src/operational/store";

const config = type({
	dbPath: "string",
	artifactsDir: "string",
	cwd: "string",
	marker: "string",
	result: "string",
	jobId: "string",
}).assert(JSON.parse(await fs.readFile(process.argv[2]!, "utf8")));
const store = OperationalStore.open({ dbPath: config.dbPath });
const runner = new DurableRunner({
	store,
	executor: async ctx => {
		await fs.writeFile(config.marker, "waiting");
		const release = await acquireNativeTaskIntegrationLock({
			store,
			ctx,
			artifactsDir: config.artifactsDir,
			repoRoot: config.cwd,
		});
		try {
			await fs.writeFile(config.marker, "acquired");
		} finally {
			await release();
		}
		return { acquired: true };
	},
});
try {
	await fs.writeFile(config.result, JSON.stringify(await runner.runJobById(config.jobId)));
} finally {
	runner.dispose();
	store.close();
}
