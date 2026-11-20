/**
 * Stateful assembly of Vertex AI streamed function-call arguments
 * (`toolConfig.functionCallingConfig.streamFunctionCallArguments: true`).
 *
 * Vertex streams arguments as RFC 9535 JSONPath-addressed `partialArgs` leaves
 * (plus valueless `[]` / `{}` container markers) across multiple SSE parts,
 * bounded by outer `functionCall.willContinue` and inner string `willContinue`.
 *
 * Downstream OMP consumers (`edit.openArgStream`, `ToolArgsRevealController`,
 * `proxy.ts`, speculative execution) expect append-only JSON text deltas and
 * `kStreamingPartialJson` whose concatenated JSON matches `toolCall.arguments`.
 * This accumulator maintains both the structured arguments object and a
 * stack-based JSON delta emitter, rejecting non-linear revisits rather than
 * allowing deltas and final arguments to diverge.
 */

import { parseStreamingJsonThrottled } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { AssistantMessage, ToolCall } from "../types";
import {
	clearStreamingPartialJson,
	kStreamingLastParseLen,
	kStreamingPartialJson,
	type StreamingPartialJsonCarrier,
} from "../utils/block-symbols";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import type { FinishReason, Part, PartialArg } from "./google-types";

type PathSegment = string | number;
type ContainerMarker = "array" | "object" | null;

interface ParsedJsonPath {
	segments: PathSegment[];
	containerMarker: ContainerMarker;
}

interface StackEntry {
	segment: PathSegment;
	isArray: boolean;
	childCount: number;
	closedChildren: Set<PathSegment>;
}

type ResolvedPartialValue =
	| { kind: "string"; value: string; json: string }
	| { kind: "primitive"; value: number | boolean | null; json: string };

type StreamedToolCallBlock = ToolCall &
	StreamingPartialJsonCarrier & {
		[kStreamingLastParseLen]?: number;
	};

interface ActiveStreamedToolCall {
	toolCall: StreamedToolCallBlock;
	contentIndex: number;
	accumulator: GooglePartialArgsAccumulator;
}

const MAX_ARRAY_INDEX = 2 ** 32 - 2;
const MAX_PATH_DEPTH = 64;
const CANONICAL_INDEX_RE = /^(?:0|[1-9]\d*)$/;

function isRfc9535BlankSpace(ch: string): boolean {
	return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defineOwnProperty(obj: Record<string | number, unknown>, key: string | number, value: unknown): void {
	Object.defineProperty(obj, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	});
}

function getOwnNestedValue(
	root: Record<string, unknown>,
	segments: readonly PathSegment[],
): { found: boolean; value: unknown } {
	let current: unknown = root;
	for (const seg of segments) {
		if (current === null || typeof current !== "object") return { found: false, value: undefined };
		if (!Object.hasOwn(current, seg)) return { found: false, value: undefined };
		current = (current as Record<string | number, unknown>)[seg];
	}
	return { found: true, value: current };
}

function setOwnNestedValue(root: Record<string, unknown>, segments: readonly PathSegment[], value: unknown): void {
	let current: Record<string | number, unknown> = root;
	for (let i = 0; i < segments.length - 1; i++) {
		const seg = segments[i];
		const nextSeg = segments[i + 1];
		if (!Object.hasOwn(current, seg) || current[seg] === null || current[seg] === undefined) {
			defineOwnProperty(current, seg, typeof nextSeg === "number" ? [] : {});
		}
		current = current[seg] as Record<string | number, unknown>;
	}
	defineOwnProperty(current, segments[segments.length - 1], value);
}

