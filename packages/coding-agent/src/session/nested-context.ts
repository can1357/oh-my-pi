/**
 * On-touch loading of nested context files (`contextFiles.onTouch`).
 *
 * The system prompt carries the context files of cwd and its ancestors. A
 * subdirectory's own AGENTS.md (or CLAUDE.md, …) is only listed there by path.
 * With the setting on, the first successful read/write/edit/ast_edit below
 * such a directory delivers that file as trusted passive context: a developer
 * message after the tool batch, never part of the tool result.
 *
 * Dedupe state is the conversation itself: a file is loaded when it is one of
 * the context files the session's system prompt is built from, or the live
 * context still holds its `<nested-context path="…">` block in a developer
 * message (keyed by absolute path, so a cwd change cannot alias it; tool output
 * is never trusted to carry one) or a full read of it without `@` imports.
 * Compaction that drops the block re-arms the file without bookkeeping.
 * Subagents inherit the parent's loaded files, delivered or fully read, through
 * {@link NestedContextInjector.carried}, which lands them in the child's system
 * prompt and so in its context files.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	ASIDE_MESSAGE_DISCARD,
	type AfterToolCallContext,
	type AgentMessage,
	type AgentToolContext,
	type AgentToolResult,
	type CommittableAsideMessage,
	createAdditionalContextMessage,
} from "@oh-my-pi/pi-agent-core";
import { isRecord, isStrictlyWithinNormalizedRoot, logger, prompt } from "@oh-my-pi/pi-utils";
import { invalidate as invalidateCapabilityCache } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import type { Settings } from "../config/settings";
import { loadCapability } from "../discovery";
import { expandAtImports } from "../discovery/at-imports";
import nestedContextFileTemplate from "../prompts/system/nested-context-file.md" with { type: "text" };
import nestedContextTruncatedTemplate from "../prompts/system/nested-context-truncated.md" with { type: "text" };
import type { ContextFileEntry } from "../tools";
import { cfgContextFilesOnTouch } from "./context-settings";

/** Tools whose successful results count as touching a directory. */
const TRIGGER_TOOLS: Record<string, true> = { read: true, write: true, edit: true, ast_edit: true };
/** Characters of one context file delivered before it is truncated. */
export const NESTED_CONTEXT_FILE_MAX_CHARS = 16_384;
/** Directory names whose context files never load on touch, besides hidden ones. */
const EXCLUDED_SEGMENTS: Record<string, true> = { node_modules: true };
const NOTICE_SOURCE = "context-files";

/**
 * One delivered block. The body capture relies on the template's shape: a
 * single header line and a blank line before the file content.
 */
const BLOCK_RE = /<nested-context path="([^"]+)">\n[^\n]*\n\n([\s\S]*?)\n<\/nested-context>/g;

/** Capabilities the injector borrows from its owning session. */
export interface NestedContextHost {
	settings: Settings;
	/** Session cwd; its context files and its ancestors' are already in the system prompt. */
	cwd(): string;
	/** Additional workspace roots, whose context files are also in the system prompt. */
	additionalDirectories(): readonly string[];
	/**
	 * Absolute paths of the context files the current system prompt was built
	 * from, every workspace root's included. Read structurally, never from the
	 * prompt text, which file bodies can spoof, and never rediscovered, since a
	 * file created after the build is not in the prompt.
	 */
	promptContextFiles(): readonly string[];
	/** The live window, for calls that run outside the agent loop. */
	window(): readonly AgentMessage[];
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
}

interface NestedContextFile {
	/** Absolute path of the context file. */
	path: string;
	/** Directory the file governs, strictly below cwd. */
	owner: string;
	/** The file as stored, before `@` imports expand. */
	raw: string;
	/** The file with `@` imports expanded. */
	content: string;
}

/** One settled call that may touch a nested directory. */
interface Touch {
	toolName: string;
	args: unknown;
	details: unknown;
	/** The batch whose developer message the call's blocks join. */
	batch: BatchState;
	messages: readonly AgentMessage[];
	/** A script's call (eval's `tool.*`): its result stays in the script unless the script prints it. */
	hidden?: boolean;
}

/** A claimed block awaiting delivery. */
interface QueuedBlock {
	path: string;
	block: string;
	/** Path relative to cwd, for the notice. */
	display: string;
	/** Path segments of the owning directory: shallower files are delivered first. */
	depth: number;
	/** Whether a full read of the file shows what the block would: it has no `@` imports. */
	plain: boolean;
}

