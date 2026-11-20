/** Shared setup of the upstream tests: specs for fixture processes and a `spawn` that records pids. */
import * as path from "node:path";
import { spawnManagedChild } from "@oh-my-pi/pi-coding-agent/daemon/children";
import type { ChildSpawn, ManagedChild } from "@oh-my-pi/pi-coding-agent/daemon/module";
import type { McpRemoteSpec, McpStdioSpec } from "@oh-my-pi/pi-coding-agent/mcp/host/contract";
import type { McpPeerDeps, McpRoot } from "@oh-my-pi/pi-coding-agent/mcp/host/peer";

export const FIXTURES = path.resolve(import.meta.dir, "../fixtures");
export const ROOTS: McpRoot[] = [{ uri: "file:///work/project", name: "project" }];

function inheritedEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name in process.env) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
}

/** Spec running `script` with bun, with `env` declared on top of this process's environment. */
export function stdioSpec(script: string, args: string[] = [], env: Record<string, string> = {}): McpStdioSpec {
	return {
		transport: "stdio",
		command: process.execPath,
		args: [script, ...args],
		cwd: FIXTURES,
		env,
		spawnEnv: { ...inheritedEnv(), ...env },
		timeoutMs: 10_000,
	};
}

export function httpSpec(url: string, headers: Record<string, string> = {}): McpRemoteSpec {
	return { transport: "http", url, headers, timeoutMs: 10_000 };
}

/** Peer deps over real child processes; `pids` lists every process spawned through them. */
export function realDeps(): McpPeerDeps & { pids: number[] } {
	const pids: number[] = [];
	return {
		pids,
		spawn(spec: ChildSpawn): ManagedChild {
			const child = spawnManagedChild(spec);
			pids.push(child.pid);
			return child;
		},
		roots: () => ROOTS,
	};
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The JSON a fixture tool returned as its single text content. */
export function toolJson(result: Record<string, unknown>): unknown {
	const content = result.content;
	const first: unknown = Array.isArray(content) ? content[0] : undefined;
	if (typeof first !== "object" || first === null || !("text" in first) || typeof first.text !== "string") {
		throw new Error(`not a text tool result: ${JSON.stringify(result)}`);
	}
	return JSON.parse(first.text);
}
