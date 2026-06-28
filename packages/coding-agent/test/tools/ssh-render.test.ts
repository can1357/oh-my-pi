import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import { previewWindowRows } from "@pk-nerdsaver-ai/pi-coding-agent/tools/render-utils";
import { sshToolRenderer } from "@pk-nerdsaver-ai/pi-coding-agent/tools/ssh";
import { sanitizeText } from "@pk-nerdsaver-ai/pi-utils";

beforeAll(async () => {
	await initTheme();
});

describe("sshToolRenderer", () => {
	it("keeps the status header on one line when the command spans multiple lines", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		expect(uiTheme).toBeDefined();
		const command = ["set -e", "cat > /etc/apt/sources.list <<'EOF'", "# mirrors", "EOF"].join("\n");
		const component = sshToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }] },
			{ expanded: false, isPartial: false },
			uiTheme,
			{ host: "router", command },
		);
		const rendered = component.render(120);
		const sanitized = rendered.map(line => sanitizeText(line));
		// First visible row is the status header, and it MUST remain a single line.
		// It carries the host but NOT the command — the command lives in the body.
		const header = sanitized[0]!;
		expect(header).toContain("SSH");
		expect(header).toContain("[router]");
		expect(header).not.toContain("set -e");
		expect(header).not.toContain("EOF");
		// Every command line still appears, inside the framed body.
		const body = sanitized.slice(1).join("\n");
		expect(body).toContain("$ set -e");
		expect(body).toContain("cat > /etc/apt/sources.list <<'EOF'");
		expect(body).toContain("# mirrors");
		expect(body).toContain("EOF");
	});

	it("keeps the pending-call header on one line for multiline commands", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		expect(uiTheme).toBeDefined();
		const command = "set -e\ndo-something";
		const component = sshToolRenderer.renderCall(
			{ host: "router", command },
			{ expanded: false, isPartial: true },
			uiTheme,
		);
		const rendered = component.render(120);
		const sanitized = rendered.map(line => sanitizeText(line));
		const header = sanitized[0]!;
		expect(header).toContain("SSH");
		expect(header).toContain("[router]");
		expect(header).not.toContain("set -e");
		expect(header).not.toContain("do-something");
		const body = sanitized.slice(1).join("\n");
		expect(body).toContain("$ set -e");
		expect(body).toContain("do-something");
	});

	it("keeps partial results pending until the final SSH result", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		expect(uiTheme).toBeDefined();
		const renderHeader = (isPartial: boolean) =>
			sanitizeText(
				sshToolRenderer
					.renderResult(
						{ content: [{ type: "text", text: isPartial ? "streaming" : "done" }] },
						{ expanded: false, isPartial },
						uiTheme,
						{ host: "sccpu", command: "uptime" },
					)
					.render(120)[0]!,
			);

		expect(renderHeader(true)).toContain("⏳ SSH: [sccpu]");
		expect(renderHeader(false)).toContain("⇄ SSH: [sccpu]");
	});
	it("renders the collapsed command as a viewport tail window in every state — no stream→final expansion", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		expect(uiTheme).toBeDefined();
		const total = previewWindowRows() + 5;
		const command = Array.from({ length: total }, (_, i) => `step_${i}`).join("\n");
		const render = (opts: { expanded: boolean; isPartial: boolean }) =>
			sanitizeText(
				sshToolRenderer
					.renderResult({ content: [{ type: "text", text: "" }] }, opts, uiTheme, { host: "router", command })
					.render(120)
					.join("\n"),
			);

		// Identical tail window streaming and final: the end stays visible, the
		// head is elided behind an "earlier lines" marker. Only ctrl+o uncaps.
		for (const rendered of [
			render({ expanded: false, isPartial: true }),
			render({ expanded: false, isPartial: false }),
		]) {
			expect(rendered).toContain(`step_${total - 1}`);
			expect(rendered).toContain("earlier line");
			expect(rendered).not.toContain("step_0");
		}

		const expandedFinal = render({ expanded: true, isPartial: false });
		expect(expandedFinal).toContain("$ step_0");
		expect(expandedFinal).not.toContain("earlier line");
	});
});
