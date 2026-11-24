/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Write: the file's content as numbered code under `Write path · N lines`
 * (executable and diagnostics chips once written), a drawing for figure
 * files (svg, mermaid, 3D) above the source, and LSP diagnostics. Writes to
 * `agent://`, `proc://` and `cfg://` URLs are a peer message, process input
 * or a setting change instead.
 *
 * Terminal looks: `write` (files) and `write-card` (URL writes), both in
 * `src/ui/styles/tools/write.ts`.
 */
import * as path from "node:path";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { shortenHome } from "@oh-my-pi/pi-tui/text/sanitize";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type {
	ToolActivity,
	ToolFigure,
	ToolHead,
	ToolPresenter,
	ToolResult,
	ToolView,
	ToolViewState,
} from "./contract";
import { cleanText, ErrorText, NoteText } from "./agent-common";
import { resultText } from "./default";
import {
	countLines,
	DiagnosticsSection,
	diagnosticsBadge,
	displayPath,
	type FileDiagnostics,
	fileHref,
	pendingLinkPath,
} from "./file-common";
import { registerToolPresenter } from "./registry";

export interface WriteArgs {
	readonly path?: unknown;
	readonly file_path?: unknown;
	readonly content?: unknown;
}

interface Receipt {
	readonly to: string;
	readonly outcome: "delivered" | "woken" | "revived" | "queued" | "failed" | (string & {});
	readonly error?: string;
}

export interface WriteDetails {
	readonly diagnostics?: FileDiagnostics;
	readonly madeExecutable?: boolean;
	readonly resolvedPath?: string;
	readonly message?: {
		readonly to?: string;
		readonly receipts?: readonly Receipt[];
	};
	readonly proc?: unknown;
	readonly cfg?: {
		readonly path?: string;
		readonly save?: boolean;
		readonly previous?: string;
		readonly value?: string;
		readonly outcome?: "applied" | "declined" | "unchanged";
		readonly effective?: string;
	};
	readonly touchesNoFiles?: boolean;
}

/** Collapsed native body: the first lines of the file. */
const WRITE_PREVIEW = { lines: 8 } as const;
/** Collapsed clamp of a write drawn as a figure. */
const FIGURE_PREVIEW = { lines: 26 } as const;

/** Fence language per extension of a written file the transcript draws as a figure. */
const FIGURE_FENCES: Readonly<Record<string, string>> = {
	svg: "svg",
	mmd: "mermaid",
	mermaid: "mermaid",
	obj: "obj",
	ply: "ply",
	wrl: "wrl",
	vrml: "vrml",
	x3dv: "x3dv",
	stl: "stl",
	gltf: "gltf",
	usda: "usda",
	usd: "usd",
};

type CardKind = "message" | "proc" | "cfg";
const CARD_SCHEMES: Record<string, CardKind> = {
	agent: "message",
	proc: "proc",
	cfg: "cfg",
};

function rawPathOf(args: WriteArgs | undefined): string {
	return typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
}

function contentOf(args: WriteArgs | undefined): string {
	const content = args?.content;
	const text =
		typeof content === "string" ? content : content === undefined || content === null ? "" : String(content);
	return text.replace(/\r/g, "");
}

function splitScheme(raw: string): { scheme: string; rest: string } | undefined {
	const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is.exec(raw);
	return match ? { scheme: match[1]!.toLowerCase(), rest: match[2]! } : undefined;
}

/** The URL card a write to `raw` shows (result details name it before the scheme does). */
function urlCard(raw: string, details?: WriteDetails): { kind: CardKind; target: string } | undefined {
	const url = splitScheme(raw);
	const target = url?.rest ?? "";
	if (details) {
		if (details.message !== undefined) return { kind: "message", target };
		if (details.proc !== undefined) return { kind: "proc", target };
		if (details.cfg !== undefined) return { kind: "cfg", target };
	}
	if (!url || !Object.hasOwn(CARD_SCHEMES, url.scheme)) return undefined;
	return { kind: CARD_SCHEMES[url.scheme]!, target };
}

