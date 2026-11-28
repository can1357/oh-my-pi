import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import {
	CURRENT_SESSION_VERSION,
	type SessionHeader,
	type SessionTreeNode,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

/** Entries of the chain: past the 10,000 to 20,000 levels where `JSON.stringify` runs out of stack. */
const ENTRIES = 100_000;
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** Write a session that is one chain of {@link ENTRIES} custom entries, `e0` its root; returns its file. */
async function writeChainSession(dir: string): Promise<string> {
	const file = path.join(dir, "sessions", "chain.jsonl");
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "deep-chain",
		timestamp: TIMESTAMP,
		cwd: dir,
	};
	const lines = [JSON.stringify(header)];
	for (let index = 0; index < ENTRIES; index++) {
		const parentId = index === 0 ? null : `e${index - 1}`;
		lines.push(
			JSON.stringify({
				type: "custom",
				id: `e${index}`,
				parentId,
				timestamp: TIMESTAMP,
				customType: "probe",
				data: { index },
			}),
		);
	}
	await Bun.write(file, `${lines.join("\n")}\n`);
	return file;
}

describe("RPC get_tree", () => {
	let client: RpcClient | undefined;
	let directory: string | undefined;

	afterEach(async () => {
		// Bind this test's resources before awaiting, as the other RPC tests do.
		const ownClient = client;
		const ownDirectory = directory;
		client = undefined;
		directory = undefined;
		await ownClient?.stop();
		if (ownDirectory) await removeWithRetries(ownDirectory);
	});

	// A host that reads the tree of a session longer than about 10,000 entries (a long session can
	// be one chain of tens of thousands) gets `Maximum call stack size exceeded` instead of the tree:
	// `getTree()` nests each entry under its parent, deeper than `JSON.stringify` recurses.
	test("returns the tree of a 100,000-entry chain, which the client reads back whole", async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-tree-"));
		const sessionFile = await writeChainSession(directory);
		client = new RpcClient({
			command: [
				process.execPath,
				path.join(import.meta.dir, "fixtures", "tree-rpc-agent.ts"),
				directory,
				sessionFile,
			],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
		await client.start();

		const { tree, leafId } = await client.getTree();

		expect(leafId).toBe(`e${ENTRIES - 1}`);
		expect(tree).toHaveLength(1);
		// Walked, not compared whole: a recursive comparison of 100,000 levels runs out of stack too.
		const misplaced: string[] = [];
		let node: SessionTreeNode | undefined = tree[0];
		let deepest: SessionTreeNode | undefined;
		let depth = 0;
		while (node) {
			const parentId = depth === 0 ? null : `e${depth - 1}`;
			const { entry } = node;
			if (entry.id !== `e${depth}` || entry.parentId !== parentId || node.children.length > 1) {
				misplaced.push(entry.id);
			}
			deepest = node;
			depth++;
			node = node.children[0];
		}
		expect(misplaced).toEqual([]);
		expect(depth).toBe(ENTRIES);
		expect(deepest?.entry.id).toBe(leafId!);
	}, 120_000);
});
