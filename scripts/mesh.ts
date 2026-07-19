#!/usr/bin/env bun
/**
 * mesh — client-side CLI for the Tailscale mesh + Colab.
 *
 * Subcommands:
 *   mesh status                        # print reachability table
 *   mesh run --node <name> [--session <s>] -- <cmd> [args...]
 *   mesh warmup                        # spin up a new colab session
 *   mesh kill-all                      # stop every active colab session
 *   mesh init                          # write the default ~/.config/mesh/nodes.json
 *   mesh                               # interactive menu
 *
 * Node topology is read from ~/.config/mesh/nodes.json (created by `mesh init`).
 * Run `mesh init` to seed it; see scripts/lib/ssh-exec.ts for the SSH argv shape.
 */

import * as os from "node:os";
import * as path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { isEnoent } from "@pk-nerdsaver-ai/pi-utils";
import { direct, type ExecResult, sshArgv } from "./lib/ssh-exec";

type NodeKind = "local" | "ssh" | "colab";
interface MeshNode {
	kind: NodeKind;
	host?: string;
	user?: string;
}
type NodeMap = Record<string, MeshNode>;

const NODES_PATH = path.join(os.homedir(), ".config", "mesh", "nodes.json");

async function loadNodes(): Promise<NodeMap> {
	try {
		return (await Bun.file(NODES_PATH).json()) as NodeMap;
	} catch (err) {
		if (isEnoent(err)) {
			throw new Error(`no mesh config at ${NODES_PATH} — run \`mesh init\` first`);
		}
		throw err;
	}
}

function usage(): string {
	return `usage:
  mesh status
  mesh run --node <name> [--session <s>] -- <cmd> [args...]
  mesh warmup
  mesh kill-all
  mesh init`;
}
function pad(s: string, n: number): string {
	return s.length >= n ? s : s + " ".repeat(n - s.length);
}
// Detect the Windows-only "fcntl missing" error that the colab CLI surfaces
// on every subcommand. Used to print a useful fallback hint instead of a
// raw traceback.
function colabUnsupported(r: ExecResult): boolean {
	return /No module named 'fcntl'/i.test(r.stderr) || /fcntl/i.test(r.stderr);
}

async function probeLocal(): Promise<string> {
	return "self";
}

async function probeSsh(n: MeshNode): Promise<string> {
	const r = await direct([...sshArgv({ connectTimeout: 5 }), `${n.user}@${n.host}`, "echo ok"]);
	if (r.code === 0 && r.stdout.includes("ok")) return "online";
	return "OFFLINE";
}

async function probeColab(): Promise<string> {
	const r = await direct(["colab", "sessions"]);
	if (r.code === 0) {
		// Heuristic: count non-blank, non-header lines.
		const lines = r.stdout
			.split("\n")
			.map(l => l.trim())
			.filter(Boolean);
		return `online (${Math.max(0, lines.length - 1)} sessions)`;
	}
	if (colabUnsupported(r)) return "OFFLINE (cli unsupported on Windows)";
	return "OFFLINE";
}

async function status(): Promise<void> {
	const nodes = await loadNodes();
	const entries = Object.entries(nodes);
	const rows: [string, string, string, string][] = await Promise.all(
		entries.map(async ([name, n]) => {
			let kind = n.kind;
			let target = "—";
			let state: string;
			if (n.kind === "local") {
				target = "msi-1";
				state = await probeLocal();
			} else if (n.kind === "ssh") {
				target = `${n.user}@${n.host}`;
				state = await probeSsh(n);
			} else {
				target = "colab.exe";
				state = await probeColab();
				kind = "colab";
			}
			return [name, kind, target, state];
		}),
	);
	const widths = [0, 0, 0, 0];
	for (const r of rows) for (let i = 0; i < 4; i++) widths[i] = Math.max(widths[i], r[i].length);
	const header = ["NODE", "KIND", "TARGET", "STATE"].map((h, i) => pad(h, widths[i])).join("  ");
	console.log(header);
	console.log("-".repeat(header.length));
	for (const r of rows) console.log(r.map((c, i) => pad(c, widths[i])).join("  "));
}

interface RunOptions {
	node: string;
	session?: string;
	cmd: string[];
}

function parseRunArgs(rest: string[]): RunOptions {
	if (rest.length === 0) throw new Error(usage());
	let node: string | undefined;
	let session: string | undefined;
	const sepIdx = rest.indexOf("--");
	if (sepIdx === -1) throw new Error("missing -- before command");
	const flags = rest.slice(0, sepIdx);
	const cmd = rest.slice(sepIdx + 1);
	if (cmd.length === 0) throw new Error("missing command after --");
	for (let i = 0; i < flags.length; i++) {
		const f = flags[i];
		if (f === "--node") {
			node = flags[++i];
		} else if (f === "--session") {
			session = flags[++i];
		} else {
			throw new Error(`unknown flag: ${f}`);
		}
	}
	if (!node) throw new Error("missing --node <name>");
	return { node, session, cmd };
}