/** Whether a streaming path is, or could still become, a card URL. */
function couldBecomeCardUrl(lower: string): boolean {
	for (const scheme in CARD_SCHEMES) {
		const prefix = `${scheme}://`;
		if (prefix.startsWith(lower) || lower.startsWith(prefix)) return true;
	}
	return false;
}

function procTarget(target: string): {
	id: string;
	action: "stdin" | "mode" | "kill";
} {
	if (target.endsWith("/kill")) return { id: target.slice(0, -5), action: "kill" };
	if (target.endsWith("/mode")) return { id: target.slice(0, -5), action: "mode" };
	return { id: target, action: "stdin" };
}

function toolHead(title: string, ...parts: (TspSpan | string | undefined)[]): TspSpan[] {
	const spans: TspSpan[] = [{ s: "toolTitle strong", t: title }];
	for (const part of parts) {
		if (part === undefined || part === "") continue;
		spans.push({ t: " " }, typeof part === "string" ? { s: "muted", t: part } : part);
	}
	return spans;
}

function QuotedPreview(props: { readonly body: string }): JSXNode {
	if (!props.body.trim()) return undefined;
	return <text role="omp.tool.proc.preview" spans={[{ s: "muted", t: cleanText(props.body) }]} wrap="word" />;
}

const RECEIPT_TONE: Record<string, TspTone> = {
	failed: "error",
	revived: "warning",
};

function messageView(target: string, body: string, result: ToolResult<WriteDetails> | undefined): ToolView {
	const details = result?.details?.message;
	const recipient = cleanText(details?.to || target || "…");
	const receipts = details?.receipts ?? [];
	const delivered = receipts.filter(receipt => receipt.outcome !== "failed").length;
	const failed = receipts.length - delivered;
	const meta: TspSpan[] = [];
	if (recipient === "all") meta.push({ s: "muted", t: "broadcast" });
	const tone = (outcome: string): TspTone => RECEIPT_TONE[outcome] ?? "success";
	if (receipts.length === 1) meta.push({ s: tone(receipts[0]!.outcome), t: receipts[0]!.outcome });
	else if (receipts.length > 1) {
		if (delivered) meta.push({ s: "success", t: `${delivered} delivered` });
		if (failed) meta.push({ s: "error", t: `${failed} failed` });
	}
	const error = result?.isError === true || (failed > 0 && delivered === 0);
	const icon = result === undefined ? "pending" : error ? "error" : "irc";
	const term = {
		look: "write-card",
		// The terminal head draws the broadcast note in the dim meta color.
		card: {
			icon,
			title: `IRC ➤ ${recipient}`,
			meta: meta.map(span => (span.t === "broadcast" ? { ...span, s: "dim" } : span)),
		},
	};
	const label = toolHead("IRC", { s: "accent", t: recipient }, ...meta);
	if (result?.isError && receipts.length === 0) {
		return {
			label,
			tone: "error",
			body: <ErrorText message={resultText(result) || "Message delivery failed."} />,
			term,
		};
	}
	return {
		label,
		tone: error ? "error" : undefined,
		body: [
			<QuotedPreview body={body} />,
			result !== undefined && receipts.length === 0 ? (
				<NoteText message={resultText(result) || "No live peers to broadcast to."} />
			) : undefined,
			receipts.length > 1 || failed > 0 ? (
				<list role="omp.tool.irc.receipts">
					{receipts.map(receipt => (
						<item
							key={receipt.to}
							label={[{ s: "toolOutput", t: cleanText(receipt.to) }]}
							value={[{ s: tone(receipt.outcome), t: receipt.outcome }]}
							detail={receipt.error ? [{ s: "error", t: cleanText(receipt.error) }] : undefined}
							tone={tone(receipt.outcome)}
						/>
					))}
				</list>
			) : undefined,
		],
		term,
	};
}

/** A `proc://` service as write results report it. */
interface ProcDaemon {
	readonly state?: string;
	readonly pid?: number;
	readonly startedAt?: number;
	readonly exitedAt?: number;
	readonly persist?: boolean;
	readonly detached?: boolean;
}

