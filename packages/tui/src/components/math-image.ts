import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import {
	getMathImageGeneration,
	getMathImageRenderer,
	onMathImageRendererChange,
	type MathImageRenderRequest,
	type MathImageSvg,
} from "../math-image-renderer";
import type { Component } from "../tui";
import { Image, getImageRenderContext, isImageMeasureRender, type ImageBudget, type ImagePresentation } from "./image";

const MiB = 1024 * 1024;
const encoder = new TextEncoder();
interface Raster {
	base64: string;
	widthPx: number;
	heightPx: number;
}
const svgCache = new LRUCache<string, MathImageSvg>({
	max: 512,
	maxSize: 8 * MiB,
	maxEntrySize: MiB,
	sizeCalculation: (v, k) => 128 + 2 * (k.length + v.svg.length),
});
const pngCache = new LRUCache<string, Raster>({
	max: 256,
	maxSize: 32 * MiB,
	maxEntrySize: 4 * MiB,
	sizeCalculation: (v, k) => 128 + 2 * (k.length + v.base64.length),
	dispose: (_value, key) => {
		for (const reference of activeOwners) {
			const owner = reference.deref();
			if (!owner) {
				activeOwners.delete(reference);
				continue;
			}
			for (const slot of owner.slots.values()) if (slot.key === key && !slot.raster) slot.image = undefined;
		}
	},
});
const negativeCache = new LRUCache<string, string>({
	max: 256,
	maxSize: MiB,
	sizeCalculation: (v, k) => 128 + 2 * (k.length + v.length),
});
interface Work {
	key: string;
	svgKey: string;
	request: MathImageRenderRequest;
	maxHeightPx: number;
	generation: number;
	listeners: Set<() => void>;
}
const pending = new Map<string, Work>();
const queue: Work[] = [];
let scheduled = false;
let activeConversions = 0;
function fail(key: string, error: unknown): void {
	if (negativeCache.has(key)) return;
	// MathJax's TexError is a plain object with `message`, not an Error subclass.
	const message =
		typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
			? error.message
			: String(error);
	const reason = message.slice(0, 240);
	negativeCache.set(key, reason);
	logger.debug("Math image unavailable", { identity: key, reason });
}
/** Uniform scale that fits an inline formula into one cell row, or undefined when it would be unreadable. */
function inlineRowFit(svg: MathImageSvg, request: MathImageRenderRequest): number | undefined {
	const fit = Math.min(1, request.cellHeightPx / Math.ceil(svg.heightEx * request.pixelsPerEx));
	if (fit < 0.6 || /data-mml-node="mtable"/.test(svg.svg)) return undefined;
	return fit;
}
function drain(): void {
	scheduled = false;
	if (activeConversions >= 256) return;
	const work = queue.shift();
	if (!work) return;
	if (work.generation === getMathImageGeneration()) {
		activeConversions++;
		void convert(work).finally(() => {
			activeConversions--;
			if (queue.length) schedule();
		});
	}
	if (queue.length && activeConversions < 256) schedule();
}
function schedule(): void {
	if (!scheduled) {
		scheduled = true;
		setImmediate(drain);
	}
}
async function convert(work: Work): Promise<void> {
	let failureKey = work.svgKey;
	try {
		const request = work.request;
		const maxWidthPx = Math.floor(Math.min(4096, request.maxWidthPx) / request.cellWidthPx) * request.cellWidthPx;
		let svg = svgCache.get(work.svgKey);
		if (!svg) {
			const renderer = getMathImageRenderer();
			if (!renderer) return;
			svg = renderer.render(request);
			if (128 + 2 * (work.svgKey.length + svg.svg.length) > MiB) throw new Error("SVG exceeds retained size limit");
			if (
				!Number.isFinite(svg.widthEx) ||
				!Number.isFinite(svg.heightEx) ||
				svg.widthEx <= 0 ||
				svg.heightEx <= 0 ||
				!/^\s*<svg\b/.test(svg.svg) ||
				!/\bviewBox\s*=/.test(svg.svg) ||
				/<(?:image|foreignObject|script)\b|(?:href|src)\s*=\s*["'](?:https?:|\/\/|data:)/i.test(svg.svg)
			)
				throw new Error("Invalid standalone SVG");
			svgCache.set(work.svgKey, svg);
		}
		failureKey = work.key;
		const baseWidth = svg.widthEx * request.pixelsPerEx;
		const baseHeight = svg.heightEx * request.pixelsPerEx;
		const inlineFit = request.display ? 1 : inlineRowFit(svg, request);
		if (inlineFit === undefined || (!request.display && baseWidth > maxWidthPx)) {
			negativeCache.set(work.key, "Inline geometry is ineligible");
			return;
		}
		const fit = request.display ? Math.min(1, maxWidthPx / baseWidth) : inlineFit;
		const columns = Math.min(Math.ceil((baseWidth * fit) / request.cellWidthPx), maxWidthPx / request.cellWidthPx);
		const rows = Math.ceil((baseHeight * fit) / request.cellHeightPx);
		const widthPx = columns * request.cellWidthPx;
		const heightPx = rows * request.cellHeightPx;
		if (
			![baseWidth, baseHeight, widthPx, heightPx].every(value => Number.isFinite(value) && value > 0) ||
			(!request.display && rows > 1) ||
			widthPx > maxWidthPx ||
			heightPx > work.maxHeightPx ||
			widthPx > 4096 ||
			heightPx > 4096 ||
			widthPx * heightPx > 16 * MiB
		)
			throw new Error("Math geometry exceeds layout bounds");
		const normalized = svg.svg.replace(
			/^(\s*<svg\b)([^>]*)(>)/,
			(_match: string, start: string, attrs: string, end: string) =>
				`${start}${attrs.replace(/\s(?:width|height)\s*=\s*["'][^"']*["']/g, "")} width="${baseWidth * (request.display ? 1 : fit)}" height="${baseHeight * (request.display ? 1 : fit)}"${end}`,
		);
		const bytes = await rasterizeSvg(encoder.encode(normalized), maxWidthPx, work.maxHeightPx, 1, {
			widthPx: request.cellWidthPx,
			heightPx: request.cellHeightPx,
		});
		const base64 = Buffer.from(bytes).toString("base64");
		if (128 + 2 * (work.key.length + base64.length) > 4 * MiB) throw new Error("PNG exceeds retained size limit");
		if (bytes.length < 24 || Buffer.from(bytes.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a")
			throw new Error("Invalid PNG");
		const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (header.getUint32(16) !== widthPx || header.getUint32(20) !== heightPx)
			throw new Error("Unexpected raster geometry");
		if (work.generation === getMathImageGeneration()) pngCache.set(work.key, { base64, widthPx, heightPx });
	} catch (error) {
		if (work.generation === getMathImageGeneration()) fail(failureKey, error);
	} finally {
		if (pending.get(work.key) === work) {
			pending.delete(work.key);
			for (const listener of work.listeners) listener();
		}
	}
}
interface Slot {
	key: string;
	placement: string;
	budget: ImageBudget;
	image?: Image;
	listener?: () => void;
	pending: boolean;
	change: () => void;
	settled?: boolean;
	raster?: Raster;
	request?: MathImageRenderRequest;
	svgKey?: string;
	maxHeightPx?: number;
}
interface Owner {
	id: number;
	slots: Map<string, Slot>;
	changed: () => void;
	seen: Set<string>;
	document: number;
	pending: boolean;
	reference?: WeakRef<Owner>;
}
const owners = new WeakMap<Component, Owner>();
const activeOwners = new Set<WeakRef<Owner>>();
let nextOwner = 0;
let currentOwner: Owner | undefined;
function release(slot: Slot): void {
	slot.budget.release(slot.placement);
	if (slot.listener) pending.get(slot.key)?.listeners.delete(slot.listener);
	slot.image = undefined;
	slot.raster = undefined;
	slot.pending = false;
}
export function releaseMathImageOwner(owner: Component): void {
	const record = owners.get(owner);
	if (!record) return;
	for (const slot of record.slots.values()) release(slot);
	record.slots.clear();
	record.pending = false;
	if (record.reference) activeOwners.delete(record.reference);
	owners.delete(owner);
}
/** Drop presentation buffers without deleting graphics already committed to scrollback. */
export function releaseMathImageRenderCaches(owner: Component): void {
	const record = owners.get(owner);
	if (!record) return;
	for (const slot of record.slots.values()) {
		slot.image = undefined;
		slot.raster = undefined;
	}
}
export function releaseMathImages(): void {
	for (const reference of activeOwners) {
		const owner = reference.deref();
		if (!owner) continue;
		for (const slot of owner.slots.values()) release(slot);
		owner.slots.clear();
		owner.pending = false;
		owner.changed();
	}
	activeOwners.clear();
}
onMathImageRendererChange(() => {
	pending.clear();
	queue.length = 0;
	svgCache.clear();
	pngCache.clear();
	negativeCache.clear();
	releaseMathImages();
});
export function withMathImageOwner<T>(owner: Component, onChange: () => void, render: () => T): T {
	let record = owners.get(owner);
	for (const reference of activeOwners) if (!reference.deref()) activeOwners.delete(reference);
	if (!record) {
		record = { id: ++nextOwner, slots: new Map(), changed: onChange, seen: new Set(), document: 0, pending: false };
		owners.set(owner, record);
	}
	const previous = currentOwner;
	if (previous === record) {
		const changed = record.changed;
		record.changed = onChange;
		try {
			return render();
		} finally {
			record.changed = changed;
		}
	}
	const measuring = isImageMeasureRender();
	const previousDocument = record.document;
	record.document = 0;
	record.changed = onChange;
	if (!measuring) {
		record.seen.clear();
		record.pending = false;
	}
	currentOwner = record;
	try {
		return render();
	} finally {
		currentOwner = previous;
		if (measuring) record.document = previousDocument;
		else {
			for (const [key, slot] of record.slots)
				if (!record.seen.has(key)) {
					release(slot);
					record.slots.delete(key);
				}
		}
		if (record.slots.size) {
			record.reference ??= new WeakRef(record);
			activeOwners.add(record.reference);
		} else if (record.reference) activeOwners.delete(record.reference);
	}
}
export function mathImageOwnerPending(owner: Component): boolean {
	return owners.get(owner)?.pending ?? false;
}
/** Capture during render; compose with local cache invalidation only when no explicit component handler exists. */
export function getMathImageOwnerChangeHandler(): (() => void) | undefined {
	return currentOwner?.changed;
}
export function hasMathImageOwner(): boolean {
	return currentOwner !== undefined;
}
export function releaseMathImageDocument(document: number): void {
	if (!currentOwner) return;
	for (const [path, slot] of currentOwner.slots)
		if (path.startsWith(`${document}:`)) {
			release(slot);
			currentOwner.slots.delete(path);
		}
}
export function releaseMathImageOccurrence(document: number, occurrence: string): void {
	const path = `${document}:${occurrence}`;
	const slot = currentOwner?.slots.get(path);
	if (slot) {
		release(slot);
		currentOwner?.slots.delete(path);
	}
}
/** Call once per Markdown render, including a cached-row replay. */
export function beginMathImageDocument(): number {
	return currentOwner ? currentOwner.document++ : 0;
}
/** Measure cached intrinsic inline geometry without acquiring a placement or observing the budget. */
export function measureMathImage(
	request: MathImageRenderRequest,
	onChange: () => void,
): { columns: number } | undefined {
	const renderer = getMathImageRenderer();
	if (!renderer) return undefined;
	const svgKey = Bun.hash(JSON.stringify([getMathImageGeneration(), renderer.id, request])).toString(16);
	const svg = svgCache.get(svgKey);
	if (svg) {
		const fit = inlineRowFit(svg, request);
		if (fit === undefined) return undefined;
		return { columns: Math.ceil((svg.widthEx * request.pixelsPerEx * fit) / request.cellWidthPx) };
	}
	if (negativeCache.has(svgKey)) return undefined;
	const key = `${svgKey}:measure`;
	let work = pending.get(key);
	if (!work) {
		work = {
			key,
			svgKey,
			request,
			maxHeightPx: request.cellHeightPx,
			generation: getMathImageGeneration(),
			listeners: new Set(),
		};
		pending.set(key, work);
		queue.push(work);
		schedule();
	}
	work?.listeners.add(onChange);
	return undefined;
}
const fallback: ImagePresentation = { lines: [], graphic: false, pending: false };
/** Stable document/token paths are owned by Markdown; rows must replay this call in source order. */
export function renderMathImage(
	request: MathImageRenderRequest,
	maxHeightPx: number,
	document: number,
	occurrence: string,
	onChange?: () => void,
): ImagePresentation {
	const context = getImageRenderContext();
	const renderer = getMathImageRenderer();
	const owner = currentOwner;
	if (!context || !renderer || !owner) return fallback;
	if (!Number.isInteger(request.cellWidthPx) || !Number.isInteger(request.cellHeightPx) || request.tex.length > 20000)
		return fallback;
	if (
		![request.cellWidthPx, request.cellHeightPx, request.pixelsPerEx, request.maxWidthPx, maxHeightPx].every(
			value => Number.isFinite(value) && value > 0,
		)
	)
		return fallback;
	const maxWidthPx = Math.floor(Math.min(4096, request.maxWidthPx) / request.cellWidthPx) * request.cellWidthPx;
	maxHeightPx = Math.floor(Math.min(4096, maxHeightPx) / request.cellHeightPx) * request.cellHeightPx;
	if (!maxWidthPx || !maxHeightPx) return fallback;
	const logicalPath = `${document}:${occurrence}`;
	const existing = owner.slots.get(logicalPath);
	const svgKey =
		existing?.request === request && existing.svgKey
			? existing.svgKey
			: Bun.hash(JSON.stringify([getMathImageGeneration(), renderer.id, request])).toString(16);
	const key =
		existing?.request === request && existing.maxHeightPx === maxHeightPx
			? existing.key
			: `${svgKey}:${maxWidthPx}:${maxHeightPx}:1`;
	const path =
		isImageMeasureRender() && existing && existing.key !== key ? `measure:${logicalPath}:${key}` : logicalPath;
	owner.seen.add(path);
	let slot = owner.slots.get(path);
	if (slot && (slot.key !== key || slot.budget !== context.budget)) {
		release(slot);
		owner.slots.delete(path);
		slot = undefined;
	}
	if (!slot) {
		slot = {
			key,
			placement: `math:${owner.id}:${path}:${key}`,
			budget: context.budget,
			pending: false,
			change: onChange ?? owner.changed,
		};
		owner.slots.set(path, slot);
	}
	slot.change = onChange ?? owner.changed;
	slot.request = request;
	slot.svgKey = svgKey;
	slot.maxHeightPx = maxHeightPx;
	const raster = slot.raster ?? pngCache.get(key);
	if (raster) {
		slot.pending = false;
		slot.raster = raster;
		const retained = slot;
		slot.image ??= new Image(
			raster.base64,
			"image/png",
			{ fallbackColor: text => text },
			{
				budget: context.budget,
				imageKey: slot.placement,
				requestRender: () => {
					retained.pending = false;
					owner.pending = [...owner.slots.values()].some(value => value.pending);
					retained.change();
				},
				maxWidthCells: raster.widthPx / request.cellWidthPx,
				maxHeightCells: raster.heightPx / request.cellHeightPx,
			},
			raster,
		);
		const presentation = slot.image.renderPresentation(maxWidthPx / request.cellWidthPx + 2);
		context.budget.setMathRetireHandler(slot.placement, () => {
			retained.image = undefined;
			retained.raster = undefined;
			retained.settled = true;
		});
		slot.pending = presentation.pending;
		owner.pending ||= presentation.pending;
		return presentation;
	}
	// An evicted shared record must not stay pinned by a suppressed/history occurrence.
	slot.image = undefined;
	if (slot.settled || negativeCache.has(key) || negativeCache.has(svgKey)) {
		slot.pending = false;
		slot.settled = true;
		return fallback;
	}
	let work = pending.get(key);
	if (!work) {
		work = { key, svgKey, request, maxHeightPx, generation: getMathImageGeneration(), listeners: new Set() };
		pending.set(key, work);
		queue.push(work);
		schedule();
	}
	if (!slot.listener) {
		const retained = slot;
		slot.listener = () => {
			retained.listener = undefined;
			retained.pending = false;
			retained.raster = pngCache.get(key);
			retained.settled = retained.raster === undefined;
			owner.pending = [...owner.slots.values()].some(value => value.pending);
			retained.change();
		};
		work.listeners.add(slot.listener);
	}
	slot.pending = true;
	owner.pending = true;
	return { lines: [], graphic: false, pending: true };
}
