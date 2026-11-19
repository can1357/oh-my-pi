#!/usr/bin/env bun
/**
 * Test fixture: a stdio MCP server that accepts the connection but never
 * answers `initialize`. Models a remote endpoint that's reachable at the
 * transport layer but unresponsive at the protocol layer (e.g. the
 * `sbox-superdocs` timeout described in issue #2100) — exactly the shape
 * that used to gate `omp` startup on a 30 s per-server MCP timeout.
 *
 * Reads stdin to keep the pipe open and ignores every message. The process
 * stays alive until the parent closes stdin or kills it.
 */
import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => {
	// Intentionally drop every message — server never responds.
});
rl.on("close", () => process.exit(0));
