import * as fs from "node:fs/promises";
import * as path from "node:path";

/** The complete, serializable representation of a team task. */
export interface TeamTask {
	id: string;
	title: string;
	owner: string | null;
	status: "open" | "done";
	note: string;
}

export type TeamClaimResult =
	| { kind: "claimed"; owner: string }
	| { kind: "already-owned"; owner: string }
	| { kind: "conflict"; owner: string };

// This registry belongs to the main process, not to a team or a ledger instance.
const locks = new Map<string, Promise<void>>();

async function locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous = locks.get(key);
	const release = Promise.withResolvers<void>();
	const current = release.promise;
	locks.set(key, current);
	try {
		if (previous) await previous;
		return await operation();
	} finally {
		if (locks.get(key) === current) locks.delete(key);
		release.resolve();
	}
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function validate(tasks: unknown): TeamTask[] {
	if (!Array.isArray(tasks)) throw new Error("Invalid team task ledger: expected an array");
	const ids = new Set<string>();
	for (const task of tasks) {
		if (
			typeof task !== "object" ||
			task === null ||
			Array.isArray(task) ||
			typeof task.id !== "string" ||
			!/^[1-9][0-9]*$/.test(task.id) ||
			ids.has(task.id) ||
			typeof task.title !== "string" ||
			!task.title.trim() ||
			(task.owner !== null && (typeof task.owner !== "string" || !task.owner.trim())) ||
			(task.status !== "open" && task.status !== "done") ||
			typeof task.note !== "string"
		)
			throw new Error("Invalid team task ledger: malformed or duplicate task");
		ids.add(task.id);
	}
	return tasks as TeamTask[];
}

function requireText(value: string, name: string): void {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
}

function copy(tasks: TeamTask[]): TeamTask[] {
	return tasks.map(task => ({ ...task }));
}

function render(tasks: TeamTask[]): string {
	const lines = ["# Team Tasks", ""];
	for (const task of tasks) {
		lines.push(`- [${task.status === "done" ? "x" : " "}] ${task.id}: ${task.title}`);
		lines.push(`  - Owner: ${task.owner ?? "unassigned"}`);
		if (task.note) lines.push(`  - Note: ${task.note}`);
	}
	return `${lines.join("\n")}\n`;
}

