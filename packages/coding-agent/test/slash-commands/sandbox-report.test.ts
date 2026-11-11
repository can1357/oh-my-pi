import { afterEach, describe, expect, it, vi } from "bun:test";
import * as sandbox from "@oh-my-pi/pi-utils/sandbox";
import type { SandboxLayer, SandboxStatus } from "@oh-my-pi/pi-utils/sandbox";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import type { Component } from "@oh-my-pi/pi-tui";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import { PREVIEW_LIMITS } from "@oh-my-pi/pi-tui/render/render-utils";
import {
	buildSandboxReport,
	type PolicyFileReader,
	redactProxyCredentials,
	resolvePolicyFiles,
	type SandboxReport,
	type SandboxReportContext,
	sandboxReportText,
	sandboxReportView,
} from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/sandbox-report";

afterEach(() => {
	vi.restoreAllMocks();
});

const CONTEXT: SandboxReportContext = { approvalMode: "write", env: {} };

function status(overrides: Partial<SandboxStatus> = {}): SandboxStatus {
	return {
		platform: "linux",
		layers: [],
		facts: {
			namespaces: {
				user: "initial",
				pid: "non-initial",
				uts: "initial",
				ipc: "initial",
				cgroup: "initial",
				time: "initial",
				mnt: "unknown",
				net: "unknown",
			},
			rootListing: "allowed",
			noNewPrivs: true,
			seccomp: "filter",
		},
		evidence: ["nono: declared"],
		...overrides,
	};
}

const NONO: SandboxLayer = {
	id: "nono",
	basis: "declared",
	restrictions: ["blocked commands: rm"],
	files: { cwd: "writable", home: "read-only" },
	network: { access: "filtered", summary: "through the nono proxy" },
	details: [
		{ label: "Capability file", value: "/tmp/.nono-42.json" },
		{ title: "Paths", markdown: "| Path | Access |\n|---|---|\n| /work/app | readwrite |" },
	],
	evidence: ["NONO_CAP_FILE=/tmp/.nono-42.json (1 grants)"],
};

function row(report: SandboxReport, label: string): string | undefined {
	return report.rows.find(r => r.label === label)?.value;
}

/** Everything `/sandbox` can print: the summary and every section. */
function allText(report: SandboxReport): string {
	return [sandboxReportText(report, ""), ...report.sections.map(s => sandboxReportText(report, s.key))].join("\n");
}

