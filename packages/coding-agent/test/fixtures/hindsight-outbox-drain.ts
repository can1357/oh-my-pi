import { HindsightApi } from "../../src/hindsight/client";
import { HindsightOutbox } from "../../src/hindsight/outbox";

const [agentDir, apiUrl] = process.argv.slice(2);
if (!agentDir || !apiUrl) throw new Error("Expected isolated agent directory and loopback API URL");
const client = new HindsightApi({ baseUrl: apiUrl, timeouts: { retain: 1000 } });
const outbox = new HindsightOutbox({
	agentDir,
	apiUrl,
	bankId: "test",
	apiToken: null,
	maxEvents: 1000,
	retainTimeoutMs: 1000,
	client,
	ensureBank: async () => {
		await client.createBank("test");
	},
	notice: () => {},
});
await outbox.drain();