/** A background job as write results report it. */
interface ProcJob {
	readonly id: string;
	readonly type?: string;
	readonly status?: string;
	readonly label?: string;
	readonly durationMs?: number;
}

interface ProcDetails {
	readonly daemon?: ProcDaemon;
	readonly op?: string;
	readonly jobs?: readonly ProcJob[];
	readonly cancelled?: readonly { readonly id: string; readonly status: string }[];
}

/** A service's state and facts: `ready`, `pid 4123`, `up 13.2s`, `persistent`. */
function daemonFacts(daemon: ProcDaemon): TspSpan[] {
	const state = daemon.state ?? "unknown";
	const stateTone = state === "ready" || state === "running" ? "success" : state === "failed" ? "error" : "warning";
	const facts: TspSpan[] = [{ s: stateTone, t: state }];
	if (daemon.pid !== undefined) facts.push({ t: `pid ${daemon.pid}` });
	if (daemon.startedAt !== undefined)
		facts.push({
			t: `${daemon.exitedAt === undefined ? "up" : "ran"} ${formatDuration(Math.max(0, (daemon.exitedAt ?? Date.now()) - daemon.startedAt))}`,
		});
	if (daemon.detached) facts.push({ t: "detached" });
	else if (daemon.persist) facts.push({ t: "persistent" });
	return facts;
}

function CancelledJobs(props: { readonly details: ProcDetails }): JSXNode {
	const outcomes = props.details.cancelled ?? [];
	if (props.details.op !== "cancel" || outcomes.length === 0) return undefined;
	const jobs = props.details.jobs ?? [];
	return (
		<list role="omp.tool.proc.cancelled">
			{outcomes.map(outcome => {
				const job = jobs.find(item => item.id === outcome.id);
				const tone: TspTone = outcome.status === "cancelled" ? "warning" : "error";
				const value = [{ s: tone, t: outcome.status }];
				if (!job)
					return <item key={outcome.id} label={[{ s: "toolOutput", t: cleanText(outcome.id) }]} value={value} />;
				return (
					<item
						key={job.id}
						label={[{ s: "accent", t: job.type ?? "job" }, { t: " " }, { s: "toolOutput", t: cleanText(job.id) }]}
						detail={[{ s: "muted", t: cleanText(job.label ?? "") }]}
						value={value}
						tone={tone}
						term={{ status: job.status, durationMs: job.durationMs }}
					/>
				);
			})}
		</list>
	);
}

function procView(target: string, content: string | undefined, result: ToolResult<WriteDetails> | undefined): ToolView {
	const { id, action } = procTarget(target);
	const shown = cleanText(id || "…");
	const details = (result?.isError ? undefined : result?.details?.proc) as ProcDetails | undefined;
	const daemon = details?.daemon;
	const mode = action === "mode" && content ? cleanText(content) : undefined;
	const facts = daemon ? daemonFacts(daemon) : undefined;
	const label = toolHead(`Proc ${action}`, { s: "accent", t: shown }, facts ? facts.map(f => f.t).join(" · ") : mode);
	const icon = result === undefined ? "pending" : result.isError ? "error" : action === "kill" ? "aborted" : "success";
	const term = {
		look: "write-card",
		card: {
			icon,
			title: `Proc ${action} ${shown}`,
			meta: facts ?? (mode ? [{ t: mode }] : []),
		},
	};
	if (result?.isError)
		return {
			label,
			tone: "error",
			body: <ErrorText message={resultText(result) || "Process operation failed."} />,
			term,
		};
	return {
		label,
		tone: result !== undefined && action === "kill" ? "warning" : undefined,
		body: [
			content && action === "stdin" ? <QuotedPreview body={content} /> : undefined,
			details ? <CancelledJobs details={details} /> : undefined,
		],
		term,
	};
}