describe("/sandbox report", () => {
	it("never prints proxy credentials, even a password with an unencoded @, and keeps the proxy host", () => {
		for (const [value, secret, host] of [
			["http://nono:s3cret@127.0.0.1:41000", "s3cret", "127.0.0.1:41000"],
			["alice:hunter2@proxy.contoso.example:3128", "hunter2", "proxy.contoso.example:3128"],
			["http://user:p@ss@proxy.contoso.example:3128/", "ss@", "proxy.contoso.example:3128"],
		]) {
			expect(redactProxyCredentials(value)).not.toContain(secret);
			expect(redactProxyCredentials(value)).toContain(host);
		}
		// An @ in the path is not userinfo.
		const pathAt = "http://proxy.contoso.example:3128/a@b";
		expect(redactProxyCredentials(pathAt)).toBe(pathAt);

		const env = {
			HTTPS_PROXY: "http://nono:s3cret@127.0.0.1:41000",
			ALL_PROXY: "socks5://bob:p@ss@socks.contoso.example:1080",
			no_proxy: "localhost",
		};
		const text = allText(buildSandboxReport(status({ layers: [NONO] }), { ...CONTEXT, env }));
		expect(text).not.toContain("s3cret");
		expect(text).not.toContain("p@ss");
		expect(text).toContain("127.0.0.1:41000");
		expect(text).toContain("localhost");
	});

	it("leads with layer, files, network, approvals and kernel; detail stays in the sections", () => {
		const report = buildSandboxReport(status({ layers: [NONO] }), CONTEXT);
		expect(report.title).toContain("nono");
		expect(row(report, "Layer")).toContain("nono");
		expect(row(report, "Layer")).toContain("declared");
		expect(row(report, "Files")).toContain("writable");
		expect(row(report, "Files")).toContain("read-only");
		expect(row(report, "Network")).toContain("filtered");
		expect(row(report, "Approvals")).toMatch(/write/i);
		expect(row(report, "Kernel")).toContain("no_new_privs");
		expect(row(report, "Kernel")).toContain("pid");

		// The path table and the capability file are one drill-down away, not in the summary.
		const summary = sandboxReportText(report, "");
		expect(summary).not.toContain("/work/app");
		expect(summary).not.toContain(".nono-42.json");
		expect(sandboxReportText(report, "paths")).toContain("/work/app");
		expect(sandboxReportText(report, "nono")).toContain("/tmp/.nono-42.json");
		expect(sandboxReportText(report, "nono")).toContain("blocked commands: rm");

		// The summary names every section, and each name opens it.
		const keys = report.sections.map(s => s.key);
		expect(keys).toEqual(expect.arrayContaining(["nono", "paths", "network", "namespaces", "kernel", "evidence"]));
		for (const key of keys) expect(summary).toContain(key);
		expect(sandboxReportText(report, "namespaces")).toContain("non-initial");
		expect(sandboxReportText(report, "evidence")).toContain("declared");
		// An unknown section lists the ones that exist.
		for (const key of keys) expect(sandboxReportText(report, "proc")).toContain(key);
	});

	it("joins a probe's row into the layer's own row of the same label instead of listing the label twice", () => {
		const devbox: SandboxLayer = {
			...NONO,
			id: "devbox",
			role: "build",
			details: [
				{ label: "Network", value: "filtered (through the nono proxy)" },
				{ label: "network", value: "allowlist: git.contoso.example" },
			],
		};
		const report = buildSandboxReport(status({ layers: [devbox] }), CONTEXT);
		const section = report.sections.find(candidate => candidate.key === "devbox");
		const network = section?.rows.filter(item => item.label.toLowerCase() === "network");
		expect(network).toHaveLength(1);
		expect(network?.[0]?.value).toBe("filtered (through the nono proxy); allowlist: git.contoso.example");
	});

	it("says no sandbox was found, and reads Seatbelt instead of Linux facts on macOS", () => {
		const darwin = buildSandboxReport(
			status({ platform: "darwin", facts: { ...status().facts, seatbelt: false }, evidence: [] }),
			CONTEXT,
		);
		expect(darwin.title).toContain("none");
		expect(row(darwin, "Kernel")).toContain("Seatbelt");
		expect(row(darwin, "Kernel")).not.toContain("no_new_privs");
		expect(darwin.sections.map(s => s.key)).not.toContain("namespaces");
		const kernel = darwin.sections.find(s => s.key === "kernel")?.rows.map(r => r.label);
		expect(kernel).toEqual(["Seatbelt"]);
	});

	it("reports Landlock as the kernel's support and ABI version, and each namespace's inode", () => {
		const facts = {
			...status().facts,
			landlock: { state: "supported" as const, abi: 4 },
			namespaceInodes: { mnt: "mnt:[123]", net: "net:[456]" },
		};
		const text = allText(buildSandboxReport(status({ layers: [NONO], facts }), CONTEXT));
		expect(text).toContain("ABI 4");
		expect(text).toContain("mnt:[123]");
	});

	it("draws the panel's summary and sections from the report, without the title and section list the panel shows itself", () => {
		const report = buildSandboxReport(status({ layers: [NONO] }), CONTEXT);
		const view = sandboxReportView(report, "");
		const drawn = (part: string | Component | undefined) =>
			typeof part === "object" ? Bun.stripANSI(part.render(200).join("\n")) : "";
		const summary = drawn(view.sections?.summary);
		for (const item of report.rows) expect(summary).toContain(item.value);
		expect(summary).not.toContain(report.title);
		expect(summary).not.toContain("/sandbox ");
		expect(view.sections?.sections.map(section => section.id)).toEqual(report.sections.map(section => section.key));
		for (const section of view.sections?.sections ?? []) {
			expect(drawn(section.body)).toContain(section.label);
			expect(drawn(section.body)).not.toContain(report.title);
		}
		const nono = view.sections?.sections.find(section => section.id === "nono");
		expect(drawn(nono?.body)).toContain("blocked commands: rm");
	});

	it("draws a row as it is when its section opens from the list, markdown characters included", () => {
		const env = { NO_PROXY: "*.contoso.example,*.local" };
		const view = sandboxReportView(buildSandboxReport(status(), { ...CONTEXT, env }), "");
		const network = view.sections?.sections.find(section => section.id === "network");
		expect(Bun.stripANSI(network?.body?.render(120).join("\n") ?? "")).toContain(env.NO_PROXY);
	});

	it("draws a probe's policy files as a tree that says what the disk has, with a file link for each path", async () => {
		const many = Array.from(
			{ length: PREVIEW_LIMITS.EXPANDED_LINES + 3 },
			(_, index) => `rule-${String(index).padStart(2, "0")}.json`,
		);
		const disk = new Map<string, string[] | "file" | "denied">([
			["/run/devbox/policy.json", "file"],
			["/etc/devbox/profiles", ["build.json", "audit.json"]],
			["/etc/devbox/rules", [...many].reverse()],
			["/etc/devbox/keys", "denied"],
		]);
		const fail = (code: string) => Object.assign(new Error(code), { code });
		const read = (target: string) => {
			const found = disk.get(target);
			if (found === undefined) throw fail("ENOENT");
			if (found === "denied") throw fail("EACCES");
			return found;
		};
		const reader: PolicyFileReader = {
			stat: async target => read(target),
			readdir: async target => {
				const found = read(target);
				if (found === "file") throw fail("ENOTDIR");
				return [...found];
			},
		};
		const devbox: SandboxLayer = {
			id: "devbox",
			basis: "declared",
			restrictions: [],
			details: [
				{
					title: "Policy files",
					files: [
						{ label: "policy", path: "/run/devbox/policy.json" },
						{ label: "profiles", path: "/etc/devbox/profiles", directory: true },
						{ label: "rules", path: "/etc/devbox/rules", directory: true },
						{ label: "user config", path: "/home/alice/.devbox.yaml" },
						{ label: "keys", path: "/etc/devbox/keys", directory: true },
					],
				},
			],
			evidence: [],
		};
		const detected = status({ layers: [devbox] });
		const report = buildSandboxReport(detected, {
			...CONTEXT,
			policyFiles: await resolvePolicyFiles(detected, reader),
		});
		expect(report.sections.map(section => section.key)).toContain("policy-files");

		const lines = sandboxReportText(report, "policy-files").split("\n");
		const line = (text: string) => lines.find(candidate => candidate.includes(text)) ?? "";
		expect(line("/run/devbox/policy.json")).not.toMatch(/absent|unreadable/);
		expect(line("/home/alice/.devbox.yaml")).toContain("absent");
		expect(line("/etc/devbox/keys")).toContain("unreadable");
		// A directory lists its entries sorted, up to the preview limit, then counts the rest.
		expect(lines.findIndex(candidate => candidate.includes("audit.json"))).toBeLessThan(
			lines.findIndex(candidate => candidate.includes("build.json")),
		);
		expect(lines.filter(candidate => candidate.includes("rule-"))).toHaveLength(PREVIEW_LIMITS.EXPANDED_LINES);
		expect(line(many[0])).not.toBe("");
		expect(line(many.at(-1) ?? "")).toBe("");
		expect(lines.filter(candidate => !candidate.includes("rule-")).join("\n")).toMatch(/\b3\b/);

		// In the panel the section is a component whose paths are file links, entries included.
		applyHyperlinkSetting("always");
		try {
			const section = sandboxReportView(report, "").sections?.sections.find(
				candidate => candidate.id === "policy-files",
			);
			const drawn = section?.body?.render(200).join("\n") ?? "";
			for (const target of ["/run/devbox/policy.json", "/etc/devbox/profiles/audit.json"]) {
				expect(drawn).toContain(`${target}\x1b\\`);
			}
			expect(Bun.stripANSI(drawn)).toContain("/home/alice/.devbox.yaml");
		} finally {
			applyHyperlinkSetting("auto");
		}
	});

	it("names the namespaces it could not compare as unknown instead of counting them as the host's", () => {
		const kernel = row(buildSandboxReport(status(), CONTEXT), "Kernel") ?? "";
		const [known, unknown = ""] = kernel.split("unknown");
		expect(known).toContain("pid");
		expect(known).not.toMatch(/mnt|net/);
		expect(unknown).toContain("mnt");
		expect(unknown).toContain("net");
	});
});