function samePath(a: readonly PathSegment[], b: readonly PathSegment[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function escapeJsonStringBody(value: string): string {
	return JSON.stringify(value).slice(1, -1);
}

/**
 * Parse an RFC 9535 JSONPath used by Vertex `partialArgs`, including quoted
 * bracket keys (`$["a.b"]`, `$['a-b']`), optional RFC 9535 inter-segment
 * whitespace, numeric array indices (`$[0]`), and Vertex's terminal container
 * markers (`$.tags[]`, `$.emptyObj{}`, `$.items[0]{}`).
 */
export function parsePartialArgPath(rawPath: string): ParsedJsonPath {
	if (rawPath.length === 0 || rawPath[0] !== "$") {
		throw new Error(`Invalid partialArgs JSONPath (must start with '$'): ${JSON.stringify(rawPath)}`);
	}

	const segments: PathSegment[] = [];
	let containerMarker: ContainerMarker = null;
	let i = 1;

	const skipBlank = (): void => {
		while (i < rawPath.length && isRfc9535BlankSpace(rawPath[i])) i++;
	};

	const pushSegment = (seg: PathSegment): void => {
		if (segments.length >= MAX_PATH_DEPTH) {
			throw new Error(`partialArgs JSONPath depth exceeds limit (${MAX_PATH_DEPTH}): ${JSON.stringify(rawPath)}`);
		}
		segments.push(seg);
	};

	while (i < rawPath.length) {
		const beforeBlank = i;
		skipBlank();
		if (i === rawPath.length) {
			if (i > beforeBlank) {
				throw new Error(`Invalid partialArgs JSONPath (trailing whitespace): ${JSON.stringify(rawPath)}`);
			}
			break;
		}
		const ch = rawPath[i];
		if (ch === ".") {
			i++;
			const start = i;
			while (
				i < rawPath.length &&
				rawPath[i] !== "." &&
				rawPath[i] !== "[" &&
				rawPath[i] !== "{" &&
				!isRfc9535BlankSpace(rawPath[i])
			) {
				i++;
			}
			if (i === start) {
				throw new Error(`Invalid partialArgs JSONPath (empty dot segment): ${JSON.stringify(rawPath)}`);
			}
			pushSegment(rawPath.slice(start, i));
			continue;
		}

		if (ch === "[") {
			if (rawPath[i + 1] === "]") {
				i += 2;
				if (i !== rawPath.length) {
					throw new Error(`Invalid partialArgs JSONPath (non-terminal '[]'): ${JSON.stringify(rawPath)}`);
				}
				containerMarker = "array";
				break;
			}

			i++;
			skipBlank();
			const next = rawPath[i];
			if (next === '"' || next === "'") {
				const quote = next;
				i++;
				let decoded = "";
				let closed = false;
				while (i < rawPath.length) {
					const c = rawPath[i];
					if (c === quote) {
						i++;
						closed = true;
						break;
					}
					if (c === "\\") {
						i++;
						if (i >= rawPath.length) {
							throw new Error(`Invalid partialArgs JSONPath (unterminated escape): ${JSON.stringify(rawPath)}`);
						}
						const esc = rawPath[i++];
						switch (esc) {
							case '"':
							case "'":
							case "\\":
							case "/":
								decoded += esc;
								break;
							case "b":
								decoded += "\b";
								break;
							case "f":
								decoded += "\f";
								break;
							case "n":
								decoded += "\n";
								break;
							case "r":
								decoded += "\r";
								break;
							case "t":
								decoded += "\t";
								break;
							case "u": {
								const hex = rawPath.slice(i, i + 4);
								if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
									throw new Error(
										`Invalid partialArgs JSONPath (invalid \\u escape): ${JSON.stringify(rawPath)}`,
									);
								}
								decoded += String.fromCharCode(Number.parseInt(hex, 16));
								i += 4;
								break;
							}
							default:
								throw new Error(
									`Invalid partialArgs JSONPath (invalid escape '\\${esc}'): ${JSON.stringify(rawPath)}`,
								);
						}
						continue;
					}
					decoded += c;
					i++;
				}
				skipBlank();
				if (!closed || rawPath[i] !== "]") {
					throw new Error(`Invalid partialArgs JSONPath (unclosed quoted bracket): ${JSON.stringify(rawPath)}`);
				}
				i++;
				pushSegment(decoded);
				continue;
			}

			const start = i;
			while (i < rawPath.length && rawPath[i] !== "]" && !isRfc9535BlankSpace(rawPath[i])) {
				i++;
			}
			const indexText = rawPath.slice(start, i);
			skipBlank();
			if (i >= rawPath.length || rawPath[i] !== "]" || indexText.length === 0) {
				throw new Error(`Invalid partialArgs JSONPath (malformed bracket index): ${JSON.stringify(rawPath)}`);
			}
			i++;
			if (!CANONICAL_INDEX_RE.test(indexText)) {
				throw new Error(`Invalid partialArgs JSONPath (non-integer array index): ${JSON.stringify(rawPath)}`);
			}
			const index = Number(indexText);
			if (!Number.isSafeInteger(index) || index > MAX_ARRAY_INDEX) {
				throw new Error(`Invalid partialArgs JSONPath (array index out of range): ${JSON.stringify(rawPath)}`);
			}
			pushSegment(index);
			continue;
		}

		if (ch === "{") {
			if (rawPath[i + 1] === "}" && i + 2 === rawPath.length) {
				containerMarker = "object";
				i += 2;
				break;
			}
			throw new Error(`Invalid partialArgs JSONPath (malformed '{}' marker): ${JSON.stringify(rawPath)}`);
		}

		throw new Error(`Invalid partialArgs JSONPath (unexpected token '${ch}'): ${JSON.stringify(rawPath)}`);
	}

	return { segments, containerMarker };
}

function normalizeAndValidateSegments(root: Record<string, unknown>, segments: PathSegment[], rawPath: string): void {
	let current: unknown = root;
	for (let i = 0; i < segments.length; i++) {
		let seg = segments[i];
		if (Array.isArray(current) && typeof seg === "string" && CANONICAL_INDEX_RE.test(seg)) {
			const index = Number(seg);
			if (Number.isSafeInteger(index) && index <= MAX_ARRAY_INDEX) {
				seg = index;
				segments[i] = index;
			}
		}

		if (typeof seg === "number") {
			if (current !== undefined && !Array.isArray(current)) {
				throw new Error(`Conflicting partialArgs path (array index on non-array): ${JSON.stringify(rawPath)}`);
			}
			const length = Array.isArray(current) ? current.length : 0;
			if (seg > length) {
				throw new Error(
					`Sparse array index ${seg} exceeds current length ${length} in partialArgs path ${JSON.stringify(rawPath)}`,
				);
			}
		} else {
			if (Array.isArray(current)) {
				throw new Error(`Conflicting partialArgs path (object key on array): ${JSON.stringify(rawPath)}`);
			}
			if (current !== undefined && (current === null || typeof current !== "object")) {
				throw new Error(`Conflicting partialArgs path (property access on primitive): ${JSON.stringify(rawPath)}`);
			}
		}

		current =
			current !== null && typeof current === "object" && Object.hasOwn(current, seg)
				? (current as Record<string | number, unknown>)[seg]
				: undefined;
	}
}

function resolvePartialArgValue(arg: PartialArg): ResolvedPartialValue | undefined {
	let resolved: ResolvedPartialValue | undefined;
	let count = 0;

	if (arg.stringValue !== undefined && arg.stringValue !== null) {
		if (typeof arg.stringValue !== "string") {
			throw new Error("Invalid partialArgs entry: stringValue must be a string");
		}
		resolved = { kind: "string", value: arg.stringValue, json: JSON.stringify(arg.stringValue) };
		count++;
	}
	if (arg.numberValue !== undefined && arg.numberValue !== null) {
		if (typeof arg.numberValue !== "number" || !Number.isFinite(arg.numberValue)) {
			throw new Error("Invalid partialArgs entry: numberValue must be a finite number");
		}
		resolved = { kind: "primitive", value: arg.numberValue, json: JSON.stringify(arg.numberValue) };
		count++;
	}
	if (arg.boolValue !== undefined && arg.boolValue !== null) {
		if (typeof arg.boolValue !== "boolean") {
			throw new Error("Invalid partialArgs entry: boolValue must be a boolean");
		}
		resolved = { kind: "primitive", value: arg.boolValue, json: JSON.stringify(arg.boolValue) };
		count++;
	}
	if (Object.hasOwn(arg, "nullValue") && arg.nullValue !== undefined) {
		resolved = { kind: "primitive", value: null, json: "null" };
		count++;
	}

	if (count > 1) {
		throw new Error(`Invalid partialArgs entry: multiple value fields set for ${JSON.stringify(arg.jsonPath)}`);
	}
	return resolved;
}

/**
 * Incrementally assembles Vertex `partialArgs` entries into both a structured
 * object and an append-only JSON text delta stream. Rejects non-linear revisits
 * so emitted JSON deltas and `arguments()` never silently diverge.
 */
export class GooglePartialArgsAccumulator {
	readonly #args: Record<string, unknown> = {};
	readonly #stack: StackEntry[] = [];
	#openStringPath: PathSegment[] | null = null;

	/** True while a chunked `stringValue` has received `willContinue: true` and has not yet closed. */
	hasOpenString(): boolean {
		return this.#openStringPath !== null;
	}

	/** Authoritative assembled arguments object. */
	arguments(): Record<string, unknown> {
		return this.#args;
	}

	/** Apply a batch of `partialArgs` and return the append-only JSON text delta. */
	processPartialArgs(partialArgs: readonly PartialArg[]): string {
		let delta = "";

		for (const arg of partialArgs) {
			if (typeof arg.jsonPath !== "string" || arg.jsonPath.length === 0) {
				throw new Error("Invalid partialArgs entry: missing jsonPath");
			}
			const parsed = parsePartialArgPath(arg.jsonPath);
			const resolved = resolvePartialArgValue(arg);

			if (parsed.containerMarker !== null && (resolved !== undefined || arg.willContinue === true)) {
				throw new Error(
					`Invalid partialArgs container marker with value or continuation: ${JSON.stringify(arg.jsonPath)}`,
				);
			}

			if (parsed.segments.length === 0) {
				if (resolved !== undefined || arg.willContinue === true) {
					throw new Error(`Invalid partialArgs root path: ${JSON.stringify(arg.jsonPath)}`);
				}
				continue;
			}

			normalizeAndValidateSegments(this.#args, parsed.segments, arg.jsonPath);
			const existing = getOwnNestedValue(this.#args, parsed.segments);

			// Valueless entry: container marker (`[]` / `{}`) or string terminator.
			if (resolved === undefined) {
				if (parsed.containerMarker !== null) {
					if (existing.found) {
						if (parsed.containerMarker === "array" && !Array.isArray(existing.value)) {
							throw new Error(`Conflicting array marker for non-array path: ${JSON.stringify(arg.jsonPath)}`);
						}
						if (parsed.containerMarker === "object" && !isPlainObject(existing.value)) {
							throw new Error(`Conflicting object marker for non-object path: ${JSON.stringify(arg.jsonPath)}`);
						}
						// Populated container terminator (e.g. `$.tags[]` or `$.items[0]{}`): keep container intact.
						continue;
					}
					const isArray = parsed.containerMarker === "array";
					delta += this.#emitContainer(parsed.segments, isArray, arg.jsonPath);
					setOwnNestedValue(this.#args, parsed.segments, isArray ? [] : {});
					continue;
				}

				if (existing.found) {
					if (typeof existing.value === "string" && arg.willContinue !== true) {
						if (this.#openStringPath && samePath(this.#openStringPath, parsed.segments)) {
							delta += this.#closeOpenString();
						}
					}
					continue;
				}
				if (arg.willContinue === true) continue;

				delta += this.#emitContainer(parsed.segments, false, arg.jsonPath);
				setOwnNestedValue(this.#args, parsed.segments, {});
				continue;
			}

			// String continuation on an existing path.
			if (resolved.kind === "string" && existing.found) {
				if (typeof existing.value !== "string") {
					throw new Error(`Conflicting string continuation on non-string path: ${JSON.stringify(arg.jsonPath)}`);
				}
				if (this.#openStringPath && samePath(this.#openStringPath, parsed.segments)) {
					setOwnNestedValue(this.#args, parsed.segments, existing.value + resolved.value);
					delta += escapeJsonStringBody(resolved.value);
					if (arg.willContinue !== true) {
						delta += this.#closeOpenString();
					}
					continue;
				}
				// A late empty-string terminator after the string already closed changes nothing.
				if (resolved.value === "" && arg.willContinue !== true) {
					continue;
				}
				throw new Error(`Out-of-order string continuation for closed path: ${JSON.stringify(arg.jsonPath)}`);
			}

			// Non-string write to an already-populated path would contradict already-emitted JSON deltas.
			if (existing.found) {
				if (existing.value !== null && typeof existing.value === "object") {
					throw new Error(`Conflicting primitive value for container path: ${JSON.stringify(arg.jsonPath)}`);
				}
				throw new Error(`Duplicate non-linear partialArgs write for path: ${JSON.stringify(arg.jsonPath)}`);
			}

			delta += this.#emitLeafNavigation(parsed.segments, resolved, arg.willContinue === true, arg.jsonPath);
			setOwnNestedValue(this.#args, parsed.segments, resolved.value);
		}

		return delta;
	}

	/** Close any open string and remaining containers, returning the closing JSON delta. */
	finalize(): string {
		if (this.#stack.length === 0) {
			return Object.keys(this.#args).length === 0 ? "{}" : "";
		}
		return this.#closeOpenString() + this.#closeDownTo(0);
	}

	#closeOpenString(): string {
		if (!this.#openStringPath) return "";
		this.#openStringPath = null;
		return '"';
	}

	#ensureRoot(): string {
		if (this.#stack.length === 0) {
			this.#stack.push({ segment: "", isArray: false, childCount: 0, closedChildren: new Set() });
			return "{";
		}
		return "";
	}

	#findCommonStackDepth(targetContainer: readonly PathSegment[]): number {
		const maxDepth = Math.min(this.#stack.length - 1, targetContainer.length);
		let common = 0;
		for (let i = 0; i < maxDepth; i++) {
			if (this.#stack[i + 1].segment === targetContainer[i]) {
				common++;
			} else {
				break;
			}
		}
		return common + 1;
	}

	#closeDownTo(targetDepth: number): string {
		let fragment = "";
		while (this.#stack.length > targetDepth) {
			const entry = this.#stack.pop();
			if (!entry) break;
			const parent = this.#stack[this.#stack.length - 1];
			if (parent) parent.closedChildren.add(entry.segment);
			fragment += entry.isArray ? "]" : "}";
		}
		return fragment;
	}

	#assertCanOpenLinearly(targetContainer: readonly PathSegment[], rawPath: string): void {
		if (this.#stack.length === 0) return;
		const commonDepth = this.#findCommonStackDepth(targetContainer);
		const nextSeg = targetContainer[commonDepth - 1];
		if (nextSeg === undefined) return;
		const commonParent = this.#stack[commonDepth - 1];
		if (commonParent?.closedChildren.has(nextSeg)) {
			throw new Error(`Out-of-order partialArgs revisit of closed container: ${JSON.stringify(rawPath)}`);
		}
	}

	#openDownTo(targetContainer: readonly PathSegment[], leafSegment: PathSegment): string {
		let fragment = "";
		const startIdx = this.#stack.length - 1;

		for (let i = startIdx; i < targetContainer.length; i++) {
			const seg = targetContainer[i];
			const parent = this.#stack[this.#stack.length - 1];
			if (parent.childCount > 0) fragment += ",";
			parent.childCount++;

			if (typeof seg === "string") {
				fragment += `${JSON.stringify(seg)}:`;
			}

			const childSeg = i + 1 < targetContainer.length ? targetContainer[i + 1] : leafSegment;
			const isArray = typeof childSeg === "number";
			fragment += isArray ? "[" : "{";

			this.#stack.push({
				segment: seg,
				isArray,
				childCount: 0,
				closedChildren: new Set(),
			});
		}

		return fragment;
	}

	#assertNoOpenString(nextPath: string): void {
		if (this.#openStringPath !== null) {
			throw new Error(
				`Previous streamed string argument was not terminated before partialArgs path: ${JSON.stringify(nextPath)}`,
			);
		}
	}

	#emitContainer(targetSegments: readonly PathSegment[], isArray: boolean, rawPath: string): string {
		this.#assertNoOpenString(rawPath);
		this.#assertCanOpenLinearly(targetSegments, rawPath);
		let fragment = this.#ensureRoot();
		const commonDepth = this.#findCommonStackDepth(targetSegments);
		fragment += this.#closeDownTo(commonDepth);
		fragment += this.#openDownTo(targetSegments, isArray ? 0 : "");
		return fragment;
	}

	#emitLeafNavigation(
		targetSegments: readonly PathSegment[],
		resolved: ResolvedPartialValue,
		continueString: boolean,
		rawPath: string,
	): string {
		const targetContainer = targetSegments.slice(0, -1);
		const leafSegment = targetSegments[targetSegments.length - 1];
		this.#assertNoOpenString(rawPath);
		this.#assertCanOpenLinearly(targetContainer, rawPath);

		let fragment = this.#ensureRoot();
		const commonDepth = this.#findCommonStackDepth(targetContainer);
		fragment += this.#closeDownTo(commonDepth);
		fragment += this.#openDownTo(targetContainer, leafSegment);

		const container = this.#stack[this.#stack.length - 1];
		if (container.childCount > 0) fragment += ",";
		container.childCount++;

		if (typeof leafSegment === "string") {
			fragment += `${JSON.stringify(leafSegment)}:`;
		}

		if (resolved.kind === "string" && continueString) {
			fragment += resolved.json.slice(0, -1);
			this.#openStringPath = [...targetSegments];
		} else {
			fragment += resolved.json;
		}
		return fragment;
	}
}

