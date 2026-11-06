#!/usr/bin/env bun
/**
 * Test fixture: a stdio "MCP server" that records the spawn and exits before
 * answering anything, so every connect attempt fails and costs exactly one
 * process.
 *
 * Sibling of `crash-after-init-mcp.ts`, which answers the handshake first.
 * This one never does, which is what makes it a counter: the number of lines
 * in `$OMP_TEST_SPAWN_LOG` is the number of connects the manager was willing
 * to make, with no successful connect in between to muddy it.
 */
import * as fs from "node:fs";

const spawnLog = Bun.env.OMP_TEST_SPAWN_LOG;
if (spawnLog) {
	fs.appendFileSync(spawnLog, `${process.pid} ${Date.now()}\n`);
}
process.exit(3);
