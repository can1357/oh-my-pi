/**
 * The browser blocks of a Tern window (Tern's `blocks` op) and how
 * `app.target` picks the one an open adopts.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { TernSocketClient } from "./wire";

/**
 * One browser block of the window. Terns before block adoption list only the
 * blocks scripts drive and omit `shown`/`driven`: those stay undefined.
 */
export interface TernBlockEntry {
	block: number;
	/** The page's address (`about:blank` while blank). */
	url: string;
	title: string;
	/** The block a PiP floats over; null for a docked block. */
	owner: number | null;
	/** Whether the block is on screen now. */
	shown: boolean | undefined;
	/** Whether scripts drive it. */
	driven: boolean | undefined;
}

/** One block as `browser.targets()` lists it: `app.target` adopts it by `target` (its id). */
export interface TernTarget {
	/** The block id, as `app.target` takes it. */
	target: string;
	title: string;
	url: string;
	/** Whether it is on screen now; omitted by Terns before block adoption. */
	shown?: boolean;
	/** False for a picture-in-picture floating over another block. */
	docked: boolean;
	/** Whether scripts drive it; omitted by Terns before block adoption. */
	driven?: boolean;
	/** The omp tab of this process holding it, if any. */
	tab?: string;
}

/**
 * What to add about Terns before block adoption, which list only the blocks
 * scripts drive (entries without `driven`): certain when an entry lacks it,
 * a possibility when the list is empty.
 */
function oldTernNote(blocks: readonly TernBlockEntry[]): string {
	if (blocks.some(entry => entry.driven === undefined)) {
		return "\nThis Tern lists only the blocks scripts drive: update Tern to adopt the user's own.";
	}
	if (blocks.length === 0) {
		return "\nIf the user has browser blocks open, this Tern predates block adoption: update Tern.";
	}
	return "";
}

/** The window's blocks as targets, naming the omp tab (`taken`) holding each. */
export function ternTargets(blocks: readonly TernBlockEntry[], taken: ReadonlyMap<number, string>): TernTarget[] {
	return blocks.map(entry => {
		const target: TernTarget = {
			target: String(entry.block),
			title: entry.title,
			url: entry.url,
			docked: entry.owner === null,
		};
		if (entry.shown !== undefined) target.shown = entry.shown;
		if (entry.driven !== undefined) target.driven = entry.driven;
		const tab = taken.get(entry.block);
		if (tab !== undefined) target.tab = tab;
		return target;
	});
}

/** The `browser.targets()` listing of a Tern window's blocks. */
export function describeTernTargets(blocks: readonly TernBlockEntry[], taken: ReadonlyMap<number, string>): string {
	const update = oldTernNote(blocks);
	if (blocks.length === 0) return `This Tern window lists no browser blocks.${update}`;
	const list = blocks.map(entry => `- ${describeTernBlock(entry, taken.get(entry.block))}`).join("\n");
	return `Tern browser blocks (adopt one with app.target set to its id):\n${list}${update}`;
}

/** The window's browser blocks; malformed entries are skipped. */
export async function listTernBlocks(
	client: TernSocketClient,
	opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<TernBlockEntry[]> {
	const answer = await client.request({ op: "blocks" }, opts);
	if (!isRecord(answer) || !Array.isArray(answer.blocks)) return [];
	const blocks: TernBlockEntry[] = [];
	for (const raw of answer.blocks) {
		if (!isRecord(raw) || typeof raw.block !== "number") continue;
		blocks.push({
			block: raw.block,
			url: typeof raw.url === "string" ? raw.url : "about:blank",
			title: typeof raw.title === "string" ? raw.title : "",
			owner: typeof raw.owner === "number" ? raw.owner : null,
			shown: typeof raw.shown === "boolean" ? raw.shown : undefined,
			driven: typeof raw.driven === "boolean" ? raw.driven : undefined,
		});
	}
	return blocks;
}

/**
 * The block `target` names: the block whose id it is (all digits), else the
 * blocks whose URL or title contain it (case-insensitive). Among several,
 * one on screen wins, then one scripts do not drive (the user's own), then
 * the first listed. Blocks in `taken` (other omp tabs drive them) never match.
 */
export function pickTernBlock(
	blocks: readonly TernBlockEntry[],
	target: string,
	taken: ReadonlyMap<number, string> = new Map(),
): TernBlockEntry | undefined {
	const free = blocks.filter(entry => !taken.has(entry.block));
	const needle = target.trim();
	if (/^\d+$/.test(needle)) {
		const byId = free.find(entry => String(entry.block) === needle);
		if (byId) return byId;
	}
	const lower = needle.toLowerCase();
	const rank = (entry: TernBlockEntry): number => (entry.shown === true ? 2 : 0) + (entry.driven === false ? 1 : 0);
	let best: TernBlockEntry | undefined;
	for (const entry of free) {
		if (!entry.url.toLowerCase().includes(lower) && !entry.title.toLowerCase().includes(lower)) continue;
		if (!best || rank(entry) > rank(best)) best = entry;
	}
	return best;
}

/** One block for the agent: `12 "Title" https://… (docked, on screen)`. */
export function describeTernBlock(entry: TernBlockEntry, takenBy?: string): string {
	const facts = [entry.owner === null ? "docked" : `picture-in-picture over block ${entry.owner}`];
	if (entry.shown !== undefined) facts.push(entry.shown ? "on screen" : "not on screen");
	if (takenBy !== undefined) facts.push(`driven by omp tab ${JSON.stringify(takenBy)}`);
	else if (entry.driven === true) facts.push("driven by a script");
	return `${entry.block} ${JSON.stringify(entry.title)} ${entry.url} (${facts.join(", ")})`;
}

/** The error of an `app.target` no block matches, listing the window's browser blocks. */
export function noTernBlockError(
	blocks: readonly TernBlockEntry[],
	target: string,
	taken: ReadonlyMap<number, string> = new Map(),
): ToolError {
	const update = oldTernNote(blocks);
	if (blocks.length === 0) {
		return new ToolError(
			`No Tern browser block to adopt for app.target ${JSON.stringify(target)}: this Tern window lists no browser blocks. Ask the user to open one, or omit app.target to open a picture-in-picture over this pane. browser.targets() lists the blocks you can adopt.${update}`,
		);
	}
	const list = blocks.map(entry => `- ${describeTernBlock(entry, taken.get(entry.block))}`).join("\n");
	return new ToolError(
		`No Tern browser block matches app.target ${JSON.stringify(target)} (a block id, or a URL/title substring). Browser blocks in this Tern window:\n${list}\nRetry with app.target set to one of these ids; browser.targets() lists them before adopting.${update}`,
	);
}