async function run(rest: string[]): Promise<number> {
	const opts = parseRunArgs(rest);
	const nodes = await loadNodes();
	const n = nodes[opts.node];
	if (!n) {
		const valid = Object.keys(nodes).join(", ");
		throw new Error(`unknown node ${opts.node}; valid: ${valid}`);
	}
	if (n.kind === "local") {
		const r = await direct(["bash", "-c", opts.cmd.join(" ")]);
		if (r.stdout) process.stdout.write(r.stdout);
		if (r.stderr) process.stderr.write(r.stderr);
		return r.code;
	}
	if (n.kind === "ssh") {
		const proc = Bun.spawn({
			cmd: [...sshArgv(), `${n.user}@${n.host}`, ...opts.cmd],
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		return await proc.exited;
	}
	// colab
	const proc = Bun.spawn({
		cmd: ["colab", "exec", ...(opts.session ? ["--session", opts.session] : []), "--", ...opts.cmd],
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return await proc.exited;
}

async function warmup(): Promise<number> {
	const proc = Bun.spawn({
		cmd: ["colab", "new"],
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await proc.exited;
	if (code !== 0) {
		console.error("hint: colab CLI requires Linux/macOS or WSL on Windows; see mesh-orchestrator skill");
	}
	return code;
}

async function killAll(): Promise<number> {
	const r = await direct(["colab", "sessions"]);
	if (r.code !== 0) {
		if (colabUnsupported(r)) {
			console.error("colab CLI is unsupported on native Windows; run `mesh kill-all` from WSL (wsl is installed)");
			return 1;
		}
		console.error(`colab sessions failed: ${r.stderr}`);
		return r.code;
	}
	// Heuristic parse: every non-blank line after the header is a session ID/name.
	// The exact format is build-time-confirmed; we just stop the first whitespace-
	// separated token of each non-header line.
	const lines = r.stdout
		.split("\n")
		.map(l => l.trim())
		.filter(Boolean);
	if (lines.length <= 1) {
		console.log("no active colab sessions");
		return 0;
	}
	const ids = lines
		.slice(1)
		.map(l => l.split(/\s+/)[0])
		.filter(Boolean);
	let stopped = 0;
	for (const id of ids) {
		const sr = await direct(["colab", "stop", id]);
		if (sr.code === 0) stopped++;
	}
	console.log(`stopped ${stopped}/${ids.length} colab session(s)`);
	return 0;
}

async function init(): Promise<void> {
	const dir = path.dirname(NODES_PATH);
	await Bun.$`mkdir -p ${dir}`.quiet().nothrow();
	const exists = await Bun.file(NODES_PATH).exists();
	if (exists) {
		console.log(`config already exists at ${NODES_PATH}`);
		return;
	}
	const seed: NodeMap = {
		"msi-1": { kind: "local" },
		mac: { kind: "ssh", host: "100.109.244.1", user: "jimpizouw" },
		pi: { kind: "ssh", host: "100.111.69.99", user: "pk" },
		hetzner: { kind: "ssh", host: "100.64.216.11", user: "root" },
		"cloudpk1": { kind: "ssh", host: "100.87.107.97", user: "prest" },
		colab: { kind: "colab" },
	};
	await Bun.write(NODES_PATH, `${JSON.stringify(seed, null, 2)}\n`);
	console.log(`wrote ${NODES_PATH}`);
}

async function interactiveMenu(): Promise<void> {
	const rl = readline.createInterface({ input, output });
	const nodes = await loadNodes();
	const nodeNames = Object.keys(nodes);
	const MENU = `mesh — select an action:
  1) status
  2) run on node
  3) warmup colab
  4) kill all colab
  5) quit`;
	try {
		while (true) {
			console.log(MENU);
			const ans = (await rl.question("> ")).trim();
			if (ans === "1") {
				await status();
			} else if (ans === "2") {
				console.log(`nodes: ${nodeNames.join(", ")}`);
				const node = (await rl.question("node: ")).trim();
				if (!nodes[node]) {
					console.error(`unknown node ${node}`);
					continue;
				}
				const cmdLine = (await rl.question("command: ")).trim();
				if (!cmdLine) {
					console.error("empty command");
					continue;
				}
				const cmd = cmdLine.split(/\s+/);
				const code = await run(["--node", node, "--", ...cmd]);
				if (code !== 0) console.error(`(exit ${code})`);
			} else if (ans === "3") {
				await warmup();
			} else if (ans === "4") {
				await killAll();
			} else if (ans === "5" || ans === "") {
				break;
			} else {
				console.error("unknown selection");
			}
		}
	} finally {
		rl.close();
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.length === 0) {
		await interactiveMenu();
		return;
	}
	const sub = argv[0];
	const rest = argv.slice(1);
	switch (sub) {
		case "status":
			await status();
			break;
		case "run":
			process.exit(await run(rest));
			break;
		case "warmup":
			process.exit(await warmup());
			break;
		case "kill-all":
			process.exit(await killAll());
			break;
		case "init":
			await init();
			break;
		case "-h":
		case "--help":
		case "help":
			console.log(usage());
			break;
		default:
			throw new Error(`unknown subcommand: ${sub}\n${usage()}`);
	}
}

main().catch((err: unknown) => {
	console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
