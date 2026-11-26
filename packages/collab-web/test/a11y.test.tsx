import { describe, expect, it } from "bun:test";
import type { AgentSnapshot, SessionEntry } from "@oh-my-pi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentDrawer } from "../src/components/agents/AgentDrawer";
import { AgentsPanel } from "../src/components/agents/AgentsPanel";
import { Banners } from "../src/components/shell/Banners";
import { ConnectScreen } from "../src/components/shell/ConnectScreen";
import { HeaderBar } from "../src/components/shell/HeaderBar";
import { Toasts } from "../src/components/shell/Toasts";
import { Transcript } from "../src/components/transcript/Transcript";
import { GuestClient } from "../src/lib/client";
import { encodeBase64Url } from "../src/lib/link";
import { ToolView } from "../src/tool-render";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const client = new GuestClient(LINK, "tester");

function queryAttr(html: string, selector: string, attr: string): string | null {
	let found: string | null = null;
	new HTMLRewriter()
		.on(selector, {
			element(el) {
				if (found === null) found = el.getAttribute(attr);
			},
		})
		.transform(html);
	return found;
}

function hasElement(html: string, selector: string): boolean {
	let found = false;
	new HTMLRewriter()
		.on(selector, {
			element() {
				found = true;
			},
		})
		.transform(html);
	return found;
}

describe("Accessibility — ConnectScreen", () => {
	it("renders skip link, header, main landmark, h1, and alert error wiring", () => {
		const html = renderToStaticMarkup(
			<ConnectScreen defaultName="guest" error="Invalid room link" onConnect={() => {}} />,
		);

		expect(queryAttr(html, "a.skip-link", "href")).toBe("#main-content");
		expect(queryAttr(html, "main#main-content", "tabindex")).toBe("-1");
		expect(hasElement(html, "header.sh-connect-top")).toBe(true);
		expect(hasElement(html, "h1.sh-connect-title")).toBe(true);
		expect(queryAttr(html, ".sh-connect-error", "role")).toBe("alert");
		expect(queryAttr(html, "input.sh-input-mono", "aria-invalid")).toBe("true");
		expect(queryAttr(html, "input.sh-input-mono", "aria-describedby")).toBeTruthy();
	});
});

describe("Accessibility — HeaderBar", () => {
	it("exposes h1 title, nav landmark, live status, and aria-expanded/aria-controls on agents toggle", () => {
		const closedHtml = renderToStaticMarkup(
			<HeaderBar
				header={null}
				state={null}
				phase="live"
				readOnly={false}
				subCount={2}
				railOpen={false}
				railControlsId="agents-rail"
				onToggleRail={() => {}}
				onLeave={() => {}}
			/>,
		);

		expect(hasElement(closedHtml, "header.sh-header")).toBe(true);
		expect(hasElement(closedHtml, "h1.sh-title")).toBe(true);
		expect(queryAttr(closedHtml, "nav.sh-header-right", "aria-label")).toBe("Session controls");
		expect(queryAttr(closedHtml, ".sh-status", "role")).toBe("status");
		expect(queryAttr(closedHtml, ".sh-status", "aria-live")).toBe("polite");
		expect(queryAttr(closedHtml, 'button[aria-controls="agents-rail"]', "aria-expanded")).toBe("false");
		expect(queryAttr(closedHtml, 'button[aria-controls="agents-rail"]', "aria-label")).toBe("Show agents panel");
		expect(hasElement(closedHtml, 'button[aria-label="Leave session"]')).toBe(true);

		const openHtml = renderToStaticMarkup(
			<HeaderBar
				header={null}
				state={null}
				phase="live"
				readOnly={false}
				subCount={2}
				railOpen={true}
				railControlsId="agents-rail"
				onToggleRail={() => {}}
				onLeave={() => {}}
			/>,
		);
		expect(queryAttr(openHtml, 'button[aria-controls="agents-rail"]', "aria-expanded")).toBe("true");
		expect(queryAttr(openHtml, 'button[aria-controls="agents-rail"]', "aria-label")).toBe("Hide agents panel");
	});
});

