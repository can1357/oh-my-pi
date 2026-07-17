import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isSettingsInitialized, settings } from "../config/settings";
import { getDefault } from "../config/settings-schema";
import { getWikigraphDb } from "../wikigraph/db";
import type { WikiEdgeRow, WikiNodeRow } from "../wikigraph/types";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_LIMIT = 8;

interface NodeSearchRow extends WikiNodeRow {
	rank?: number;
}

interface SettingsReader {
	get(key: string): unknown;
}

function isSettingsReader(value: unknown): value is SettingsReader {
	return typeof value === "object" && value !== null && typeof (value as { get?: unknown }).get === "function";
}

function getSetting<T>(key: string, fallback: T): T {
	if (!isSettingsInitialized()) return fallback;
	try {
		return settings.get(key as never) as T;
	} catch {
		return fallback;
	}
}

function isEnabled(): boolean {
	return getSetting("wikigraph.enabled", getDefault("wikigraph.enabled" as never) as boolean);
}

function maxChars(): number {
	return getSetting("wikigraph.maxCharsPerResolve", DEFAULT_MAX_CHARS);
}

function maxNodes(): number {
	return getSetting("wikigraph.maxNodesPerResolve", DEFAULT_LIMIT);
}

function configuredRoots(contextSettings?: unknown): string[] {
	let configured: unknown;
	if (isSettingsReader(contextSettings)) {
		try {
			configured = contextSettings.get("wikigraph.roots");
		} catch {
			configured = undefined;
		}
	}
	configured ??= getSetting("wikigraph.roots", getDefault("wikigraph.roots" as never) as unknown);
	return Array.isArray(configured) ? configured.filter((root): root is string => typeof root === "string") : [];
}

function expandRoot(root: string, cwd: string): string {
	const withCwd = root.replaceAll("<cwd>", cwd);
	if (withCwd === "~") return os.homedir();
	if (withCwd.startsWith("~/") || withCwd.startsWith("~\\")) return path.join(os.homedir(), withCwd.slice(2));
	return withCwd;
}

function comparablePath(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithinRoot(target: string, root: string): boolean {
	const comparableTarget = comparablePath(target);
	const comparableRoot = comparablePath(root);
	return comparableTarget === comparableRoot || comparableTarget.startsWith(`${comparableRoot}${path.sep}`);
}

async function safeRealPath(value: string): Promise<string> {
	try {
		return await fs.realpath(value);
	} catch {
		return path.resolve(value);
	}
}

async function assertAllowedWikigraphPath(targetPath: string, cwd: string, contextSettings?: unknown): Promise<string> {
	const absolute = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
	const targetRealPath = await safeRealPath(absolute);
	const allowedRoots = [cwd, ...configuredRoots(contextSettings).map(root => expandRoot(root, cwd))];
	for (const root of allowedRoots) {
		const rootRealPath = await safeRealPath(root);
		if (isWithinRoot(targetRealPath, rootRealPath)) return targetRealPath;
	}
	throw new Error("wikigraph: path is outside allowed roots");
}

function capContent(content: string, notes: string[]): string {
	const cap = maxChars();
	if (content.length <= cap) return content;
	notes.push("truncated; use wikigraph://node/<id>?expand=1 for full body");
	return `${content.slice(0, cap - 1).trimEnd()}…`;
}

function cardLine(row: WikiNodeRow): string {
	const location = row.anchor ? `${row.path}#${row.anchor}` : row.path;
	return `- ${row.kind} ${row.title} (${row.id.slice(0, 12)}) — ${row.summary} [${location}]`;
}

function parseLimit(url: InternalUrl): number {
	const raw = url.searchParams.get("limit");
	const parsed = raw ? Number.parseInt(raw, 10) : maxNodes();
	return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 50) : maxNodes();
}

async function withBusyRetry<T>(operation: () => Promise<T> | T): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes("SQLITE_BUSY") && !message.includes("database is locked")) throw error;
		await Bun.sleep(50);
		try {
			return await operation();
		} catch (retryError) {
			const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
			throw new Error(`wikigraph: database locked after retry; busy_timeout=5000. ${retryMessage}`);
		}
	}
}

