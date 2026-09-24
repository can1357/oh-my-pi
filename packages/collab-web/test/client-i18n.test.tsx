import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import "./transcript-dom-shim";
import type { GuestSnapshot } from "../src/lib/client";
import type { AgentSnapshot } from "@oh-my-pi/pi-wire";
import { ConnectScreen } from "../src/components/shell/ConnectScreen";
import { AgentDrawer } from "../src/components/agents/AgentDrawer";
import { Banners } from "../src/components/shell/Banners";
import { Composer } from "../src/components/shell/Composer";
import { AgentsPanel } from "../src/components/agents/AgentsPanel";
import { Transcript } from "../src/components/transcript/Transcript";
import { InvalidArg } from "../src/tool-render/parts";
import { Badge, Kv, Output, Row } from "../src/tool-render/parts";
import { ToolView } from "../src/tool-render/ToolView";
import { GuestClient } from "../src/lib/client";
import { CollabI18nProvider } from "../src/lib/i18n";

const client = new GuestClient(`roomroomroom1234#${"A".repeat(43)}`, "tester");

function composerSnapshot(): GuestSnapshot {
	return {
		phase: "live",
		endedReason: null,
		header: null,
		entries: [],
		state: { isStreaming: true, queuedMessageCount: 2, cwd: "/work", participants: [] },
		agents: [],
		progress: new Map(),
		lifecycle: new Map(),
		stream: null,
		streamDone: false,
		activeTools: new Map(),
		working: true,
		readOnly: false,
		uiRequest: { reqId: 1, kind: "editor", title: "Continue?", prefill: "draft" },
		notices: [],
	};
}

describe("collab client i18n", () => {
	it("renders the connect form in Chinese while preserving user-input placeholders", () => {
		const html = renderToStaticMarkup(
			<CollabI18nProvider initialPreference="zh-CN">
				<ConnectScreen defaultName="guest" error={null} onConnect={() => {}} />
			</CollabI18nProvider>,
		);

		expect(html).toContain("连接");
		expect(html).toContain("加入链接");
		expect(html).toContain("ws://host:port/r/room.key");
	});

	it("translates Composer chrome without translating the host ask title", () => {
		const html = renderToStaticMarkup(
			<CollabI18nProvider initialPreference="zh-CN">
				<Composer client={client} snapshot={composerSnapshot()} />
			</CollabI18nProvider>,
		);

		expect(html).toContain("Continue?");
		expect(html).toContain("取消");
		expect(html).toContain("停止");
		expect(html).not.toContain(">Cancel<");
	});

	it("translates session banners and empty agent state", () => {
		const html = renderToStaticMarkup(
			<CollabI18nProvider initialPreference="zh-CN">
				<>
					<Banners phase="ended" endedReason="host left" onRejoin={() => {}} onNewLink={() => {}} />
					<AgentsPanel
						agents={[]}
						progress={new Map()}
						lifecycle={new Map()}
						selectedId={null}
						onSelect={() => {}}
					/>
				</>
			</CollabI18nProvider>,
		);

		expect(html).toContain("会话已结束");
		expect(html).toContain("重新加入");
		expect(html).toContain("暂无子代理");
		expect(html).not.toContain(">Rejoin<");
	});

	it("translates transcript empty and working states", () => {
		const html = renderToStaticMarkup(
			<CollabI18nProvider initialPreference="zh-CN">
				<>
					<Transcript entries={[]} stream={null} streamDone={true} activeTools={new Map()} working={false} />
					<Transcript entries={[]} stream={null} streamDone={true} activeTools={new Map()} working={true} />
				</>
			</CollabI18nProvider>,
		);

		expect(html).toContain("暂无活动");
		expect(html).toContain("思考中…");
		expect(html).not.toContain(">no activity yet<");
	});

	it("translates agent drawer and shared tool validation chrome", () => {
		const agent: AgentSnapshot = {
			id: "sub-1",
			displayName: "worker",
			kind: "sub",
			status: "parked",
			hasSessionFile: false,
			createdAt: 1,
			lastActivity: 2,
		};
		const html = renderToStaticMarkup(
			<CollabI18nProvider initialPreference="zh-CN">
				<>
					<AgentDrawer agent={agent} client={client} onClose={() => {}} />
					<InvalidArg what="path" />
					<ToolView name="probe_tool" running />
				</>
			</CollabI18nProvider>,
		);

		expect(html).toContain("暂无会话记录");
		expect(html).toContain("恢复");
		expect(html).toContain("无效 path");
		expect(html).toContain('aria-label="运行中"');
		expect(html).not.toContain(">revive<");
	});

	it("translates common goal and async-job tool chrome", () => {
		const html = renderToStaticMarkup(
			<CollabI18nProvider initialPreference="zh-CN">
				<>
					<ToolView name="goal" args={{ op: "get", token_budget: 1000 }} defaultOpen />
					<ToolView name="job" args={{}} />
				</>
			</CollabI18nProvider>,
		);

		expect(html).toContain("预算");
		expect(html).toContain("全部运行中的任务");
		expect(html).not.toContain("all running jobs");
	});

	it("translates shared tool labels while preserving tool values", () => {
		const html = renderToStaticMarkup(
			<CollabI18nProvider initialPreference="zh-CN">
				<>
					<Badge tone="warn">truncated</Badge>
					<Kv k="path">/tmp/user-file.ts</Kv>
					<Row k="query">search text</Row>
					<Output text="result" title="context" />
				</>
			</CollabI18nProvider>,
		);

		expect(html).toContain("已截断");
		expect(html).toContain("路径");
		expect(html).toContain("查询");
		expect(html).toContain("上下文");
		expect(html).toContain("/tmp/user-file.ts");
		expect(html).toContain("search text");
	});
});