describe("/sandbox command", () => {
	it("answers a text host with the summary, a named section, or the list of sections, without escape codes", async () => {
		const policyFiles = { title: "Policy files", files: [{ label: "capability file", path: "/run/nono/caps.json" }] };
		const detected = status({ layers: [{ ...NONO, details: [...(NONO.details ?? []), policyFiles] }] });
		vi.spyOn(sandbox, "inspectSandbox").mockResolvedValue(detected);
		// A session started auto-approved runs tool calls under yolo whatever the setting says.
		const session = { settings: Settings.isolated({ "tools.approvalMode": "always-ask" }), approvalMode: "yolo" };
		const run = async (text: string) => {
			const chunks: string[] = [];
			const runtime = { session, output: (chunk: string) => void chunks.push(chunk) };
			await executeAcpBuiltinSlashCommand(text, runtime as unknown as SlashCommandRuntime);
			return chunks.join("\n");
		};
		// With links forced on, the terminal panel draws each policy file as a link; a text host must not get one.
		applyHyperlinkSetting("always");
		try {
			const summary = await run("/sandbox");
			expect(summary).toContain("nono");
			expect(summary).toMatch(/yolo/i);
			expect(summary).not.toMatch(/always.ask/i);
			expect(summary).not.toContain("/work/app");
			const paths = await run("/sandbox paths");
			expect(paths).toContain("/work/app");
			const files = await run("/sandbox policy-files");
			expect(files).toContain("/run/nono/caps.json");
			expect(await run("/sandbox nowhere")).toContain("policy-files");
			for (const text of [summary, paths, files]) expect(text).not.toContain("\x1b");
		} finally {
			applyHyperlinkSetting("auto");
		}
	});
});
