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
 *
 * Each line also carries the values the spawned process really received for
 * the environment names listed in `$OMP_TEST_SPAWN_ENV_KEYS`, so a test that
 * rewrites a config file can show the rewrite produced the same process
 * rather than asserting it from the file's text.
 */
import * as fs from "node:fs";

const spawnLog = Bun.env.OMP_TEST_SPAWN_LOG;
if (spawnLog) {
	const names = (Bun.env.OMP_TEST_SPAWN_ENV_KEYS ?? "").split(",").filter(Boolean);
	const env = Object.fromEntries(names.map(name => [name, Bun.env[name] ?? null]));
	fs.appendFileSync(spawnLog, `${process.pid} ${Date.now()} ${JSON.stringify(env)}\n`);
}
process.exit(3);
