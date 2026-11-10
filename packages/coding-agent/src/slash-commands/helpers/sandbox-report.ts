import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	inspectSandbox,
	SANDBOX_NAMESPACES,
	type SandboxFacts,
	type SandboxLayer,
	type SandboxPolicyFile,
	type SandboxStatus,
	type SandboxWriteAccess,
	sandboxLayerLabel,
	summarizeSandbox,
} from "@oh-my-pi/pi-utils/sandbox";
import { type Component, Container, KeyValueList, Markdown, replaceTabs, Spacer, Text } from "@oh-my-pi/pi-tui";
import { isEnoent, isEnotdir, sanitizeText, slugify } from "@oh-my-pi/pi-utils";
import type { ReportSectionsInput } from "@oh-my-pi/pi-tui/overlays/sections-report";
import { fileHyperlink } from "@oh-my-pi/pi-tui/render/hyperlink";
import { PREVIEW_LIMITS, shortenEmbeddedPaths } from "@oh-my-pi/pi-tui/render/render-utils";
import { getMarkdownTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { Settings } from "../../config/settings";
import { type ApprovalMode, resolveApprovalFromContext } from "../../tools/approval";
import { cfgToolsApprovalMode } from "../../tools/settings";

/** The mode's name as `/settings` shows it. */
function approvalModeLabel(mode: ApprovalMode): string {
	const options = cfgToolsApprovalMode.ui?.options;
	return Array.isArray(options) ? (options.find(option => option.value === mode)?.label ?? mode) : mode;
}

/** One labelled line of the `/sandbox` report. */
export interface SandboxReportRow {
	label: string;
	value: string;
}

/** One line of a policy-files tree: `lead`, then `text`, then `tail`. The terminal UI links `text` to `path`. */
export interface SandboxReportTreeLine {
	lead: string;
	text: string;
	path?: string;
	tail: string;
}

/** A drill-down section, opened with `/sandbox <key>`. */
export interface SandboxReportSection {
	key: string;
	title: string;
	rows: SandboxReportRow[];
	/** A probe's markdown section, shown as it is. */
	markdown?: string;
	/** A probe's policy files, as the disk has them. */
	tree?: SandboxReportTreeLine[];
}

/**
 * `/sandbox`, summary first: a title with the layers, one line each for Layer, Files, Network, Approvals and
 * Kernel, then the sections that hold the detail.
 */
export interface SandboxReport {
	title: string;
	rows: SandboxReportRow[];
	sections: SandboxReportSection[];
}

const PROXY_VARS = [
	"HTTPS_PROXY",
	"https_proxy",
	"HTTP_PROXY",
	"http_proxy",
	"ALL_PROXY",
	"all_proxy",
	"NO_PROXY",
	"no_proxy",
];

/**
 * Hides the userinfo in `scheme://user:pass@host` and in a bare `user:pass@host`. Userinfo ends at the last `@`
 * before the first `/`, as curl and Go split it, so a password with an unencoded `@` is hidden whole.
 */
export function redactProxyCredentials(value: string): string {
	return value.replace(/^((?:[a-z][a-z0-9+.-]*:\/\/)?)[^/\s]*@/i, "$1***@");
}

/** Display text: paths under home shortened to `~`. Probe text is already one sanitized line. */
function shown(text: string): string {
	return shortenEmbeddedPaths(text);
}

function basisText(layer: SandboxLayer): string {
	return layer.basis === "measured" ? "measured" : "declared (a marker this user could also create)";
}

const WRITE_TEXT: Record<SandboxWriteAccess, string> = {
	writable: "writable",
	"read-only": "read-only",
	unknown: "not reported",
};

function filesText(files: { cwd: SandboxWriteAccess; home: SandboxWriteAccess }): string {
	return `working directory ${WRITE_TEXT[files.cwd]}; home ${WRITE_TEXT[files.home]}`;
}

function networkText(network: SandboxLayer["network"]): string {
	if (!network) return "not reported";
	return network.summary ? `${network.access} (${shown(network.summary)})` : network.access;
}

function onOff(value: boolean | undefined, on: string, off: string): string {
	return value === undefined ? "unknown" : value ? on : off;
}

const ROOT_LISTING_TEXT: Record<SandboxFacts["rootListing"], string> = {
	refused: "listing / refused by an LSM",
	allowed: "listing / allowed",
	unknown: "listing / unknown",
};

function kernelText(status: SandboxStatus): string {
	const { facts } = status;
	if (status.platform === "darwin") return `Seatbelt ${onOff(facts.seatbelt, "sandboxed", "not sandboxed")}`;
	if (status.platform !== "linux") return `not read on ${status.platform}`;
	const own = SANDBOX_NAMESPACES.filter(name => facts.namespaces[name] === "non-initial");
	const unknown = SANDBOX_NAMESPACES.filter(
		name => facts.namespaces[name] !== "initial" && facts.namespaces[name] !== "non-initial",
	);
	const namespaces = `${own.length > 0 ? `own ${own.join(", ")} namespaces` : "no positively observed non-initial namespaces"}${unknown.length ? `; unknown: ${unknown.join(", ")}` : ""}`;
	return [
		`no_new_privs ${onOff(facts.noNewPrivs, "on", "off")}`,
		`seccomp ${facts.seccomp ?? "unknown"}`,
		ROOT_LISTING_TEXT[facts.rootListing],
		namespaces,
	].join(" · ");
}

/** What the disk says about one policy file; `entries` are a directory's names, sorted. */
export interface PolicyFileState {
	state: "present" | "absent" | "unreadable";
	entries?: string[];
}

/** How the policy-files tree reads the disk. Both reject with the file-system error. */
export interface PolicyFileReader {
	stat(target: string): Promise<unknown>;
	readdir(target: string): Promise<string[]>;
}

const DISK: PolicyFileReader = { stat: target => fs.stat(target), readdir: target => fs.readdir(target) };

/** Looks up every policy file the layers declare, keyed by path. */
export async function resolvePolicyFiles(
	status: SandboxStatus,
	reader: PolicyFileReader = DISK,
): Promise<Map<string, PolicyFileState>> {
	const files = status.layers.flatMap(layer =>
		(layer.details ?? []).flatMap(detail => ("files" in detail ? detail.files : [])),
	);
	const states = await Promise.all(
		files.map(async (file): Promise<PolicyFileState> => {
			try {
				if (file.directory) return { state: "present", entries: (await reader.readdir(file.path)).sort() };
				await reader.stat(file.path);
				return { state: "present" };
			} catch (err) {
				return { state: isEnoent(err) || isEnotdir(err) ? "absent" : "unreadable" };
			}
		}),
	);
	return new Map(files.map((file, index) => [file.path, states[index]]));
}

function policyFileLines(
	files: readonly SandboxPolicyFile[],
	states: ReadonlyMap<string, PolicyFileState> | undefined,
): SandboxReportTreeLine[] {
	const lines: SandboxReportTreeLine[] = [];
	for (const [index, file] of files.entries()) {
		const last = index === files.length - 1;
		const found = states?.get(file.path);
		const entries = found?.entries ?? [];
		const note = found && found.state !== "present" ? found.state : found?.entries?.length === 0 ? "empty" : "";
		lines.push({
			lead: `${last ? "└─" : "├─"} ${file.label}: `,
			text: shown(file.path),
			path: file.path,
			tail: note ? ` (${note})` : "",
		});
		const indent = last ? "   " : "│  ";
		const kept = entries.slice(0, PREVIEW_LIMITS.EXPANDED_LINES);
		const cut = entries.length - kept.length;
		for (const [child, name] of kept.entries()) {
			lines.push({
				lead: `${indent}${cut === 0 && child === kept.length - 1 ? "└─" : "├─"} `,
				text: sanitizeText(name).replace(/\s+/g, " "),
				path: path.join(file.path, name),
				tail: "",
			});
		}
		if (cut > 0) lines.push({ lead: `${indent}└─ `, text: `${cut} more`, tail: "" });
	}
	return lines;
}

function layerSection(layer: SandboxLayer, key: string): SandboxReportSection {
	const rows: SandboxReportRow[] = [{ label: "Established", value: basisText(layer) }];
	if (layer.role) rows.push({ label: "Role", value: shown(layer.role) });
	for (const restriction of layer.restrictions) rows.push({ label: "Restricts", value: shown(restriction) });
	if (layer.files) rows.push({ label: "Files", value: filesText(layer.files) });
	if (layer.network) rows.push({ label: "Network", value: networkText(layer.network) });
	for (const detail of layer.details ?? []) {
		if ("label" in detail) {
			const value = shown(detail.value);
			const existing = rows.find(row => row.label.toLowerCase() === detail.label.toLowerCase());
			if (existing) {
				if (existing.value !== value) existing.value += `; ${value}`;
			} else rows.push({ label: detail.label, value });
		}
	}
	for (const item of layer.evidence) rows.push({ label: "Evidence", value: shown(item) });
	return { key, title: sandboxLayerLabel(layer), rows };
}

function networkSection(status: SandboxStatus, env: Record<string, string | undefined>): SandboxReportSection {
	const rows: SandboxReportRow[] = status.layers.flatMap(layer =>
		layer.network ? [{ label: layer.id, value: networkText(layer.network) }] : [],
	);
	for (const name of PROXY_VARS) {
		const value = env[name];
		if (value) rows.push({ label: name, value: shown(sanitizeText(redactProxyCredentials(value))) });
	}
	if (rows.length === 0) rows.push({ label: "Network", value: "no layer reports it and no proxy is set" });
	return { key: "network", title: "Network", rows };
}

function evidenceSection(status: SandboxStatus): SandboxReportSection {
	const rows = status.evidence.map(item => {
		const i = item.indexOf(": ");
		return i > 0 ? { label: item.slice(0, i), value: shown(item.slice(i + 2)) } : { label: "", value: shown(item) };
	});
	return { key: "evidence", title: "Evidence", rows };
}

function sections(
	status: SandboxStatus,
	env: Record<string, string | undefined>,
	policyFiles?: ReadonlyMap<string, PolicyFileState>,
): SandboxReportSection[] {
	const out: SandboxReportSection[] = [];
	const taken = new Set(["network", "namespaces", "kernel", "evidence"]);
	const unique = (base: string) => {
		let key = base;
		for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
		taken.add(key);
		return key;
	};
	for (const layer of status.layers) {
		out.push(layerSection(layer, unique(slugify(layer.id) || "section")));
		for (const detail of layer.details ?? []) {
			if ("label" in detail) continue;
			const section = { key: unique(slugify(detail.title) || "section"), title: detail.title, rows: [] };
			if ("files" in detail) out.push({ ...section, tree: policyFileLines(detail.files, policyFiles) });
			else out.push({ ...section, markdown: detail.markdown });
		}
	}
	out.push(networkSection(status, env));
	if (status.platform === "linux") {
		out.push({
			key: "namespaces",
			title: "Namespaces",
			rows: SANDBOX_NAMESPACES.map(name => ({
				label: name,
				value: `${status.facts.namespaces[name]}${status.facts.namespaceInodes?.[name] ? ` · ${status.facts.namespaceInodes[name]}` : ""}`,
			})),
		});
	}
	const facts = status.facts;
	const kernelRows: SandboxReportRow[] = [];
	if (facts.seccompFilters !== undefined)
		kernelRows.push({ label: "Seccomp filters", value: String(facts.seccompFilters) });
	for (const [name, value] of Object.entries(facts.capabilities ?? {}))
		if (value !== undefined) kernelRows.push({ label: `Capability ${name}`, value });
	for (const [name, maps] of Object.entries(facts.namespaceIdMaps ?? {}))
		if (maps !== undefined)
			kernelRows.push({
				label: `${name}_map`,
				value: maps.map(map => `${map.inside} ${map.outside} ${map.length}`).join("; "),
			});
	if (facts.lsm) kernelRows.push({ label: "LSMs", value: facts.lsm.join(", ") });
	if (facts.lsmLabel !== undefined) kernelRows.push({ label: "LSM label", value: shown(facts.lsmLabel) });
	if (facts.cgroup !== undefined) kernelRows.push({ label: "Cgroup", value: shown(facts.cgroup) });
	if (facts.yamaPtraceScope !== undefined)
		kernelRows.push({ label: "Yama ptrace_scope", value: String(facts.yamaPtraceScope) });
	if (facts.landlock)
		kernelRows.push({
			label: "Landlock",
			value: `${facts.landlock.state}${facts.landlock.abi !== undefined ? ` · ABI ${facts.landlock.abi}` : ""}`,
		});
	if (facts.seatbelt !== undefined)
		kernelRows.push({ label: "Seatbelt", value: onOff(facts.seatbelt, "sandboxed", "not sandboxed") });
	out.push({ key: "kernel", title: "Kernel security facts", rows: kernelRows });
	out.push(evidenceSection(status));
	return out;
}

/** What `/sandbox` reads besides the detected status. */
export interface SandboxReportContext {
	/** The approval mode tool calls run under. */
	approvalMode: ApprovalMode;
	/** Where the network section reads the proxy variables; `process.env` by default. */
	env?: Record<string, string | undefined>;
	/** The disk state of the layers' policy files, from {@link resolvePolicyFiles}. */
	policyFiles?: ReadonlyMap<string, PolicyFileState>;
}

export function buildSandboxReport(status: SandboxStatus, context: SandboxReportContext): SandboxReport {
	const env = context.env ?? process.env;
	const detected = status.layers.length > 0;
	const summary = summarizeSandbox(status);
	const rows: SandboxReportRow[] = [
		{
			label: "Layer",
			value: detected
				? status.layers.map(layer => `${shown(sandboxLayerLabel(layer))} (${layer.basis})`).join(", ")
				: "none detected",
		},
		{ label: "Files", value: detected ? filesText(summary.files) : "not restricted by a detected sandbox" },
		{ label: "Network", value: detected ? networkText(summary.network) : "not restricted by a detected sandbox" },
		{ label: "Approvals", value: approvalModeLabel(context.approvalMode) },
		{ label: "Kernel", value: kernelText(status) },
	];
	return {
		title: `Sandbox ─ ${detected ? shown(summary.label) : "none"}`,
		rows,
		sections: sections(status, env, context.policyFiles),
	};
}

/** The `/sandbox` report for a session, with what only a report asks for: probe reports and the policy files on disk. */
export async function loadSandboxReport(settings: Settings): Promise<SandboxReport> {
	const status = await inspectSandbox();
	const policyFiles = await resolvePolicyFiles(status);
	const { approvalMode } = resolveApprovalFromContext({ settings });
	return buildSandboxReport(status, { approvalMode, policyFiles });
}

/** The last line of the text summary: the sections `/sandbox <section>` opens. The panel lists them itself. */
function sandboxMoreRow(report: SandboxReport): SandboxReportRow {
	return { label: "More", value: `/sandbox ${report.sections.map(section => section.key).join(" | ")}` };
}

function rowLines(rows: SandboxReportRow[]): string[] {
	return rows.map(row => (row.label ? `${row.label}: ${row.value}` : row.value));
}

/** The summary as plain labelled lines (ACP and other text hosts). */
function formatSandboxReport(report: SandboxReport): string {
	return [report.title, "", ...rowLines([...report.rows, sandboxMoreRow(report)])].join("\n");
}

/** One section as plain labelled lines, its policy-files tree or markdown after them. */
function formatSandboxSection(report: SandboxReport, section: SandboxReportSection): string {
	const lines = [`${report.title} ─ ${section.title}`, "", ...rowLines(section.rows)];
	const more = section.tree?.map(line => `${line.lead}${line.text}${line.tail}`) ?? [];
	if (section.markdown) more.push(section.markdown);
	if (more.length > 0) lines.push(...(section.rows.length > 0 ? [""] : []), ...more);
	return lines.join("\n");
}

/** The section `/sandbox <arg>` names, matched on its key or title. */
function findSandboxSection(report: SandboxReport, arg: string): SandboxReportSection | undefined {
	const wanted = arg.trim().toLowerCase();
	return report.sections.find(section => section.key === wanted || section.title.toLowerCase() === wanted);
}

function unknownSection(report: SandboxReport, arg: string): string {
	const keys = report.sections.map(section => section.key).join(", ");
	return `No sandbox section "${sanitizeText(arg.trim())}". Sections: ${keys}.`;
}

/** `/sandbox [section]` as text: the summary, or the named section. */
export function sandboxReportText(report: SandboxReport, arg: string): string {
	if (!arg.trim()) return formatSandboxReport(report);
	const section = findSandboxSection(report, arg);
	return section ? formatSandboxSection(report, section) : unknownSection(report, arg);
}

function rowList(rows: SandboxReportRow[]): KeyValueList {
	const labelWidth = Math.max(...rows.map(row => Bun.stringWidth(row.label)), 1);
	return new KeyValueList(
		rows.map(row => ({
			label: replaceTabs(row.label),
			value: replaceTabs(row.value),
			labelStyle: text => theme.fg("dim", text),
		})),
		{ labelWidth: Math.min(labelWidth, 22), gap: "  ", minValueWidth: 12, labelOverflow: "truncate" },
	);
}

/** A section for the terminal UI: its rows, then its policy-files tree with each path a file link, or its markdown. */
function sectionBody(section: SandboxReportSection, heading?: string): Component {
	const parts: Component[] = heading ? [new Text(heading, 0, 0)] : [];
	if (section.rows.length > 0) parts.push(rowList(section.rows));
	if (section.tree) {
		const lines = section.tree.map(
			line => `${line.lead}${line.path ? fileHyperlink(line.path, line.text) : line.text}${line.tail}`,
		);
		parts.push(new Text(replaceTabs(lines.join("\n")), 0, 0));
	}
	if (section.markdown) parts.push(new Markdown(replaceTabs(section.markdown), 0, 0, getMarkdownTheme()));
	const body = new Container();
	for (const [index, part] of parts.entries()) {
		if (index > 0) body.addChild(new Spacer(1));
		body.addChild(part);
	}
	return body;
}

/** `/sandbox [section]` for the TUI report panel: the summary over its section list, or the named section. */
export function sandboxReportView(
	report: SandboxReport,
	arg: string,
): { title: string; body: Component; sections?: ReportSectionsInput } {
	if (!arg.trim()) {
		const summary = rowList(report.rows);
		return {
			title: report.title,
			body: summary,
			sections: {
				summary,
				sections: report.sections.map(section => ({
					id: section.key,
					label: section.title,
					markdown: formatSandboxSection(report, section),
					body: sectionBody(section, section.title),
				})),
			},
		};
	}
	const section = findSandboxSection(report, arg);
	if (!section) return { title: report.title, body: new Text(unknownSection(report, arg), 0, 0) };
	return { title: `${report.title} ─ ${section.title}`, body: sectionBody(section) };
}
