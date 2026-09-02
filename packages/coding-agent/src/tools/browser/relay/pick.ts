import type { Browser, Page, Target } from "puppeteer-core";
import { throwIfAborted, ToolError } from "../../tool-errors";

// Duplicated from attach.ts so this module can load without pi-natives (attach.ts imports Process).
const ATTACH_TARGET_SKIP_PATTERN =
	/request[\s_-]?handler|devtools|background[\s_-]?(?:page|host)|service[\s_-]?worker/i;

const MAX_CLAIM_ROUNDS = 3;
const CDP_ERROR_TAB_CLAIMED = -32050;

interface TargetInfoLike {
	title?: string;
	ompClaimedBy?: string;
}

interface RelayPage {
	target: Target;
	id: string;
	url: string;
	title: string;
	claimedBy?: string;
	page?: Page | null;
}

export function relayClaimOwner(name: string): string {
	return `omp:${process.pid}:${name}`;
}

export async function targetIdForPage(page: Page): Promise<string> {
	return await targetIdForTarget(page.target());
}

export async function targetIdForTarget(target: Target): Promise<string> {
	// CdpTarget stores the protocol id on `_targetId`; public Target has no getter.
	const raw = target as unknown as { _targetId?: unknown };
	if (typeof raw._targetId === "string") return raw._targetId;
	const session = await target.createCDPSession();
	try {
		const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
		if (info.targetInfo?.targetId) return info.targetInfo.targetId;
		throw new ToolError("Target id unavailable from CDP target info");
	} finally {
		await session.detach().catch(() => undefined);
	}
}

export async function pickAndClaimRelayTarget(
	browser: Browser,
	opts: { matcher?: string; owner: string; signal?: AbortSignal },
): Promise<{ page: Page; targetId: string }> {
	const exclude = new Set<string>();
	let lastConflict: unknown;
	for (let round = 0; round < MAX_CLAIM_ROUNDS; round++) {
		throwIfAborted(opts.signal);
		const candidate = await selectRelayCandidate(browser, opts.matcher, exclude);
		const page = candidate.page ?? (await candidate.target.page());
		if (!page) throw new ToolError(`Target ${candidate.id} is no longer available on the attached browser`);
		try {
			await sendRelayOwner(page, "OMP.claimTarget", opts.owner);
			return { page, targetId: await targetIdForPage(page) };
		} catch (err) {
			if (protocolErrorCode(err) !== CDP_ERROR_TAB_CLAIMED) throw err;
			exclude.add(candidate.id);
			lastConflict = err;
		}
	}
	throw new ToolError(lastConflict instanceof Error ? lastConflict.message : String(lastConflict));
}

export async function releaseRelayClaim(page: Page, owner: string): Promise<void> {
	try {
		await sendRelayOwner(page, "OMP.releaseTarget", owner);
	} catch {
		// Best-effort: non-relay backends reject the unknown method.
	}
}

async function selectRelayCandidate(
	browser: Browser,
	matcher: string | undefined,
	exclude: ReadonlySet<string>,
): Promise<RelayPage> {
	const pages = await listRelayPages(browser, exclude);
	if (matcher) {
		const needle = matcher.toLowerCase();
		const matches = pages.filter(p => p.url.toLowerCase().includes(needle) || p.title.toLowerCase().includes(needle));
		if (matches.length === 0) {
			throw new ToolError(
				`No page target matched ${JSON.stringify(matcher)}. Available pages:\n${formatPageList(pages)}`,
			);
		}
		const unclaimed = matches.filter(p => !p.claimedBy);
		if (unclaimed.length === 0) {
			throw new ToolError(
				`Every tab matching ${JSON.stringify(matcher)} is already driven by another omp session:\n${formatPageList(matches)}\nPass a different target, or omit target and pass url to open your own tab.`,
			);
		}
		return unclaimed[0]!;
	}

	const usable = pages.filter(
		p => !ATTACH_TARGET_SKIP_PATTERN.test(p.url) && !ATTACH_TARGET_SKIP_PATTERN.test(p.title),
	);
	if (usable.length === 0) {
		throw new ToolError("No free tab to adopt on the relay: no usable page targets. Pass url to open your own tab.");
	}
	const visibility = await Promise.all(
		usable.map(async p => {
			try {
				const page = await p.target.page();
				p.page = page;
				if (!page) return false;
				return (await page.evaluate(() => document.visibilityState === "visible")) === true;
			} catch {
				return false;
			}
		}),
	);
	const foreground = visibility.indexOf(true);
	if (foreground >= 0) {
		const visible = usable[foreground]!;
		if (visible.claimedBy) {
			throw new ToolError(
				`The visible tab (${visible.title} ${visible.url}) is already driven by omp session ${visible.claimedBy}. Pass app.target to pick another tab, or url to open your own.`,
			);
		}
		return visible;
	}
	const unclaimed = usable.filter(p => !p.claimedBy);
	if (unclaimed.length === 0) {
		throw new ToolError(
			"No free tab to adopt on the relay: every usable tab is driven by another omp session. Pass url to open your own tab.",
		);
	}
	return unclaimed[0]!;
}

async function listRelayPages(browser: Browser, exclude: ReadonlySet<string>): Promise<RelayPage[]> {
	const pages: RelayPage[] = [];
	for (const target of browser.targets()) {
		if (String(target.type()) !== "page") continue;
		let id: string;
		try {
			id = await targetIdForTarget(target);
		} catch {
			continue;
		}
		if (exclude.has(id)) continue;
		const info = relayTargetInfo(target);
		pages.push({
			target,
			id,
			url: target.url(),
			title: (info.title ?? "").trim(),
			claimedBy: info.ompClaimedBy,
		});
	}
	return pages;
}

function relayTargetInfo(target: Target): TargetInfoLike {
	// CdpTarget._getTargetInfo() returns the cached protocol TargetInfo; ompClaimedBy survives on it.
	const cdpTarget = target as { _getTargetInfo?: () => TargetInfoLike };
	return cdpTarget._getTargetInfo?.() ?? {};
}

function formatPageList(pages: RelayPage[]): string {
	return pages
		.map(p => {
			const line = `- ${p.title || "(untitled)"}  ${p.url}`;
			return p.claimedBy ? `${line}  [driven by ${p.claimedBy}]` : line;
		})
		.join("\n");
}

async function sendRelayOwner(
	page: Page,
	method: "OMP.claimTarget" | "OMP.releaseTarget",
	owner: string,
): Promise<void> {
	const session = await page.createCDPSession();
	try {
		// Puppeteer's protocol map cannot express the relay-private methods.
		const raw = session as unknown as { send(method: string, params?: { owner: string }): Promise<unknown> };
		await raw.send(method, { owner });
	} finally {
		await session.detach().catch(() => undefined);
	}
}

function protocolErrorCode(err: unknown): number | undefined {
	if (!err || typeof err !== "object" || !("code" in err)) return undefined;
	return typeof err.code === "number" ? err.code : undefined;
}