function cfgView(url: string, content: string | undefined, result: ToolResult<WriteDetails> | undefined): ToolView {
	const details = result?.details?.cfg;
	const target = splitScheme(url)?.rest ?? "";
	const save = details?.save ?? target.endsWith("/save");
	const settingPath = details?.path ?? target.replace(/\/save$/, "").replaceAll("/", ".");
	const badges: { label: string; color: string }[] = [
		{ label: save ? "persist" : "session", color: save ? "accent" : "muted" },
	];
	if (details?.outcome === "declined") badges.push({ label: "declined", color: "warning" });
	if (details?.outcome === "unchanged") badges.push({ label: "unchanged", color: "muted" });
	const icon =
		result === undefined
			? "pending"
			: result.isError
				? "error"
				: details?.outcome === "declined"
					? "warning"
					: "success";
	const term = {
		look: "write-card",
		card: { icon, title: "Config", description: settingPath, badges },
	};
	if (result?.isError) {
		return {
			label: toolHead("Config", settingPath),
			tone: "error",
			body: <ErrorText message={resultText(result) || "Settings write failed."} />,
			term: { ...term, card: { ...term.card, badges: [] } },
		};
	}
	const label = toolHead("Config", settingPath);
	label.push({ t: " " }, { s: save ? "accent strong" : "muted", t: save ? "persist" : "session" });
	if (details?.outcome === "declined") label.push({ t: " " }, { s: "warning strong", t: "declined" });
	if (details?.outcome === "unchanged") label.push({ t: " " }, { s: "muted", t: "unchanged" });
	const next: TspSpan = {
		s: "toolOutput",
		t: cleanText(details?.value ?? content?.trim() ?? "…"),
	};
	const change: TspSpan[] = details
		? [{ s: "dim", t: cleanText(details.previous ?? "") }, { s: "dim", t: " → " }, next]
		: [{ s: "dim", t: "→ " }, next];
	return {
		label,
		tone: details?.outcome === "declined" ? "warning" : undefined,
		body: [
			<text spans={change} wrap="word" />,
			details?.effective !== undefined ? (
				<text
					spans={[
						{
							s: "warning",
							t: `still ${cleanText(details.effective)}: a higher-precedence layer overrides the saved value`,
						},
					]}
					wrap="word"
				/>
			) : undefined,
		],
		term,
	};
}

function cardView(
	card: { kind: CardKind; target: string },
	raw: string,
	args: WriteArgs | undefined,
	result: ToolResult<WriteDetails> | undefined,
): ToolView {
	const content = typeof args?.content === "string" ? args.content : undefined;
	switch (card.kind) {
		case "message":
			return messageView(card.target, content ?? "", result);
		case "proc":
			return procView(card.target, content, result);
		case "cfg":
			return cfgView(raw, content, result);
	}
}

function writeFigure(
	args: WriteArgs,
	result: ToolResult<WriteDetails> | undefined,
	state: ToolViewState,
): ToolFigure | undefined {
	if (result?.isError) return undefined;
	const raw = rawPathOf(args);
	const lang = FIGURE_FENCES[path.extname(raw).slice(1).toLowerCase()];
	const content = args.content;
	if (!lang || typeof content !== "string" || !/\S/.test(content) || urlCard(raw, result?.details)) return undefined;
	return {
		lang,
		source: content.replace(/\r/g, ""),
		closed: result !== undefined || state.argsComplete,
	};
}