/**
 * Manages complete and streamed Google/Vertex `functionCall` parts within one
 * `consumeGoogleStream` response, emitting `toolcall_start`, incremental
 * `toolcall_delta`, and `toolcall_end` events while maintaining `kStreamingPartialJson`
 * and `thoughtSignature` across fragments.
 */
export class GoogleFunctionCallStream {
	readonly #output: AssistantMessage;
	readonly #stream: AssistantMessageEventStream;
	readonly #provider: string;
	readonly #allocateId: (name: string) => string;
	readonly #retainSignature: (existing: string | undefined, incoming: string | undefined) => string | undefined;
	readonly #pushComplete: (toolCall: ToolCall, contentIndex: number) => void;
	#active: ActiveStreamedToolCall | null = null;
	#hadAbandonedCall = false;

	constructor(args: {
		output: AssistantMessage;
		stream: AssistantMessageEventStream;
		provider: string;
		allocateId: (name: string) => string;
		retainSignature: (existing: string | undefined, incoming: string | undefined) => string | undefined;
		pushComplete: (toolCall: ToolCall, contentIndex: number) => void;
	}) {
		this.#output = args.output;
		this.#stream = args.stream;
		this.#provider = args.provider;
		this.#allocateId = args.allocateId;
		this.#retainSignature = args.retainSignature;
		this.#pushComplete = args.pushComplete;
	}

