/**
 * Command routing through the update gate: mobile-capitalized command names,
 * commands that name another bot in a forum group, `/new` directory resolution
 * and same-named inbox attachments.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { bridgeHarness, fakeSession, message, update, type BridgeHarness } from "./host-fixtures";

const live: BridgeHarness[] = [];

function harness(): BridgeHarness {
	const made = bridgeHarness();
	live.push(made);
	return made;
}

afterEach(async () => {
	for (const made of live.splice(0)) {
		await made.host.stop();
		made.cleanup();
	}
});

/** Seeds a topic through `/new` with a session whose calls the test inspects. */
async function seed(h: BridgeHarness, name = "Fox"): Promise<void> {
	h.queue(fakeSession({ name }));
	await h.host.handleUpdate(update({ message: message({ text: `/new ${name}` }) }));
}

describe("command names", () => {
	it("stops on a capitalized /Stop instead of passing it to the session", async () => {
		const h = harness();
		await seed(h);
		h.sessions[0].calls.length = 0;
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "/Stop" }) }))).toBe("stop");
		expect(h.sessions[0].calls.filter(call => call.method === "abort")).toHaveLength(1);
		expect(h.sessions[0].calls.filter(call => call.method === "prompt")).toHaveLength(0);
	});
});

describe("commands addressed to another bot", () => {
	it("ignores /close@otherbot in a forum group", async () => {
		const h = harness();
		await seed(h);
		const spoken = h.api.threadTexts(900).length;
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "/close@otherbot" }) }))).toBe(
			"other_bot",
		);
		expect(h.api.of("closeForumTopic")).toHaveLength(0);
		expect(h.api.threadTexts(900)).toHaveLength(spoken);
		expect(h.readRegistry()[0].status).not.toBe("closed");
	});

	it("runs /close@omp_bridge, this bot's own command", async () => {
		const h = harness();
		await seed(h);
		expect(
			await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "/close@omp_bridge" }) })),
		).toBe("close");
		expect(h.readRegistry()[0].status).toBe("closed");
		expect(h.sessions[0].calls.some(call => call.method === "dispose")).toBe(true);
	});

	it("treats a suffixed command as another bot's while this bot's name is unknown", async () => {
		const h = harness();
		h.botUsername = null;
		h.restart();
		await seed(h);
		expect(
			await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "/close@omp_bridge" }) })),
		).toBe("other_bot");
		expect(h.readRegistry()[0].status).not.toBe("closed");
	});
});

describe("/new directories", () => {
	it("resolves a relative directory against the configured working directory", async () => {
		const h = harness();
		expect(await h.host.handleUpdate(update({ message: message({ text: "/new api src" }) }))).toBe("created");
		expect(h.requests[0].cwd).toBe("/work/src");
		expect(h.readRegistry()[0].cwd).toBe("/work/src");
	});

	it("keeps an absolute home-relative directory absolute", async () => {
		const h = harness();
		await h.host.handleUpdate(update({ message: message({ text: "/new docs ~/tree" }) }));
		expect(h.requests[0].cwd).toBe("/home/dev/tree");
	});
});

describe("inbox attachments", () => {
	it("keeps two same-named documents apart", async () => {
		const h = harness();
		await seed(h);
		await h.host.handleUpdate(
			update({
				message: message({
					threadId: 900,
					messageId: 41,
					extra: { document: { file_id: "d1", file_unique_id: "u1", file_name: "log.txt" } },
				}),
			}),
		);
		await h.host.handleUpdate(
			update({
				message: message({
					threadId: 900,
					messageId: 42,
					extra: { document: { file_id: "d2", file_unique_id: "u2", file_name: "log.txt" } },
				}),
			}),
		);
		const prompts = h.sessions[0].calls.filter(call => call.method === "prompt").map(call => String(call.text));
		expect(prompts).toEqual([
			`file: ${h.dir}/state/inbox/900/41-log.txt`,
			`file: ${h.dir}/state/inbox/900/42-log.txt`,
		]);
		expect(fs.readdirSync(path.join(h.dir, "state", "inbox", "900")).sort()).toEqual(["41-log.txt", "42-log.txt"]);
	});
});