function Figure(props: { readonly figure?: ToolFigure }): JSXNode {
	const figure = props.figure;
	if (!figure || (figure.lang === "mermaid" && !figure.closed)) return undefined;
	const text = `\`\`\`${figure.lang}\n${figure.source}${figure.closed ? `${figure.source.endsWith("\n") ? "" : "\n"}\`\`\`` : ""}`;
	return <md key="figure" role="omp.tool.write.figure" text={text} stream={!figure.closed} />;
}

function Source(props: { readonly path: string; readonly content: string }): JSXNode {
	return <code key="source" text={props.content} path={props.path || undefined} numbers wrap />;
}

function fileHead(raw: string, content: string, details?: WriteDetails): ToolHead {
	const lines = countLines(content);
	const badges: { text: string; tone?: TspTone }[] = [];
	if (details?.madeExecutable) badges.push({ text: "executable", tone: "success" });
	const diagnostics = diagnosticsBadge([details?.diagnostics]);
	if (diagnostics) badges.push(diagnostics);
	return {
		title: "Write",
		target: raw ? cleanText(displayPath(raw)) : undefined,
		targetKind: "path",
		href: fileHref(details?.resolvedPath),
		meta: lines > 0 ? [`${lines} line${lines === 1 ? "" : "s"}`] : undefined,
		badges: badges.length > 0 ? badges : undefined,
	};
}

export const writePresenter: ToolPresenter<WriteArgs, WriteDetails> = {
	merge: true,
	streamsBody: true,
	activity(args): ToolActivity {
		const raw = rawPathOf(args);
		if (!raw) return { label: "Write" };
		const card = urlCard(raw);
		if (card?.kind === "message")
			return {
				label: "Message",
				detail: card.target === "all" ? "broadcast" : card.target,
			};
		if (card?.kind === "proc") {
			const { id, action } = procTarget(card.target);
			return { label: "Process", detail: `${action} ${shortenHome(id)}` };
		}
		if (card?.kind === "cfg") return { label: "Config", detail: card.target };
		return { label: "Write", detail: shortenHome(raw) };
	},
	figure: writeFigure,
	call(args, state) {
		if (args.path === undefined && args.file_path === undefined) return undefined;
		const raw = rawPathOf(args);
		const settled = args.content !== undefined || state.argsComplete;
		const stringPath = typeof args.file_path === "string" || typeof args.path === "string";
		// A card URL still streaming in: only the tool's label until the URL settles which card it is.
		if (stringPath && !settled && couldBecomeCardUrl(raw.toLowerCase())) {
			const label = state.renderContext?.label;
			return { label: [{ s: "toolTitle", t: typeof label === "string" ? label : "Write" }] };
		}
		const card = urlCard(raw);
		if (card) return cardView(card, raw, args, undefined);
		const content = contentOf(args);
		const figure = writeFigure(args, undefined, state);
		return {
			head: fileHead(raw, content),
			body: content ? [<Figure figure={figure} />, <Source path={raw} content={content} />] : undefined,
			preview: figure ? FIGURE_PREVIEW : WRITE_PREVIEW,
			term: {
				look: "write",
				path: cleanText(shortenHome(raw)),
				// Before the tool resolves its target, the link names the file the argument points at.
				...(raw && args.content !== undefined ? { link: pendingLinkPath(raw) } : {}),
				call: true,
				streaming: !state.argsComplete,
				spinning: !state.argsComplete,
			},
		};
	},
	result(result, state, args) {
		const raw = rawPathOf(args);
		const card = urlCard(raw, result.details);
		if (card) return cardView(card, raw, args, result);
		const content = contentOf(args);
		const partial = state.isPartial;
		const diagnostics = partial ? undefined : result.details?.diagnostics;
		const head = fileHead(raw, content, {
			madeExecutable: !partial && result.details?.madeExecutable === true,
			resolvedPath: result.details?.resolvedPath,
			diagnostics,
		});
		const term = {
			look: "write",
			path: cleanText(shortenHome(raw)),
			...(result.details?.resolvedPath ? { link: result.details.resolvedPath } : {}),
			executable: head.badges?.some(b => b.text === "executable"),
		};
		if (result.isError)
			return {
				head,
				tone: "error",
				body: <ErrorText message={resultText(result)} />,
				term,
			};
		const progress = resultText(result);
		const figure = args ? writeFigure(args, result, state) : undefined;
		return {
			head,
			body: [
				partial && progress ? <text spans={[{ s: "muted", t: progress }]} truncate="end" /> : undefined,
				<Figure figure={figure} />,
				content ? <Source path={raw} content={content} /> : undefined,
				<DiagnosticsSection diagnostics={diagnostics} />,
			],
			preview: figure ? FIGURE_PREVIEW : WRITE_PREVIEW,
			term,
		};
	},
};

registerToolPresenter("write", writePresenter);
