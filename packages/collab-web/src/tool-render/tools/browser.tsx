/** `browser` — drive a Chromium tab: open/close named tabs, run puppeteer scripts. */
import type { ReactNode } from "react";
import { Badge, CodeBlock, ResultImages, ResultText, type Tone } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, num, shortenPath, str, truncate } from "../util";

interface BrowserDetails {
	action: string | null;
	name: string | null;
	url: string | null;
	browser: string | null;
}

function detailsOf(result: ToolRenderProps["result"]): BrowserDetails {
	const d = detailsRecord(result);
	return {
		action: d ? str(d.action) : null,
		name: d ? str(d.name) : null,
		url: d ? str(d.url) : null,
		browser: d ? str(d.browser) : null,
	};
}

interface AppArg {
	path: string | null;
	cdpUrl: string | null;
	target: string | null;
}

function appOf(args: Record<string, unknown>): AppArg | null {
	if (!isRecord(args.app)) return null;
	return { path: str(args.app.path), cdpUrl: str(args.app.cdp_url), target: str(args.app.target) };
}

function actionTone(action: string): Tone | undefined {
	switch (action) {
		case "open":
			return "ok";
		case "run":
			return "accent";
		case "close":
			return "warn";
		default:
			return undefined;
	}
}

/** Mirrors the TUI's `describeBrowser`: explicit app args win over reported mode. */
function describeBrowser(app: AppArg | null, details: BrowserDetails): string | null {
	if (app?.cdpUrl) return `connected ${app.cdpUrl}`;
	if (app?.path) return `spawned ${shortenPath(app.path)}`;
	return details.browser;
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsOf(result);
	const action = str(args.action) ?? details.action ?? "?";
	const closeAll = action === "close" && (args.all === true || (str(args.name) === null && details.name === null));
	const tab = details.name ?? str(args.name) ?? "main";
	const url = details.url ?? str(args.url);
	return (
		<>
			<Badge tone={actionTone(action)}>{action}</Badge>
			<span>{closeAll ? "all tabs" : tab}</span>
			{args.kill === true && <Badge tone="err">kill</Badge>}
			{url && <span className="tv-faint">{truncate(shortenPath(url), 72)}</span>}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsOf(result);
	const action = str(args.action) ?? details.action;
	const app = appOf(args);
	const tab = details.name ?? str(args.name);
	const url = details.url ?? str(args.url);
	const browserDesc = describeBrowser(app, details);
	const viewport = isRecord(args.viewport) ? args.viewport : null;
	const vpWidth = viewport ? num(viewport.width) : null;
	const vpHeight = viewport ? num(viewport.height) : null;
	const vpScale = viewport ? num(viewport.scale) : null;
	const code = str(args.code);
	return (
		<>
			<span className="tv-badges">
				{tab !== null && <Badge>tab {tab}</Badge>}
				{url && <Badge tone="accent">{truncate(shortenPath(url), 120)}</Badge>}
				{browserDesc && <Badge>{browserDesc}</Badge>}
				{app?.target && <Badge>target {app.target}</Badge>}
				{args.all === true && <Badge tone="warn">all</Badge>}
				{args.kill === true && <Badge tone="err">kill</Badge>}
				{vpWidth !== null && vpHeight !== null && (
					<Badge>
						{vpWidth}×{vpHeight}
						{vpScale !== null ? `@${vpScale}x` : ""}
					</Badge>
				)}
			</span>
			{action === "run" && code !== null && <CodeBlock code={code.replace(/\s+$/, "")} lang="javascript" />}
			<ResultImages result={result} />
			<ResultText result={result} maxLines={10} />
		</>
	);
}

export const browserRenderer: ToolRenderer = { Summary, Body };