function groupedEdges(edges: WikiEdgeRow[]): string {
	const grouped = new Map<string, WikiEdgeRow[]>();
	for (const edge of edges) grouped.set(edge.kind, [...(grouped.get(edge.kind) ?? []), edge]);
	const priority = ["superseded_by", "conflicts_with"];
	const kinds = [
		...priority,
		...Array.from(grouped.keys())
			.filter(kind => !priority.includes(kind))
			.sort(),
	];
	return kinds
		.filter(kind => grouped.has(kind))
		.map(
			kind =>
				`  ${kind}: ${grouped
					.get(kind)!
					.map(edge => edge.to_id.slice(0, 12))
					.join(", ")}`,
		)
		.join("\n");
}

export class WikigraphProtocolHandler implements ProtocolHandler {
	readonly scheme = "wikigraph";
	readonly immutable = true;
	readonly hiddenCompletion = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (!isEnabled()) throw new Error("wikigraph: disabled in settings (wikigraph.enabled)");
		const notes: string[] = [];
		const db = await getWikigraphDb();
		notes.push(...db.notes);
		const host = url.rawHost || url.hostname;
		const content = await withBusyRetry(async () => {
			if (!host) return this.resolveIndex(url, notes);
			if (host === "node") return this.resolveNode(url, notes);
			if (host === "path") return this.resolvePath(url, context, notes);
			if (host === "recent") return this.resolveRecent(url, notes);
			return this.resolveIndex(url, notes);
		});
		return {
			url: url.href,
			content: capContent(content.content, notes),
			contentType: content.contentType,
			size: Buffer.byteLength(content.content, "utf-8"),
			sourcePath: content.sourcePath,
			notes,
		};
	}

	async complete(query: string): Promise<UrlCompletion[]> {
		if (!isEnabled()) return [];
		const db = await getWikigraphDb();
		const like = `%${query.trim()}%`;
		const rows = db
			.prepare<Pick<WikiNodeRow, "id" | "title" | "summary">, [string]>(
				"SELECT id, title, summary FROM nodes WHERE status = 'current' AND title LIKE ? ORDER BY updated_at DESC LIMIT 8",
			)
			.all(like);
		return rows.map(row => ({ value: `node/${row.id}`, label: row.title, description: row.summary }));
	}

	async resolveIndex(url: InternalUrl, notes: string[]): Promise<InternalResource> {
		const db = await getWikigraphDb();
		const query = (url.searchParams.get("q") ?? "").trim();
		const status = url.searchParams.get("status") ?? "current";
		const kind = url.searchParams.get("kind");
		const limit = parseLimit(url);
		let rows: NodeSearchRow[] = [];
		if (query) {
			try {
				rows = db
					.prepare<NodeSearchRow>(`
SELECT nodes.*, bm25(nodes_fts) AS rank FROM nodes_fts
JOIN nodes ON nodes.rowid = nodes_fts.rowid
WHERE nodes_fts MATCH ? AND nodes.status = ? ${kind ? "AND nodes.kind = ?" : ""}
ORDER BY rank LIMIT ?
`)
					.all(...(kind ? [query, status, kind, limit] : [query, status, limit]));
			} catch {
				rows = [];
			}
			if (rows.length === 0) {
				const like = `%${query.replace(/\s+/g, "%")}%`;
				rows = db
					.prepare<NodeSearchRow>(`
SELECT * FROM nodes WHERE status = ? ${kind ? "AND kind = ?" : ""} AND (title LIKE ? OR summary LIKE ?)
ORDER BY updated_at DESC LIMIT ?
`)
					.all(...(kind ? [status, kind, like, like, limit] : [status, like, like, limit]));
			}
			if (rows.length === 0) notes.push("no matches; showing index instead");
		}
		if (rows.length === 0) {
			rows = db
				.prepare<NodeSearchRow, [string, number]>(
					"SELECT * FROM nodes WHERE status = ? ORDER BY updated_at DESC LIMIT ?",
				)
				.all(status, Math.min(limit, 50));
		}
		return {
			url: url.href,
			content: rows.map(cardLine).join("\n") || "No wiki graph nodes indexed.",
			contentType: "text/markdown",
		};
	}

	async resolveNode(url: InternalUrl, notes: string[]): Promise<InternalResource> {
		const db = await getWikigraphDb();
		const id = decodeURIComponent((url.rawPathname ?? url.pathname).replace(/^\//, ""));
		const node = db.prepare<WikiNodeRow, [string]>("SELECT * FROM nodes WHERE id = ?").get(id);
		if (!node) {
			const suggestions = db
				.prepare<{ id: string }, [string]>("SELECT id FROM nodes WHERE id LIKE ? ORDER BY updated_at DESC LIMIT 5")
				.all(`${id}%`)
				.map(row => row.id)
				.join(", ");
			throw new Error(
				`Unknown wiki node: ${id}. Try wikigraph://?q=${encodeURIComponent(id.slice(0, 12))}${suggestions ? `. Closest: ${suggestions}` : ""}`,
			);
		}
		const edges = db
			.prepare<WikiEdgeRow, [string]>("SELECT * FROM edges WHERE from_id = ? ORDER BY kind, created_at DESC")
			.all(id);
		const lines = [
			`# ${node.title}`,
			`kind: ${node.kind}`,
			`status: ${node.status}`,
			`summary: ${node.summary}`,
			`source: ${node.anchor ? `${node.path}#${node.anchor}` : node.path}`,
		];
		if (node.superseded_by) lines.push(`superseded_by: ${node.superseded_by}`);
		const edgeText = groupedEdges(edges);
		if (edgeText) lines.push("edges:", edgeText);
		if (url.searchParams.get("expand") === "1") {
			const expanded = await this.readNodeSlice(node);
			lines.push("", "```markdown", expanded.content, "```");
			notes.push(`expanded: ${expanded.label}`);
		}
		return { url: url.href, content: lines.join("\n"), contentType: "text/markdown", sourcePath: node.path };
	}

	async resolvePath(
		url: InternalUrl,
		context: ResolveContext | undefined,
		notes: string[],
	): Promise<InternalResource> {
		const raw = decodeURIComponent(`${url.rawPathname ?? url.pathname}${url.hash}`.replace(/^\//, ""));
		const match = raw.match(/^(.*)#L(\d+)(?:-L?(\d+))?$/);
		const targetPath = match ? match[1] : raw;
		const cwd = context?.cwd ?? process.cwd();
		const absolute = await assertAllowedWikigraphPath(targetPath, cwd, context?.settings);
		const lines = (await Bun.file(absolute).text()).split(/\r?\n/);
		const start = match ? Math.max(1, Number.parseInt(match[2], 10)) : 1;
		const end = match?.[3]
			? Math.min(lines.length, Number.parseInt(match[3], 10))
			: Math.min(lines.length, start + 80);
		notes.push(`expanded: ${absolute}:L${start}-L${end}`);
		return {
			url: url.href,
			content: lines.slice(start - 1, end).join("\n"),
			contentType: "text/markdown",
			sourcePath: absolute,
		};
	}

	async resolveRecent(url: InternalUrl, notes: string[]): Promise<InternalResource> {
		const db = await getWikigraphDb();
		const repo = url.searchParams.get("project") ?? "";
		const rows = db
			.prepare<WikiNodeRow, [string, number]>(
				"SELECT * FROM nodes WHERE status = 'current' AND path LIKE ? ORDER BY updated_at DESC LIMIT ?",
			)
			.all(`${repo}%`, parseLimit(url));
		if (rows.length === 0) notes.push("no recent nodes");
		return { url: url.href, content: rows.map(cardLine).join("\n"), contentType: "text/markdown" };
	}

	async readNodeSlice(node: WikiNodeRow): Promise<{ content: string; label: string }> {
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(node.path)) return { content: node.summary, label: node.path };
		const lines = (await fs.readFile(node.path, "utf-8")).split(/\r?\n/);
		const start = node.line_start ?? 1;
		const end = Math.min(node.line_end ?? start + 80, lines.length);
		const content = lines.slice(start - 1, end).join("\n");
		return {
			content: content.length > 4096 ? `${content.slice(0, 4095)}…` : content,
			label: `${node.path}:L${start}-L${end}`,
		};
	}
}
