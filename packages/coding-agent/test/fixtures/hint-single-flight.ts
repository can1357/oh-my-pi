/**
 * Child process for the hint single-flight test: creates its ready file, waits
 * for one stdin line (the parent's start barrier), then condenses the same six
 * hints as its sibling under a daemon mutex, appending one line per model
 * request to the calls file. Exits 0 once every hint settled.
 */
import * as fs from "node:fs";
import { closeDaemonClient } from "../../src/daemon/client";
import { daemonMutex } from "../../src/daemon/modules/mutex";
import { RoutingHintCatalog, SkillDescriptionStore } from "../../src/extensibility/skill-descriptions";

const [storePath, callsPath, readyPath] = process.argv.slice(2);
const store = SkillDescriptionStore.open(storePath);
const catalog = new RoutingHintCatalog({
	store,
	compress: {
		modelKey: () => "test/fast",
		async compress(name) {
			fs.appendFileSync(callsPath, `${name}\n`);
			// Stands in for model latency: the sibling asks for the same hint while this request runs.
			await Bun.sleep(150);
			return `Use for ${name}.`;
		},
	},
	lock: job => daemonMutex("single-flight-test").lock(job),
});

fs.writeFileSync(readyPath, "");
for await (const _line of console) break;
catalog.hints(
	Array.from({ length: 6 }, (_, index) => ({
		key: `hint-${index}`,
		name: `hint-${index}`,
		description: `source ${index}`,
		placeholder: "",
		render: () => `request ${index}`,
	})),
);
await catalog.waitForPending();
await store.close();
await closeDaemonClient();
process.exit(0);
