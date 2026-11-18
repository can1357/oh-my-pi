import { discoverRelayEndpoints } from "../../coding-agent/src/tools/browser/relay/discovery";
/**
 * Manual end-to-end smoke for the relay: replicates the omp browser tool's
 * connection pattern against a live relay + extension.
 *
 * The tool opens TWO puppeteer connections per driven tab — the supervisor
 * (`puppeteer.connect({browserURL})`, picks a target) and a tab worker
 * (`puppeteer.connect({browserWSEndpoint})`, adopts that target by id) — so
 * this script does exactly that, then exercises evaluate/navigate/screenshot,
 * an extra CDP session, and the createTarget/closeTarget path.
 *
 * Usage: bun scripts/smoke.ts [relay-url] [target-substring]
 */
import type { Target } from "puppeteer-core";
import puppeteer from "puppeteer-core";

const relayUrl = Bun.argv[2] ?? discoverRelayEndpoints()[0];
if (!relayUrl) throw new Error("No local omp browser relay found; supply the relay URL explicitly.");
const matcher = Bun.argv[3] ?? "Relay Smoke Page";

/** Puppeteer keeps the CDP target id on an internal field; same access the omp tab supervisor uses (`targetIdForPage`). */
function targetIdOf(target: Target): string {
	// Internal puppeteer field, not on the public type.
	const raw = target as unknown as { _targetId: string };
	return raw._targetId;
}

function step(name: string): void {
	console.log(`\n== ${name}`);
}

step("supervisor: connect via browserURL");
const supervisor = await puppeteer.connect({ browserURL: relayUrl, defaultViewport: null, protocolTimeout: 20_000 });
console.log("version:", await supervisor.version());

step("supervisor: pick a tab from the relay's /json metadata");
// The supervisor must not attach tabs: Chrome shows its debugger infobar for every attachment.
// A tab worker claims the chosen tab, and the relay attaches only claimed tabs.
const entries = (await (await fetch(`${relayUrl.replace(/\/+$/, "")}/json/list`)).json()) as Array<{
	id: string;
	type?: string;
	title?: string;
	url: string;
}>;
console.log(
	"pages:",
	entries.map(entry => entry.url),
);
const picked = entries.find(
	entry =>
		(entry.type === undefined || entry.type === "page") &&
		(entry.url.includes(matcher) || (entry.title ?? "").includes(matcher)),
);
if (!picked) throw new Error(`no page matching ${JSON.stringify(matcher)}`);
const targetId = picked.id;
const wsEndpoint = new URL(supervisor.wsEndpoint());
wsEndpoint.searchParams.set("claim", targetId);
console.log("picked target:", targetId, "ws:", wsEndpoint.toString());

step("worker: second connection via browserWSEndpoint");
const worker = await puppeteer.connect({
	browserWSEndpoint: wsEndpoint.toString(),
	defaultViewport: null,
	protocolTimeout: 20_000,
});
const workerTarget = await worker.waitForTarget(target => targetIdOf(target) === targetId, { timeout: 10_000 });
const page = await workerTarget.page();
if (!page) throw new Error("worker could not adopt page");

step("worker: evaluate on existing tab");
console.log("title:", await page.title());
// String form: the callback body runs in the page; a function literal would need the DOM lib.
console.log("hero:", await page.evaluate(`document.querySelector("#hero")?.textContent ?? "(no hero)"`));

step("worker: extra CDP session (screenshot path)");
const session = await page.createCDPSession();
const frameTree = (await session.send("Page.getFrameTree")) as { frameTree: { frame: { url: string } } };
console.log("frame url:", frameTree.frameTree.frame.url);
await session.detach();

step("worker: navigate existing tab");
await page.goto("https://example.com/?relay-smoke", { waitUntil: "load", timeout: 20_000 });
console.log("navigated:", page.url(), "/", await page.title());

step("worker: screenshot");
const shot = await page.screenshot({ type: "png" });
console.log("screenshot bytes:", shot.byteLength);

step("supervisor: newPage (Target.createTarget) + close (Target.closeTarget)");
const fresh = await supervisor.newPage();
await fresh.goto("about:blank");
console.log("new page url:", fresh.url());
await fresh.close();
console.log("closed");

step("disconnect both");
await worker.disconnect();
await supervisor.disconnect();

console.log("\nSMOKE OK");
process.exit(0);