/**
 * The tool calls of one assistant message, which settle in any order. Blocks
 * queue when claimed, so the queue keeps every file after its ancestors, and
 * the last call to settle hands the whole queue over, so every call has
 * contributed its claims and full reads first.
 */
interface BatchState {
	key: string;
	/** Calls registered through `beforeToolCall`, with the tool each dispatches to. */
	registered: Map<string, string>;
	/** Calls past `beforeToolCall` whose `afterToolCall` has not run. */
	outstanding: Set<string>;
	/** A call has settled, so preflight is over: the next `beforeToolCall` starts another batch. */
	executing: boolean;
	/** Files claimed for delivery. */
	claimed: Set<string>;
	/** Context files a read of this batch showed whole. */
	fullReads: Set<string>;
	queue: QueuedBlock[];
}

/**
 * Prefix of the key of a batch for out-of-loop calls (Cursor exec). Tool-call
 * ids never contain a NUL, so such a key never matches a loop batch's.
 */
const BRIDGED_BATCH_PREFIX = "\0bridged\n";

/** A batch's identity: the tool-call ids of its assistant message. */
function toolCallKey(message: AgentMessage | undefined): string {
	const ids =
		message?.role === "assistant" ? message.content.flatMap(part => (part.type === "toolCall" ? [part.id] : [])) : [];
	return ids.join("\n");
}

/** Delivers subdirectory context files the first time a tool touches their directory. */
export class NestedContextInjector {
	readonly #host: NestedContextHost;
	#batch: BatchState | undefined;
	/** Bridged calls between their preflight and postflight: tool name and final arguments. */
	readonly #bridged = new Map<string, { toolName: string; args: unknown }>();

	constructor(host: NestedContextHost) {
		this.#host = host;
	}