	hasActiveCall(): boolean {
		return this.#active !== null;
	}

	/** Fold one `part` that has `part.functionCall` set. */
	push(part: Part, options?: { deferFinalize?: boolean }): void {
		const fc = part.functionCall;
		if (!fc) return;
		const deferFinalize = options?.deferFinalize === true;

		// ProtoJSON encodes unset repeated/message fields as `null`; normalize before validating.
		const rawPartialArgs = fc.partialArgs === null ? undefined : fc.partialArgs;
		if (rawPartialArgs !== undefined && !Array.isArray(rawPartialArgs)) {
			throw this.#protocolError("Received malformed functionCall.partialArgs (expected an array)");
		}

		const name = typeof fc.name === "string" && fc.name.length > 0 ? fc.name : undefined;
		const partialArgs = rawPartialArgs && rawPartialArgs.length > 0 ? rawPartialArgs : undefined;
		const willContinue = fc.willContinue === true;
		const completeArgs = fc.args === null ? undefined : fc.args;
		const hasCompleteArgs = completeArgs !== undefined;

		if (hasCompleteArgs && (partialArgs !== undefined || willContinue)) {
			throw this.#protocolError("Received functionCall combining complete args with partialArgs or willContinue");
		}

		// Ordinary single-chunk complete call (non-streaming mode, model ignored flag,
		// or proto-serialized empty/null `partialArgs` beside `args`).
		if (hasCompleteArgs) {
			if (this.#active) {
				throw this.#protocolError("Received a new functionCall before the previous streamed functionCall finished");
			}
			const toolCall = this.#createToolCall(name ?? "", fc.id, completeArgs, part.thoughtSignature);
			this.#output.content.push(toolCall);
			this.#pushComplete(toolCall, this.#output.content.length - 1);
			return;
		}

		// Single-chunk no-args call when `streamFunctionCallArguments` is enabled:
		// Vertex emits `{ name, id }` with no `args`, no `partialArgs`, no `willContinue`,
		// and attaches the turn's `thoughtSignature` here if it is the first call.
		if (name !== undefined && !partialArgs && !willContinue && !deferFinalize) {
			if (this.#active) {
				throw this.#protocolError("Received a new functionCall before the previous streamed functionCall finished");
			}
			const toolCall = this.#createToolCall(name, fc.id, {}, part.thoughtSignature);
			this.#output.content.push(toolCall);
			this.#pushComplete(toolCall, this.#output.content.length - 1);
			return;
		}

		// Start of a streamed call (`name` present with `willContinue: true`, `partialArgs`, or deferred terminal check).
		if (name !== undefined) {
			if (this.#active) {
				throw this.#protocolError("Received a new functionCall before the previous streamed functionCall finished");
			}
			const toolCall: StreamedToolCallBlock = {
				...this.#createToolCall(name, fc.id, {}, part.thoughtSignature),
				[kStreamingPartialJson]: "",
			};
			this.#output.content.push(toolCall);
			const contentIndex = this.#output.content.length - 1;
			this.#stream.push({ type: "toolcall_start", contentIndex, partial: this.#output });
			this.#active = {
				toolCall,
				contentIndex,
				accumulator: new GooglePartialArgsAccumulator(),
			};

			if (partialArgs) {
				this.#applyPartialArgs(this.#active, partialArgs);
			}
			if (!willContinue && !deferFinalize) {
				this.#finalizeActive();
			}
			return;
		}