describe("Accessibility — Banners and Toasts", () => {
	it("sets aria-live polite on status banners and modal alertdialog on ended overlay", () => {
		const statusHtml = renderToStaticMarkup(
			<Banners phase="reconnecting" endedReason={null} loading={null} onRejoin={() => {}} onNewLink={() => {}} />,
		);
		expect(queryAttr(statusHtml, ".sh-banner", "role")).toBe("status");
		expect(queryAttr(statusHtml, ".sh-banner", "aria-live")).toBe("polite");

		const endedHtml = renderToStaticMarkup(
			<Banners
				phase="ended"
				endedReason="Host disconnected"
				loading={null}
				onRejoin={() => {}}
				onNewLink={() => {}}
			/>,
		);
		expect(queryAttr(endedHtml, ".sh-ended", "role")).toBe("alertdialog");
		expect(queryAttr(endedHtml, ".sh-ended", "aria-modal")).toBe("true");
		expect(queryAttr(endedHtml, ".sh-ended", "aria-labelledby")).toBe("sh-ended-title");
		expect(hasElement(endedHtml, "h2#sh-ended-title")).toBe(true);
	});

	it("marks error toasts with role=alert and accessible dismiss button", () => {
		const html = renderToStaticMarkup(
			<Toasts
				notices={[
					{ id: 1, level: "info", message: "Connected", at: Date.now() },
					{ id: 2, level: "error", message: "Stream interrupted", at: Date.now() },
				]}
			/>,
		);

		expect(queryAttr(html, ".sh-toasts", "aria-live")).toBe("polite");
		expect(queryAttr(html, ".sh-toast-info", "role")).toBe("status");
		expect(queryAttr(html, ".sh-toast-error", "role")).toBe("alert");
		expect(queryAttr(html, "button.sh-toast-close", "aria-label")).toBe("Dismiss notification");
	});
});

describe("Accessibility — AgentsPanel and AgentDrawer", () => {
	const sampleAgent: AgentSnapshot = {
		id: "sub-1",
		kind: "sub",
		displayName: "researcher",
		status: "running",
		hasSessionFile: false,
		createdAt: Date.now(),
		lastActivity: Date.now(),
	};

	it("renders semantic headings, aria-pressed state, and mobile close button in AgentsPanel", () => {
		const html = renderToStaticMarkup(
			<AgentsPanel
				agents={[sampleAgent]}
				progress={new Map()}
				lifecycle={new Map()}
				selectedId="sub-1"
				onSelect={() => {}}
				onClose={() => {}}
			/>,
		);

		expect(hasElement(html, "h2.ag-panel-title")).toBe(true);
		expect(hasElement(html, "h3.ag-heading")).toBe(true);
		expect(queryAttr(html, "button.ag-iconbtn", "aria-label")).toBe("Close agents panel");
		expect(queryAttr(html, "button.ag-row", "aria-pressed")).toBe("true");
	});

	it("renders modal dialog semantics and labelled heading in AgentDrawer", () => {
		const html = renderToStaticMarkup(<AgentDrawer agent={sampleAgent} client={client} onClose={() => {}} />);

		expect(queryAttr(html, "aside.ag-drawer", "role")).toBe("dialog");
		expect(queryAttr(html, "aside.ag-drawer", "aria-modal")).toBe("true");
		const labelledBy = queryAttr(html, "aside.ag-drawer", "aria-labelledby");
		expect(labelledBy).toBeTruthy();
		expect(queryAttr(html, "h2.ag-drawer-name", "id")).toBe(labelledBy);
		expect(hasElement(html, 'button[aria-label="Close agent drawer"]')).toBe(true);
	});
});

describe("Accessibility — Transcript and ToolView", () => {
	it("exposes log landmark on Transcript and aria-expanded on thinking toggle", () => {
		const entry: SessionEntry = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-11-25T00:00:00Z",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "checking steps" }],
				model: "test/model",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
				stopReason: "stop",
				timestamp: 1,
			},
		};
		const html = renderToStaticMarkup(
			<Transcript entries={[entry]} stream={null} streamDone={true} activeTools={new Map()} working={false} />,
		);

		expect(queryAttr(html, ".tr-root", "role")).toBe("log");
		expect(queryAttr(html, ".tr-root", "aria-live")).toBe("polite");
		expect(queryAttr(html, "button.tr-think-head", "aria-expanded")).toBe("false");
	});

	it("wires aria-expanded and aria-controls on ToolView disclosure button", () => {
		const closedHtml = renderToStaticMarkup(<ToolView name="read" args={{ path: "src/app.tsx" }} />);
		expect(queryAttr(closedHtml, "button.tv-head", "aria-expanded")).toBe("false");

		const openHtml = renderToStaticMarkup(<ToolView name="read" args={{ path: "src/app.tsx" }} defaultOpen />);
		expect(queryAttr(openHtml, "button.tv-head", "aria-expanded")).toBe("true");
		const controls = queryAttr(openHtml, "button.tv-head", "aria-controls");
		expect(controls).toBeTruthy();
		expect(queryAttr(openHtml, ".tv-body", "id")).toBe(controls);
	});
});