	/**
	 * Registers a loop call that will settle through {@link afterToolCall}. The
	 * loop runs this for every call that passed validation before any executes.
	 * `toolName` is the tool the call dispatches to: a custom-format call keeps
	 * its wire name (`apply_patch` for `edit`) in the message.
	 */
	beforeToolCall(assistantMessage: AgentMessage, toolCallId: string, toolName: string): void {
		if (!cfgContextFilesOnTouch.get(this.#host.settings)) return;
		let batch = this.#batchFor(assistantMessage);
		// Some providers rebuild ids from position, so a later run can repeat a
		// settled batch's key with a different subset of valid calls. Preflight
		// runs for the whole message before any call executes, so one after a
		// call settled, or an id registering twice, means a new batch.
		if (batch.executing || batch.registered.has(toolCallId)) batch = this.#newBatch(batch.key);
		batch.registered.set(toolCallId, toolName);
		batch.outstanding.add(toolCallId);
	}

	/**
	 * Passive context for a settled tool call: the batch's queued blocks, once no
	 * other call is outstanding. Returns undefined synchronously when the call
	 * cannot touch a nested directory and has nothing to hand over, so most calls
	 * never await.
	 */
	afterToolCall(ctx: AfterToolCallContext): Promise<string | undefined> | undefined {
		if (!cfgContextFilesOnTouch.get(this.#host.settings)) return undefined;
		const batch = this.#batchFor(ctx.assistantMessage);
		const id = ctx.toolCall.id;
		const own = ctx.isError
			? undefined
			: this.#touch({
					toolName: batch.registered.get(id) ?? ctx.toolCall.name,
					args: ctx.args,
					details: ctx.result.details,
					batch,
					messages: ctx.context.messages,
				});
		if (own) return own.then(() => this.#settle(batch, id));
		const text = this.#settle(batch, id);
		return text === undefined ? undefined : Promise.resolve(text);
	}

	/** Records a call issued outside the agent loop (eval's `tool.*`, Cursor exec) once its arguments are final. */
	beforeBridgedToolCall(toolCallId: string, toolName: string, args: unknown): void {
		if (!cfgContextFilesOnTouch.get(this.#host.settings) || TRIGGER_TOOLS[toolName] !== true) return;
		this.#bridged.set(toolCallId, { toolName, args });
	}

	/**
	 * Loads context for a settled bridged call. Inside a running batch (eval's
	 * `tool.*`) its blocks queue for the loop call that issued it, so they arrive
	 * as a developer message rather than inside a script's return value. With no
	 * batch running (Cursor exec), the call's own context sink delivers them. Only
	 * a bridge that marks its context `bridgedResultShown` puts the call's result
	 * in front of the model; any other bridge's result is hidden.
	 */
	async afterBridgedToolCall(
		toolCallId: string,
		result: AgentToolResult,
		isError: boolean,
		context?: AgentToolContext,
	): Promise<void> {
		const call = this.#bridged.get(toolCallId);
		this.#bridged.delete(toolCallId);
		if (!call || isError) return;
		const messages = this.#host.window();
		const batch = this.#bridgedBatch(messages.findLast(message => message.role === "assistant"));
		await this.#touch({
			...call,
			details: result.details,
			batch,
			messages,
			hidden: context?.bridgedResultShown !== true,
		});
		if (batch.outstanding.size > 0 || !context?.addAdditionalContext) return;
		const text = this.#drain(batch);
		if (text) context.addAdditionalContext(text);
	}

	cancelBridgedToolCall(toolCallId: string): void {
		this.#bridged.delete(toolCallId);
	}

	/**
	 * Blocks a finished batch never handed over, as a developer message for the
	 * step boundary after it. A call the loop skipped or aborted (a steered-past
	 * `wait`) never reaches {@link afterToolCall}, so its batch never settles;
	 * the boundary poll runs once every call has finished, before the next
	 * request. A message the loop drops unsent puts its blocks back in the queue.
	 */
	takeStranded(): CommittableAsideMessage | null {
		const batch = this.#batch;
		if (!batch || batch.queue.length === 0) return null;
		batch.outstanding.clear();
		batch.executing = true;
		const queued = [...batch.queue];
		const text = this.#drain(batch);
		if (text === undefined) return null;
		return {
			...createAdditionalContextMessage(text),
			[ASIDE_MESSAGE_DISCARD]: () => {
				const current = this.#batch;
				if (!current) return;
				for (const block of queued) current.claimed.add(block.path);
				current.queue.unshift(...queued);
			},
		};
	}

	#batchFor(message: AgentMessage | undefined): BatchState {
		// The loop and the session's message list can hold different copies of the message.
		const key = toolCallKey(message);
		return this.#batch?.key === key ? this.#batch : this.#newBatch(key);
	}

	/**
	 * The batch a bridged call joins. Eval's `tool.*` runs inside the loop call
	 * that issued it, so it joins that call's batch while the call is
	 * outstanding. Cursor exec runs before its response joins the window, so the
	 * newest assistant message there is the previous response, whose batch has
	 * handed its blocks over and whose claims a compaction may since have made
	 * stale. Each response's out-of-loop calls share a batch of their own,
	 * keyed off that previous message.
	 */
	#bridgedBatch(previous: AgentMessage | undefined): BatchState {
		const key = toolCallKey(previous);
		const current = this.#batch;
		if (current?.key === key && current.outstanding.size > 0) return current;
		const bridgedKey = `${BRIDGED_BATCH_PREFIX}${key}`;
		return current?.key === bridgedKey ? current : this.#newBatch(bridgedKey);
	}

	#newBatch(key: string): BatchState {
		// Blocks a batch could not hand over (a call never settled) move on with their claims.
		const queue = this.#batch?.queue ?? [];
		this.#batch = {
			key,
			registered: new Map(),
			outstanding: new Set(),
			executing: false,
			claimed: new Set(queue.map(queued => queued.path)),
			fullReads: new Set(),
			queue,
		};
		return this.#batch;
	}

	#touch(touch: Touch): Promise<void> | undefined {
		if (TRIGGER_TOOLS[touch.toolName] !== true) return undefined;
		// A whole read of a context file puts it in context: tool results precede
		// the batch's developer message. Recorded before any await, and checked
		// again when the queue is handed over, so a parallel call cannot claim the
		// file first. A script's read reaches the model only if the script prints
		// it, so it does not count.
		const fullRead = touch.toolName === "read" && !touch.hidden ? fullReadPath(touch.details) : undefined;
		if (fullRead) touch.batch.fullReads.add(fullRead);
		const cwd = path.resolve(this.#host.cwd());
		const edited = editedFiles(touch, cwd);
		// Discovery reads through the capability fs cache, which would still hold
		// the directory listing and content from before this edit.
		for (const file of edited) invalidateCapabilityCache(file);
		const targets = touchedTargets(touch, cwd, edited);
		const roots = this.#roots(cwd);
		// A known file only touches its parent; an unknown target may be a directory itself.
		const reachable = targets.some(
			target => rootOf(roots, target.isDirectory === false ? path.dirname(target.path) : target.path) !== undefined,
		);
		if (!reachable) return undefined;
		return this.#load(touch, cwd, roots, targets);
	}

	/** Workspace roots: cwd and the additional directories, whose own context files are in the system prompt. */
	#roots(cwd: string): string[] {
		return [cwd, ...this.#host.additionalDirectories().map(dir => path.resolve(dir))];
	}

	async #load(touch: Touch, cwd: string, roots: readonly string[], targets: readonly TouchedTarget[]): Promise<void> {
		let files: NestedContextFile[];
		let inPrompt: ReadonlySet<string>;
		try {
			const directories = (await Promise.all(targets.map(touchedDirectory))).filter(
				dir => rootOf(roots, dir) !== undefined,
			);
			if (directories.length === 0) return;
			files = await this.#discover(directories, roots);
			if (files.length === 0) return;
			inPrompt = new Set(this.#host.promptContextFiles());
		} catch (error) {
			logger.warn("Nested context discovery failed", { error: String(error) });
			return;
		}

		const { batch } = touch;
		const window = scanWindow(touch.messages);
		// Claims and queueing stay synchronous, so the queue is in claim order.
		for (const file of files) {
			if (batch.claimed.has(file.path) || window.blocks.has(file.path)) continue;
			// A raw read shows `@` imports unexpanded, so it only stands in for a file without them.
			const plain = file.content === file.raw;
			if (plain && (window.fullReads.has(file.path) || batch.fullReads.has(file.path))) continue;
			if (inPrompt.has(file.path)) continue;
			batch.claimed.add(file.path);
			const display = displayPath(cwd, file.path);
			const block = prompt.render(nestedContextFileTemplate, {
				path: escapeAttribute(file.path),
				dir: escapeAttribute(`${displayPath(cwd, file.owner)}/`),
				content: escapeBlockTags(capContent(file.content, display)),
			});
			batch.queue.push({ path: file.path, block, display, depth: segmentCount(file.owner), plain });
		}
	}

	/** Marks `id` settled; hands over the queue once no call of the batch is outstanding. */
	#settle(batch: BatchState, id: string): string | undefined {
		batch.executing = true;
		batch.outstanding.delete(id);
		return batch.outstanding.size > 0 ? undefined : this.#drain(batch);
	}

	/**
	 * The queued blocks, shallowest first, less files a call of the batch read
	 * whole after another claimed them. Calls on disjoint branches claim in I/O
	 * order, so claim order alone can put a deep file ahead of a shallow one. The
	 * sort is stable: within a directory, files keep capability order.
	 */
	#drain(batch: BatchState): string | undefined {
		const delivered = batch.queue
			.splice(0)
			.filter(queued => !(queued.plain && batch.fullReads.has(queued.path)))
			.sort((a, b) => a.depth - b.depth);
		if (delivered.length === 0) return undefined;
		this.#host.emitNotice("info", `Loaded ${delivered.map(queued => queued.display).join(", ")}`, NOTICE_SOURCE);
		return delivered.map(queued => queued.block).join("\n\n");
	}

	/**
	 * Context files governing `directories`, shallowest first, each once.
	 * Discovery is the context-file capability itself, run from each touched
	 * directory and every ancestor below its workspace root. Each probe contributes only the
	 * files of its own directory: some providers look nowhere else, so only the
	 * exact probe sees every candidate. Provider priority, one-file-per-directory
	 * shadowing and `contextFiles.extra` ordering are then exactly as the system
	 * prompt has them for that directory.
	 */
	async #discover(directories: readonly string[], roots: readonly string[]): Promise<NestedContextFile[]> {
		// Each probe, with the workspace root it sits below.
		const probes = new Map<string, string>();
		for (const dir of directories) {
			const root = rootOf(roots, dir);
			if (root === undefined) continue;
			for (let current = dir; isStrictlyWithinNormalizedRoot(root, current); current = path.dirname(current)) {
				probes.set(current, root);
			}
		}
		let files: Omit<NestedContextFile, "content">[] = [];
		for (const [owner, root] of probes) {
			if (isExcludedDirectory(path.relative(root, owner))) continue;
			const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: owner });
			for (const item of result.items) {
				// Depth counts levels above the probe; files in its own config folders report -1.
				if (item.level !== "project" || (item.depth ?? 0) > 0) continue;
				files.push({ path: item.path, owner, raw: item.content });
			}
		}
		const realRoots = await Promise.all(roots.map(root => fs.realpath(root).catch(() => root)));
		const allowed = await Promise.all(files.map(file => isProjectContext(file, realRoots)));
		files = files.filter((_, index) => allowed[index]);
		// Stable: within a directory, capability order (the winner, then additive extras).
		files.sort((a, b) => segmentCount(a.owner) - segmentCount(b.owner) || a.owner.localeCompare(b.owner));
		return Promise.all(files.map(async file => ({ ...file, content: await expandAtImports(file.raw, file.path) })));
	}

	/**
	 * Nested context files the live window holds, as system-prompt context file
	 * entries for a subagent: delivered blocks with the content as delivered, and
	 * full reads of a nested context file with the content discovery loads (the
	 * read result itself carries line prefixes). Shallowest first and in
	 * capability order within a directory, as the system prompt keeps them, not
	 * in the order the window gained them. Each carries a negative depth, levels
	 * below the root it sits under, so the child's prompt ranks it after every
	 * file at or above that root. Empty with the setting off.
	 */
	async carried(messages: readonly AgentMessage[]): Promise<ContextFileEntry[]> {
		if (!cfgContextFilesOnTouch.get(this.#host.settings)) return [];
		const cwd = path.resolve(this.#host.cwd());
		const roots = this.#roots(cwd);
		const window = scanWindow(messages);
		const byPath = new Map(window.blocks);
		const unread = [...window.fullReads].filter(
			filePath => !byPath.has(filePath) && rootOf(roots, ownerDirectory(filePath)) !== undefined,
		);
		if (byPath.size === 0 && unread.length === 0) return [];
		// Discovery decides which read files are context files, as it does for
		// touches, and gives every file its owner and capability rank.
		let files: NestedContextFile[] = [];
		try {
			files = await this.#discover([...new Set([...byPath.keys(), ...unread].map(ownerDirectory))], roots);
		} catch (error) {
			logger.warn("Nested context discovery failed", { error: String(error) });
		}
		for (const file of files) {
			if (unread.includes(file.path)) byPath.set(file.path, capContent(file.content, displayPath(cwd, file.path)));
		}
		const ranks = new Map(files.map((file, index) => [file.path, { depth: segmentCount(file.owner), index }]));
		// A delivered file discovery no longer finds keeps its place among its directory's files.
		const rank = (filePath: string) =>
			ranks.get(filePath) ?? { depth: segmentCount(ownerDirectory(filePath)), index: Number.MAX_SAFE_INTEGER };
		return [...byPath]
			.map(([filePath, content]) => ({ path: filePath, content, rank: rank(filePath) }))
			.sort((a, b) => a.rank.depth - b.rank.depth || a.rank.index - b.rank.index)
			.map(({ path: filePath, content }) => ({
				path: filePath,
				content,
				depth: nestedDepth(cwd, roots, ownerDirectory(filePath)),
			}));
	}
}

/**
 * The deepest workspace root `dir` is strictly below, which bounds discovery
 * for it; undefined when it is below none.
 */
function rootOf(roots: readonly string[], dir: string): string | undefined {
	let deepest: string | undefined;
	for (const root of roots) {
		if (
			isStrictlyWithinNormalizedRoot(root, dir) &&
			(deepest === undefined || isStrictlyWithinNormalizedRoot(deepest, root))
		) {
			deepest = root;
		}
	}
	return deepest;
}

/**
 * Context-file depth of a nested file owned by `owner`: levels below cwd as a
 * negative number, since `ContextFile.depth` counts levels above it, so a
 * system prompt ranks it after every file it loaded itself. Owners outside cwd
 * count from the workspace root they sit under, as that root's own files count
 * from it; one outside every root (the session moved since) ranks just below cwd.
 */
function nestedDepth(cwd: string, roots: readonly string[], owner: string): number {
	const base = isStrictlyWithinNormalizedRoot(cwd, owner) ? cwd : rootOf(roots, owner);
	return base === undefined ? -1 : segmentCount(base) - segmentCount(owner);
}

/**
 * A file's own `<nested-context` tags, neutralised: the window is parsed back
 * from delivered blocks, so a body must not be able to end its block early or
 * add one of its own.
 */
function escapeBlockTags(content: string): string {
	return content.replace(/<(\/?)nested-context/g, "&lt;$1nested-context");
}

const ATTRIBUTE_ESCAPES: Record<string, string> = { "&": "&amp;", '"': "&quot;", "\n": "&#10;" };
const ATTRIBUTE_UNESCAPES: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&#10;": "\n" };

/**
 * A path made safe for a block's header, reversibly: a quote would end the
 * `path` attribute and a newline the header line, so the block would never
 * parse back as delivered.
 */
function escapeAttribute(value: string): string {
	return value.replace(/[&"\n]/g, char => ATTRIBUTE_ESCAPES[char]);
}

function unescapeAttribute(value: string): string {
	return value.replace(/&(?:amp|quot|#10);/g, entity => ATTRIBUTE_UNESCAPES[entity]);
}

/** The per-file cost bound: content past the cap is cut, with a pointer to the rest. */
function capContent(content: string, display: string): string {
	if (content.length <= NESTED_CONTEXT_FILE_MAX_CHARS) return content;
	return prompt.render(nestedContextTruncatedTemplate, {
		content: content.slice(0, NESTED_CONTEXT_FILE_MAX_CHARS),
		max: NESTED_CONTEXT_FILE_MAX_CHARS,
		path: display,
	});
}

/**
 * Context files the live window already holds, by absolute path: blocks
 * delivered as developer messages, with their delivered content, and files read
 * in full. Only the harness writes developer messages; a block-shaped string in
 * tool output is the tool's output, never a delivered file.
 */
function scanWindow(messages: readonly AgentMessage[]): { blocks: Map<string, string>; fullReads: Set<string> } {
	const blocks = new Map<string, string>();
	const fullReads = new Set<string>();
	for (const message of messages) {
		if (message.role === "developer") {
			for (const match of messageText(message.content).matchAll(BLOCK_RE)) {
				const blockPath = unescapeAttribute(match[1]);
				if (path.isAbsolute(blockPath)) blocks.set(blockPath, match[2]);
			}
		} else if (message.role === "toolResult" && message.toolName === "read" && !message.isError) {
			const readPath = fullReadPath(message.details);
			if (readPath) fullReads.add(readPath);
		}
	}
	return { blocks, fullReads };
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") text += part.text;
	}
	return text;
}

/**
 * Filesystem path a read result covers: `resolvedPath` when the read resolved
 * the input, else the path plain-file reads record in `meta.source`. Undefined
 * for internal URLs (skill://, local://, …) and web reads.
 */
function readDetailsPath(details: Record<string, unknown>): string | undefined {
	const source = isRecord(details.meta) && isRecord(details.meta.source) ? details.meta.source : undefined;
	if (source && source.type !== "path") return undefined;
	if (typeof details.resolvedPath === "string") return path.resolve(details.resolvedPath);
	return typeof source?.value === "string" ? path.resolve(source.value) : undefined;
}

/**
 * Absolute path of a read that showed the whole file: every line from 1 to the
 * end, in order, with nothing truncated, elided, summarised or cut at a column.
 * A tail or range read can start at line 1 and still skip the middle, so the
 * displayed line numbers are the proof.
 */
function fullReadPath(details: unknown): string | undefined {
	if (!isRecord(details) || details.isDirectory === true) return undefined;
	if (details.truncation !== undefined || details.summary !== undefined) return undefined;
	const meta = isRecord(details.meta) ? details.meta : {};
	if (meta.truncation !== undefined) return undefined;
	if (isRecord(meta.limits) && meta.limits.columnTruncated !== undefined) return undefined;
	const display = details.displayContent;
	if (typeof details.totalLines !== "number" || !isRecord(display)) return undefined;
	const lines = display.lineNumbers;
	if (!Array.isArray(lines) || lines.length !== details.totalLines) return undefined;
	if (lines.some((line, index) => line !== index + 1)) return undefined;
	return readDetailsPath(details);
}

/** Absolute paths a write, edit or ast_edit changed, from the tool's own resolved paths where it reports them. */
function editedFiles(touch: Touch, cwd: string): string[] {
	const details = isRecord(touch.details) ? touch.details : {};
	const args = isRecord(touch.args) ? touch.args : {};
	const files = new Set<string>();
	const add = (filePath: unknown, base = cwd): void => {
		if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("://")) return;
		files.add(path.resolve(base, filePath));
	};
	switch (touch.toolName) {
		case "write":
			add(details.resolvedPath ?? args.path);
			break;
		case "edit":
			// A move reports its destination as `path` and its origin as `sourcePath`.
			add(details.path);
			add(details.sourcePath);
			if (Array.isArray(details.perFileResults)) {
				for (const entry of details.perFileResults) {
					if (!isRecord(entry)) continue;
					add(entry.path);
					add(entry.sourcePath);
				}
			}
			break;
		case "ast_edit": {
			const base = typeof details.cwd === "string" ? details.cwd : cwd;
			if (Array.isArray(details.files)) for (const file of details.files) add(file, base);
			break;
		}
	}
	return [...files];
}

/** A path the call touched; `isDirectory` is undefined where only the filesystem can tell. */
interface TouchedTarget {
	path: string;
	isDirectory: boolean | undefined;
}

/** Paths the call touched: a read's targets, or the files it edited. */
function touchedTargets(touch: Touch, cwd: string, edited: readonly string[]): TouchedTarget[] {
	if (touch.toolName !== "read") return edited.map(file => ({ path: file, isDirectory: false }));
	const details = isRecord(touch.details) ? touch.details : {};
	const targets: TouchedTarget[] = [];
	const resolved = readDetailsPath(details);
	if (resolved) targets.push({ path: resolved, isDirectory: details.isDirectory === true });
	// A grouped read (`a.ts;b/c.ts`) reports each target only as a link.
	if (Array.isArray(details.displayReadTargetLinks)) {
		for (const link of details.displayReadTargetLinks) {
			if (typeof link !== "string" || link.length === 0 || link.includes("://")) continue;
			targets.push({ path: path.resolve(cwd, link), isDirectory: undefined });
		}
	}
	return targets;
}

/** The directory a target touched: itself when it is one, else its parent. */
async function touchedDirectory(target: TouchedTarget): Promise<string> {
	const isDirectory =
		target.isDirectory ??
		(await fs.stat(target.path).then(
			stats => stats.isDirectory(),
			() => false,
		));
	return isDirectory ? target.path : path.dirname(target.path);
}

function segmentCount(dir: string): number {
	return dir.split(path.sep).length;
}

/**
 * The directory a nested context file governs: its own, or for a file in a
 * config folder (`.github/copilot-instructions.md`) the folder's parent.
 * Discovery skips hidden directories, so a hidden segment at the end can only
 * be such a folder.
 */
function ownerDirectory(filePath: string): string {
	let dir = path.dirname(filePath);
	while (path.basename(dir).startsWith(".") && path.dirname(dir) !== dir) dir = path.dirname(dir);
	return dir;
}

/**
 * Whether a directory, given relative to its workspace root, is a hidden
 * directory, a dependency tree, or inside one: never project context.
 */
function isExcludedDirectory(relative: string): boolean {
	return relative.split(path.sep).some(segment => segment.startsWith(".") || EXCLUDED_SEGMENTS[segment] === true);
}

/**
 * Whether the file a context path resolves to is project context: below a
 * workspace root, and not in a hidden directory or dependency tree there. A
 * symlinked directory or file in the repository can point at a third-party
 * `AGENTS.md` or into `node_modules/`; the link's location does not make its
 * target project context. A file that cannot be resolved is not loaded.
 */
async function isProjectContext(file: { path: string; owner: string }, realRoots: readonly string[]): Promise<boolean> {
	let real: string;
	try {
		real = await fs.realpath(file.path);
	} catch {
		return false;
	}
	const root = rootOf(realRoots, real);
	if (root === undefined) return false;
	// A provider's config folder below the governed directory (`.github/`) is its layout, not a hidden tree.
	const configFolder = path.relative(file.owner, path.dirname(file.path));
	let dir = path.dirname(real);
	if (configFolder !== "" && dir.endsWith(`${path.sep}${configFolder}`)) {
		dir = dir.slice(0, dir.length - configFolder.length - path.sep.length);
	}
	return !isExcludedDirectory(path.relative(root, dir));
}

function displayPath(cwd: string, target: string): string {
	return path.relative(cwd, target).split(path.sep).join("/");
}