async function replace(file: string, contents: string): Promise<void> {
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
	try {
		await fs.writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
		await fs.rename(temporary, file);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

/**
 * One instance per team generation. The runtime must authenticate callers and
 * resolve membership before passing caller IDs and lead authority to this API.
 * Workspace instances share the same canonical, process-wide lock and ledger.
 */
export class TeamLedger {
	#workspace: string | undefined;
	#memory: TeamTask[] | undefined;
	#memoryKey = `memory:${crypto.randomUUID()}`;

	constructor(workspace?: string) {
		this.#workspace = workspace;
	}

	async #withLedger<T>(operation: (file: string | undefined) => Promise<T>, authorize?: () => void): Promise<T> {
		const execute = (file: string | undefined) => {
			authorize?.();
			return operation(file);
		};
		if (this.#workspace === undefined) return locked(this.#memoryKey, () => execute(undefined));
		await fs.mkdir(this.#workspace, { recursive: true });
		const directory = await fs.realpath(this.#workspace);
		const file = path.join(directory, "tasks.json");
		const key = process.platform === "win32" ? file.toLowerCase() : file;
		return locked(key, () => execute(file));
	}

	async barrier(): Promise<void> {
		await this.#withLedger(async () => {});
	}

	async #load(file: string | undefined): Promise<TeamTask[]> {
		if (file === undefined) {
			if (this.#memory === undefined) throw new Error("Team task ledger is not initialized");
			return copy(this.#memory);
		}
		const text = await fs.readFile(file, "utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error(`Invalid team task ledger JSON: ${file}`);
		}
		return validate(parsed);
	}

	async #view(file: string | undefined, tasks: TeamTask[]): Promise<void> {
		if (file !== undefined) await replace(path.join(path.dirname(file), "TASKS.md"), render(tasks));
	}

	async #commit(file: string | undefined, tasks: TeamTask[]): Promise<void> {
		if (file === undefined) {
			this.#memory = copy(tasks);
		} else {
			await replace(file, `${JSON.stringify(tasks, null, 2)}\n`);
			await this.#view(file, tasks);
		}
	}

	async initialize(titles: readonly string[] = []): Promise<TeamTask[]> {
		return this.#withLedger(async file => {
			let tasks: TeamTask[];
			try {
				tasks = await this.#load(file);
			} catch (error) {
				if (file === undefined ? this.#memory !== undefined : !isMissing(error)) throw error;
				if (file !== undefined) {
					const view = path.join(path.dirname(file), "TASKS.md");
					try {
						await fs.lstat(view);
						throw new Error(
							`Cannot initialize team ledger: ${view} exists without tasks.json; migrate the existing tasks before starting`,
						);
					} catch (viewError) {
						if (!isMissing(viewError)) throw viewError;
					}
				}
				for (const title of titles) requireText(title, "Task title");
				tasks = titles.map((title, index) => ({
					id: String(index + 1),
					title,
					owner: null,
					status: "open",
					note: "",
				}));
				await this.#commit(file, tasks);
				return copy(tasks);
			}
			await this.#view(file, tasks);
			return copy(tasks);
		});
	}

	async read(authorize?: () => void): Promise<TeamTask[]> {
		return this.#withLedger(async file => {
			const tasks = await this.#load(file);
			await this.#view(file, tasks);
			return copy(tasks);
		}, authorize);
	}

	async add(title: string, isLead: boolean, authorize?: () => void): Promise<TeamTask> {
		if (!isLead) throw new Error("Only the team lead can add tasks");
		requireText(title, "Task title");
		return this.#withLedger(async file => {
			const tasks = await this.#load(file);
			const used = new Set(tasks.map(task => task.id));
			let id = 1;
			while (used.has(String(id))) id++;
			const task: TeamTask = { id: String(id), title, owner: null, status: "open", note: "" };
			tasks.push(task);
			await this.#commit(file, tasks);
			return { ...task };
		}, authorize);
	}

	async claim(id: string, caller: string, authorize?: () => void): Promise<TeamClaimResult> {
		requireText(caller, "Caller");
		return this.#withLedger(async file => {
			const tasks = await this.#load(file);
			const task = this.#task(tasks, id);
			if (task.status === "done") throw new Error(`Task ${id} is done; release it before claiming`);
			if (task.owner !== null) {
				await this.#view(file, tasks);
				return { kind: task.owner === caller ? "already-owned" : "conflict", owner: task.owner };
			}
			task.owner = caller;
			await this.#commit(file, tasks);
			return { kind: "claimed", owner: caller };
		}, authorize);
	}

	async release(id: string, caller: string, isLead: boolean, authorize?: () => void): Promise<TeamTask> {
		requireText(caller, "Caller");
		return this.#withLedger(async file => {
			const tasks = await this.#load(file);
			const task = this.#task(tasks, id);
			this.#authorize(task, caller, isLead);
			task.owner = null;
			task.status = "open";
			task.note = "";
			await this.#commit(file, tasks);
			return { ...task };
		}, authorize);
	}

	async done(id: string, caller: string, isLead: boolean, note: string, authorize?: () => void): Promise<TeamTask> {
		requireText(caller, "Caller");
		if (typeof note !== "string") throw new Error("Task note must be a string");
		return this.#withLedger(async file => {
			const tasks = await this.#load(file);
			const task = this.#task(tasks, id);
			this.#authorize(task, caller, isLead);
			task.status = "done";
			task.note = note;
			await this.#commit(file, tasks);
			return { ...task };
		}, authorize);
	}

	#task(tasks: TeamTask[], id: string): TeamTask {
		const task = tasks.find(item => item.id === id);
		if (!task) throw new Error(`Unknown team task: ${id}`);
		return task;
	}

	#authorize(task: TeamTask, caller: string, isLead: boolean): void {
		if (!isLead && task.owner !== caller) throw new Error("Only the task owner or team lead may change this task");
	}
}
