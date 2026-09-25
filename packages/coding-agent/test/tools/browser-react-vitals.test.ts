import type { Server } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const fixtureDir = path.join(import.meta.dir, "../fixtures");
const reactFixture = Bun.file(path.join(fixtureDir, "react-18.3.1.production.min.js"));
const reactDomFixture = Bun.file(path.join(fixtureDir, "react-dom-18.3.1.production.min.js"));

const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	settings: Settings.isolated({
		"browser.enabled": true,
		"browser.headless": true,
		"browser.cmux": false,
		"tools.maxTimeout": 0,
	}),
};
const prelude = createBrowserPrelude(session);
let callId = 0;

async function invoke(parameters: Record<string, unknown>) {
	callId += 1;
	return await prelude.invoke(parameters, { session, toolCallId: `browser-react-vitals-${callId}` });
}

function directCall(name: string, method: string, args: unknown[] = []) {
	return invoke({ action: "call", name, chain: [{ method, args }] });
}

function valueFrom<T>(result: { details?: unknown }): T {
	const details = result.details;
	if (!details || typeof details !== "object" || !("value" in details)) {
		throw new Error("Expected browser result details.value");
	}
	return details.value as T;
}

interface TreeNode {
	id: number;
	name: string;
	children: TreeNode[];
}

function findTreeNode(nodes: TreeNode[], name: string): TreeNode | undefined {
	for (const node of nodes) {
		if (node.name === name) return node;
		const nested = findTreeNode(node.children, name);
		if (nested) return nested;
	}
	return undefined;
}

let server: Server<undefined>;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const pathname = new URL(request.url).pathname;
			if (pathname === "/react.js") {
				return new Response(reactFixture, { headers: { "content-type": "text/javascript" } });
			}
			if (pathname === "/react-dom.js") {
				return new Response(reactDomFixture, { headers: { "content-type": "text/javascript" } });
			}
			return new Response(
				`<!doctype html>
<html><head><title>React fixture</title></head><body>
<div id="root"></div>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script>
const { Suspense, useState } = React;
function Counter() {
	const [count, setCount] = useState(0);
	return React.createElement("button", { id: "counter", onClick: () => setCount(value => value + 1) }, String(count));
}
function App() {
	return React.createElement(Suspense, { fallback: React.createElement("p", null, "Loading") }, React.createElement(Counter));
}
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
</script>
</body></html>`,
				{ headers: { "content-type": "text/html" } },
			);
		},
	});
});

afterAll(async () => {
	server.stop(true);
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser React introspection and Web Vitals", () => {
	test("captures buffered paint, navigation, layout-shift, and long-task metrics", async () => {
		const page = encodeURIComponent(
			'<!doctype html><html><head><style>body{margin:0}#target{height:80px;background:#ddd}</style></head><body><div id="target">Contentful paint</div></body></html>',
		);
		await invoke({ action: "open", name: "vitals", url: `data:text/html;charset=utf-8,${page}` });
		await invoke({
			action: "run",
			name: "vitals",
			code: `await tab.evaluate(() => {
				const spacer = document.createElement("div");
				spacer.style.height = "120px";
				spacer.textContent = "late content";
				document.body.prepend(spacer);
				document.body.getBoundingClientRect();
			});`,
		});
		const response = await directCall("vitals", "vitals", [{ reload: false }]);
		const value = valueFrom<Record<string, unknown>>(response);
		expect(typeof value.fcp).toBe("number");
		expect(typeof value.ttfb).toBe("number");
		expect(typeof value.domContentLoaded).toBe("number");
		expect(typeof value.load).toBe("number");
		expect(typeof value.longTasks).toBe("number");
		expect(value.cls as number).toBeGreaterThanOrEqual(0);
	}, 30_000);

	test("walks, inspects, profiles, and reports Suspense for a React 18 app", async () => {
		await invoke({ action: "open", name: "react", url: server.url.href });
		const missingHook = await invoke({
			action: "run",
			name: "react",
			code: `try {
				await tab.reactTree();
				return null;
			} catch (error) {
				return { name: error.constructor.name, message: error.message };
			}`,
		});
		expect(valueFrom<unknown>(missingHook)).toEqual({
			name: "ToolError",
			message: "React DevTools hook not installed — call tab.reactEnable() first",
		});

		const enabled = await directCall("react", "reactEnable");
		const enabledValue = valueFrom<{ installed: boolean; reactVersion?: string }>(enabled);
		expect(enabledValue.installed).toBe(true);
		expect(enabledValue.reactVersion?.startsWith("18.3.1")).toBe(true);
		await invoke({
			action: "run",
			name: "react",
			code: 'await tab.waitForSelector("#counter");',
		});

		const treeResponse = await directCall("react", "reactTree");
		const tree = valueFrom<TreeNode[]>(treeResponse);
		const app = findTreeNode(tree, "App");
		const suspense = findTreeNode(app?.children ?? [], "Suspense");
		const counter = findTreeNode(suspense?.children ?? [], "Counter");
		expect(app).toBeDefined();
		expect(suspense).toBeDefined();
		expect(counter).toBeDefined();

		const inspected = await directCall("react", "reactInspect", [counter!.id]);
		const inspection = valueFrom<{ state?: Array<{ index: number; kind: string; value: unknown }> }>(inspected);
		expect(inspection.state).toContainEqual({ index: 0, kind: "State", value: 0 });

		await directCall("react", "reactRenders", [{ action: "start" }]);
		await directCall("react", "click", ["#counter"]);
		await invoke({
			action: "run",
			name: "react",
			code: 'await page.waitForFunction(() => document.querySelector("#counter")?.textContent === "1");',
		});
		const rendersResponse = await directCall("react", "reactRenders", [{ action: "stop" }]);
		const renders = valueFrom<{
			commits: number;
			components: Array<{ name: string; renders: number; totalMs: number }>;
		}>(rendersResponse);
		expect(renders.commits).toBeGreaterThanOrEqual(1);
		const counterRenders = renders.components.find(component => component.name === "Counter");
		expect(counterRenders).toBeDefined();
		expect(counterRenders!.renders).toBeGreaterThanOrEqual(1);

		const suspenseResponse = await directCall("react", "reactSuspense");
		const boundaries = valueFrom<Array<{ state: string; classification: string }>>(suspenseResponse);
		expect(boundaries).toContainEqual(expect.objectContaining({ state: "resolved", classification: "static" }));
	}, 30_000);
});