		// Continuation or terminal chunk for the active streamed call.
		if (!this.#active) {
			throw this.#protocolError("Received streamed functionCall fragment without an open functionCall");
		}

		const retainedSig = this.#retainSignature(this.#active.toolCall.thoughtSignature, part.thoughtSignature);
		if (retainedSig) {
			this.#active.toolCall.thoughtSignature = retainedSig;
		}

		if (partialArgs) {
			this.#applyPartialArgs(this.#active, partialArgs);
		}

		if (!willContinue && !deferFinalize) {
			this.#finalizeActive();
		}
	}

	/**
	 * Handle a candidate `finishReason` while a streamed call may still be open.
	 * Returns `true` if an in-flight call was truncated (so the caller keeps
	 * `stopReason: "length"` instead of upgrading to `"toolUse"`). The truncated
	 * block stays in `output.content` at its emitted index so downstream consumers
	 * (`agent-loop`, TUI cards) settle it with a skipped `"length"` result.
	 */
	finish(finishReason: FinishReason): boolean {
		if (!this.#active) return this.#hadAbandonedCall;

		if (finishReason === "STOP") {
			// Vertex occasionally ends the stream with `finishReason: STOP` without a
			// separate empty terminal `functionCall` chunk; `#finalizeActive` rejects
			// any still-open string argument on every completion path.
			this.#finalizeActive();
			return this.#hadAbandonedCall;
		}

		// MAX_TOKENS, CONTINUATION (without resume token), SAFETY, MALFORMED_FUNCTION_CALL, etc.:
		// keep the block at its emitted index (no splice), clear transient partialJson,
		// and never emit `toolcall_end` for a truncated or errored call.
		this.#abandonActive();
		return true;
	}

	/** Ensure no `toolCall` block leaks transient `kStreamingPartialJson` on error or abort. */
	cleanupPartialJson(): void {
		for (const block of this.#output.content) {
			if (block.type === "toolCall") {
				clearStreamingPartialJson(block);
			}
		}
	}

	#createToolCall(
		name: string,
		providedId: string | undefined,
		args: Record<string, unknown> | undefined,
		thoughtSignature: string | undefined,
	): ToolCall {
		const needsNewId = !providedId || this.#output.content.some(b => b.type === "toolCall" && b.id === providedId);
		const id = needsNewId ? this.#allocateId(name || "tool") : providedId;
		return {
			type: "toolCall",
			id,
			name,
			arguments: args ?? {},
			...(thoughtSignature && { thoughtSignature }),
		};
	}

	#applyPartialArgs(active: ActiveStreamedToolCall, partialArgs: readonly PartialArg[]): void {
		let delta: string;
		try {
			delta = active.accumulator.processPartialArgs(partialArgs);
		} catch (error) {
			this.#abandonActive();
			throw this.#protocolError(error instanceof Error ? error.message : String(error));
		}
		if (delta.length === 0) return;

		const nextPartialJson = (active.toolCall[kStreamingPartialJson] ?? "") + delta;
		active.toolCall[kStreamingPartialJson] = nextPartialJson;
		const throttled = parseStreamingJsonThrottled(nextPartialJson, active.toolCall[kStreamingLastParseLen] ?? 0);
		if (throttled) {
			active.toolCall.arguments = throttled.value;
			active.toolCall[kStreamingLastParseLen] = throttled.parsedLen;
		}
		this.#stream.push({
			type: "toolcall_delta",
			contentIndex: active.contentIndex,
			delta,
			partial: this.#output,
		});
	}

	#finalizeActive(): void {
		const active = this.#active;
		if (!active) return;

		if (active.accumulator.hasOpenString()) {
			this.#abandonActive();
			throw this.#protocolError("Streamed functionCall ended while a string argument was still open");
		}

		this.#active = null;

		const closingDelta = active.accumulator.finalize();
		if (closingDelta.length > 0) {
			active.toolCall[kStreamingPartialJson] = (active.toolCall[kStreamingPartialJson] ?? "") + closingDelta;
			active.toolCall.arguments = active.accumulator.arguments();
			this.#stream.push({
				type: "toolcall_delta",
				contentIndex: active.contentIndex,
				delta: closingDelta,
				partial: this.#output,
			});
		}

		active.toolCall.arguments = active.accumulator.arguments();
		clearStreamingPartialJson(active.toolCall);
		this.#stream.push({
			type: "toolcall_end",
			contentIndex: active.contentIndex,
			toolCall: active.toolCall,
			partial: this.#output,
		});
	}

	#abandonActive(): void {
		const active = this.#active;
		if (!active) return;
		this.#active = null;
		this.#hadAbandonedCall = true;
		clearStreamingPartialJson(active.toolCall);
	}

	#protocolError(message: string): AIError.ProviderResponseError {
		return new AIError.ProviderResponseError(`Google streamed functionCall error: ${message}`, {
			provider: this.#provider,
			kind: "output",
		});
	}
}
