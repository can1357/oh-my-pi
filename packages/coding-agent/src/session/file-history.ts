import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveFilesnapExecutable } from "../utils/filesnap-executable";

interface Event {
	v: number;
	type: string;
	[key: string]: unknown;
}

export interface FileHistoryPoint {
	turn: string;
	leafId: string | null;
	label: string;
	timestamp: number;
}

interface RecoveryPoint {
	turn: string;
	leafId: string | null;
	policy: string;
}
interface NavigationState {
	atLeaf?: string | null;
	redo: RecoveryPoint[];
	pending?: RecoveryPoint;
}

/** Native file history. Conversation branching remains owned by AgentSession. */
export class FileHistory {
	#turn: string | undefined;
	#queue: Promise<void> = Promise.resolve();
	#statePath: string;
	constructor(
		readonly cwd: string,
		readonly dataDir: string,
		readonly session: string,
		readonly executable?: string,
		readonly defaultEnabled = false,
	) {
		const key = createHash("sha256").update(cwd).update("\0").update(session).digest("hex");
		this.#statePath = path.join(dataDir, "omp-file-history", `${key}.json`);
	}

	async enabled(): Promise<boolean> {
		try {
			const state: unknown = await Bun.file(this.#statePath).json();
			if (!state || typeof state !== "object" || !("enabled" in state) || typeof state.enabled !== "boolean") {
				throw new Error("Invalid file history settings");
			}
			return state.enabled;
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
				return this.defaultEnabled;
			throw error;
		}
	}

	async #run(args: string[], doneType: string, stdin = ""): Promise<Event[]> {
		await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
		const cwd = await fs.realpath(this.cwd);
		const data = await fs.realpath(this.dataDir);
		const rel = path.relative(cwd, data);
		if (!rel || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`))) {
			throw new Error("File history storage must be outside the workspace");
		}
		const command = [await resolveFilesnapExecutable(data, this.executable ?? process.env.FILESNAP_BIN)];
		// No timeout: terminating a restore could interrupt workspace writes.
		const scopeArgs = args[0] === "gc" ? [] : ["--cwd", cwd, "--session", this.session];
		const child = Bun.spawn([...command, "--data-dir", data, ...args, ...scopeArgs], {
			cwd,
			stdin: new TextEncoder().encode(stdin),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (stdout.length > 8 * 1024 * 1024)
			throw new Error("File history response exceeds its limit; inspect recovery before continuing");
		const parsed: unknown[] = Bun.JSONL.parse(stdout);
		const events: Event[] = [];
		for (const value of parsed) {
			if (
				!value ||
				typeof value !== "object" ||
				!("v" in value) ||
				value.v !== 1 ||
				!("type" in value) ||
				typeof value.type !== "string"
			) {
				throw new Error("Unsupported filesnap response");
			}
			events.push(value as Event);
		}
		const done = events.findLast(event => event.type === doneType);
		if (exitCode !== 0 || !done || (typeof done.failed === "number" && done.failed !== 0)) {
			throw new Error(
				`File history operation failed (${exitCode}). ${stderr.slice(-2000)} If restore wrote any files, use /file-history redo to recover.`,
			);
		}
		return events;
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.#queue.then(operation);
		this.#queue = next.then(
			() => {},
			() => {},
		);
		return next;
	}

	async #capture(): Promise<void> {
		const turn = `omp-${randomUUID()}`;
		const events = await this.#run(["capture", "--turn", turn], "capture.done");
		const done = events.findLast(event => event.type === "capture.done");
		if (done?.dropped !== 0)
			throw new Error(
				"File history capture skipped paths; inspect filesnap status or disable file history before continuing",
			);
		this.#turn = turn;
	}

	/** Await before starting each top-level prompt, including edit-free turns. */
	beginTurn(context?: { leafId: string | null; label: string }): Promise<void> {
		return this.#serialize(async () => {
			const state = await this.#navigation();
			if (state.pending) throw new Error("Interrupted rewind. Run /rewind-recover before continuing.");
			if (await this.enabled()) {
				await this.#capture();
				await this.#saveNavigation({ redo: [] });
				if (context) {
					const points = await this.points();
					points.push({ ...context, turn: this.#turn!, timestamp: Date.now() });
					await this.#saveJson(`${this.#statePath}.points`, points);
				}
			}
		});
	}

	async #saveJson(destination: string, value: unknown): Promise<void> {
		await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
		const temporary = `${destination}.${randomUUID()}.tmp`;
		await Bun.write(temporary, JSON.stringify(value), { mode: 0o600 });
		await fs.rename(temporary, destination);
	}

	async points(): Promise<FileHistoryPoint[]> {
		try {
			const value: unknown = await Bun.file(`${this.#statePath}.points`).json();
			if (
				!Array.isArray(value) ||
				!value.every(
					point =>
						point &&
						typeof point === "object" &&
						typeof point.turn === "string" &&
						(point.leafId === null || typeof point.leafId === "string") &&
						typeof point.label === "string" &&
						typeof point.timestamp === "number",
				)
			) {
				throw new Error("Invalid rewind history");
			}
			return value as FileHistoryPoint[];
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
			throw error;
		}
	}

	async #navigation(): Promise<NavigationState> {
		try {
			const state = (await Bun.file(`${this.#statePath}.navigation`).json()) as NavigationState;
			const valid = (point: RecoveryPoint) =>
				point &&
				typeof point.turn === "string" &&
				(point.leafId === null || typeof point.leafId === "string") &&
				typeof point.policy === "string";
			if (
				!state ||
				!Array.isArray(state.redo) ||
				!state.redo.every(valid) ||
				(state.pending && !valid(state.pending))
			)
				throw new Error("Invalid rewind journal");
			return state;
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { redo: [] };
			throw error;
		}
	}

	#saveNavigation(state: NavigationState): Promise<void> {
		return this.#saveJson(`${this.#statePath}.navigation`, state);
	}

	/** Keep the recovery journal until both the disk and host conversation commit. */
	change(
		points: FileHistoryPoint[],
		sourceLeaf: string | null,
		navigate: (leaf: string | null) => Promise<void>,
		confirm: (changes: string[]) => Promise<boolean>,
		recover = false,
	): Promise<boolean> {
		return this.#serialize(async () => {
			const state = await this.#navigation();
			const restore = async (point: RecoveryPoint) => {
				await this.#run(["restore", "--turn", point.turn, "--ignore-rules-stdin"], "restore.done", point.policy);
				await navigate(point.leafId);
			};
			if (recover) {
				if (!state.pending) throw new Error("No interrupted rewind to recover");
				await restore(state.pending);
				delete state.pending;
				await this.#saveNavigation(state);
				return true;
			}
			if (state.pending) throw new Error("Interrupted rewind. Run /rewind-recover first.");
			if (state.atLeaf !== undefined && state.atLeaf !== sourceLeaf) {
				state.redo = [];
				await this.#saveNavigation(state);
			}
			const redo = points.length === 0 ? state.redo.at(-1) : undefined;
			if (!points.length && !redo) throw new Error("Nothing to redo. Redo is cleared when you send a new prompt.");
			const targets = points.length ? points.map(point => point.turn) : [redo!.turn];
			const leaf = points.length ? points.at(-1)!.leafId : redo!.leafId;
			let rescue = `rescue-${randomUUID()}`;
			const prepare = async () =>
				this.#run(
					["prepare", "--turn", rescue, ...targets.flatMap(target => ["--target", target])],
					"prepare.done",
				);
			const preview = await prepare();
			const changes = preview
				.filter(event => event.type === "prepare.change")
				.map(event => `${event.action}: ${event.path}`);
			if (!(await confirm(changes))) return false;
			rescue = `rescue-${randomUUID()}`;
			const verified = await prepare();
			const current = verified
				.filter(event => event.type === "prepare.change")
				.map(event => `${event.action}: ${event.path}`);
			if (JSON.stringify(changes) !== JSON.stringify(current))
				throw new Error("Files changed while confirming. Open /rewind again.");
			const policy = verified.findLast(event => event.type === "prepare.done")?.ignoreRules;
			if (typeof policy !== "string") throw new Error("Missing restore policy");
			const recovery = { turn: rescue, leafId: sourceLeaf, policy };
			state.pending = recovery;
			await this.#saveNavigation(state);
			try {
				for (const target of targets)
					await this.#run(["restore", "--turn", target, "--ignore-rules-stdin"], "restore.done", policy);
				await navigate(leaf);
			} catch (error) {
				try {
					await restore(recovery);
					delete state.pending;
					await this.#saveNavigation(state);
				} catch (recoveryError) {
					throw new Error(
						`Rewind failed: ${error}. Recovery failed: ${recoveryError}. Run /rewind-recover before continuing.`,
					);
				}
				throw error;
			}
			state.atLeaf = leaf;
			if (redo) state.redo.pop();
			else state.redo.push(recovery);
			delete state.pending;
			await this.#saveNavigation(state);
			this.#turn = undefined;
			return true;
		});
	}

	/** The host supplies paths after extension argument rewriting. */
	declare(paths: readonly string[]): Promise<void> {
		return this.#serialize(async () => {
			if (!(await this.enabled())) return;
			if (!this.#turn) await this.#capture();
			for (const target of new Set(paths)) {
				// Virtual/remote resources are not local workspace files.
				if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) continue;
				await this.#run(
					["declare", "--turn", this.#turn!, "--path", path.resolve(this.cwd, target)],
					"declare.done",
				);
			}
		});
	}

	command(text: string): Promise<string> {
		return this.#serialize(async () => {
			const [action = "list", turn, ...extra] = text.trim().split(/\s+/).filter(Boolean);
			if (extra.length || (action !== "restore" && turn) || (action === "restore" && !turn)) {
				throw new Error("Usage: /file-history on|off|list|restore <turn>|redo|clear");
			}
			if (action === "on" || action === "off" || action === "clear") {
				if (action === "on") await this.#capture();
				await fs.mkdir(path.dirname(this.#statePath), { recursive: true, mode: 0o700 });
				const tmp = `${this.#statePath}.${randomUUID()}.tmp`;
				await Bun.write(tmp, JSON.stringify({ enabled: action === "on" }), { mode: 0o600 });
				await fs.rename(tmp, this.#statePath);
				if (action === "clear") {
					await this.#run(["delete"], "delete.done");
					await fs.rm(`${this.#statePath}.recovery`, { force: true });
					await fs.rm(`${this.#statePath}.points`, { force: true });
					await fs.rm(`${this.#statePath}.navigation`, { force: true });
					this.#turn = undefined;
					await this.#run(["gc"], "gc.done");
					return "File history cleared for this session and automatic capture disabled. Workspace files and conversation unchanged.";
				}
				return action === "on"
					? "File history enabled for this session. Captures are bounded; ignored and uncaptured files are not protected."
					: "Automatic file history disabled. Saved checkpoints remain available.";
			}
			if (action === "list") {
				const events = await this.#run(["log", "--limit", "30"], "log.done");
				return (
					events
						.filter(event => event.type === "log.entry")
						.map(event => `${event.turn}  ${event.files} files`)
						.join("\n") || "No file checkpoints in this session. Use /file-history on."
				);
			}
			if (action === "restore" || action === "redo") {
				const target = action === "redo" ? (await Bun.file(`${this.#statePath}.recovery`).text()).trim() : turn;
				// A turn id from another session must not be accepted just because the
				// engine shares its content store across sessions.
				const log = await this.#run(["log"], "log.done");
				if (!log.some(event => event.type === "log.entry" && event.turn === target))
					throw new Error("Checkpoint is not in this session");
				const rescue = `rescue-${randomUUID()}`;
				const preview = await this.#run(["prepare", "--turn", rescue, "--target", target!], "prepare.done");
				const policy = preview.findLast(event => event.type === "prepare.done")?.ignoreRules;
				if (typeof policy !== "string") throw new Error("Recovery preparation omitted its ignore policy");
				await fs.mkdir(path.dirname(this.#statePath), { recursive: true, mode: 0o700 });
				const tmp = `${this.#statePath}.${randomUUID()}.tmp`;
				await Bun.write(tmp, rescue, { mode: 0o600 });
				await fs.rename(tmp, `${this.#statePath}.recovery`);
				await this.#run(["restore", "--turn", target!, "--ignore-rules-stdin"], "restore.done", policy);
				this.#turn = undefined;
				return `Files restored; conversation unchanged. /file-history redo reverses this operation. Recovery checkpoint: ${rescue}`;
			}
			throw new Error("Usage: /file-history on|off|list|restore <turn>|redo|clear");
		});
	}
}
