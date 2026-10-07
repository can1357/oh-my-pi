import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import {
	assertAttachmentOwner,
	attachmentTargetFilter,
	requestedAttachment,
	selectAttachmentTarget,
	selectedAttachmentTarget,
} from "../../src/tools/browser/ownership.ts";

const entries = [
	{
		id: "PAGEpersonal.7",
		type: "page",
		title: "Same account title",
		url: "https://example.test/private",
		active: "true",
	},
	{ id: "PAGEwork.7", type: "page", title: "Same account title", url: "https://example.test/work", active: "false" },
];

function target(entry, calls) {
	return {
		_targetId: entry.id,
		type: () => "page",
		page: async () => {
			calls.push(["attach", entry.id]);
			return { goto: async url => calls.push(["navigate", entry.id, url]) };
		},
	};
}

test("runtime smoke: default never attaches; an explicit host selection binds instance/tab before navigation", async () => {
	let reads = 0;
	const server = createServer((request, response) => {
		assert.equal(request.url, "/json");
		reads++;
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify(entries));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const endpoint = `http://127.0.0.1:${server.address().port}`;
	const calls = [];
	const targets = entries.map(entry => target(entry, calls));
	try {
		assert.equal(requestedAttachment(), undefined);
		assert.equal(requestedAttachment({ relay: false }), undefined);
		assert.equal(requestedAttachment({ path: "/agent-owned/chromium", relay: true }), undefined);
		assert.equal(reads, 0);
		assert.deepEqual(calls, []);
		assert.equal(requestedAttachment({ relay: true }), "relay");
		const selected = await selectAttachmentTarget(endpoint, async () => (await fetch(`${endpoint}/json`)).json(), {
			ownerSessionId: "task-work",
			hasUI: true,
			select: async (title, rows) => {
				assert.match(title, /task-work/);
				assert.match(title, /titles do not identify signed-in profiles/);
				assert.match(rows[1], /PAGEwork\.7/);
				assert.deepEqual(calls, []);
				return rows[1];
			},
		});
		assert.equal(selected, "PAGEwork.7");
		const filtered = targets.filter(attachmentTargetFilter(selected));
		assert.equal(filtered.length, 1);
		await (await selectedAttachmentTarget(filtered, selected).page()).goto("https://example.test/task");
		assert.deepEqual(calls, [
			["attach", "PAGEwork.7"],
			["navigate", "PAGEwork.7", "https://example.test/task"],
		]);
		assert.equal(reads, 2);
	} finally {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
});

test("missing UI, task identity, and noninteractive contexts fail before discovery", async () => {
	let reads = 0;
	for (const context of [
		{},
		{ ownerSessionId: "task" },
		{ ownerSessionId: "task", hasUI: false, select: async () => "anything" },
	]) {
		await assert.rejects(
			selectAttachmentTarget(
				"http://isolated",
				async () => {
					reads++;
					return entries;
				},
				context,
			),
			/interactive host-user/,
		);
	}
	assert.equal(reads, 0);
});

test("cancellation and an invented selection cannot attach any tab", async () => {
	for (const choice of [undefined, "not a listed tab"]) {
		await assert.rejects(
			selectAttachmentTarget("http://isolated", async () => entries, {
				ownerSessionId: "task",
				select: async () => choice,
			}),
			/cancelled/,
		);
	}
});

test("matcher filters choices but cannot override the chosen exact instance", async () => {
	const id = await selectAttachmentTarget(
		"http://isolated",
		async () => entries,
		{
			ownerSessionId: "task",
			select: async (_title, rows) => {
				assert.equal(rows.length, 1);
				assert.match(rows[0], /PAGEwork/);
				return rows[0];
			},
		},
		"/work",
	);
	assert.equal(id, "PAGEwork.7");
});

test("disappeared, navigated and discarded selections fail without active-tab fallback", async () => {
	for (const current of [
		entries.slice(0, 1),
		[entries[0], { ...entries[1], url: "https://different.test/" }],
		[entries[0], { ...entries[1], discarded: "true" }],
	]) {
		let reads = 0;
		await assert.rejects(
			selectAttachmentTarget("http://isolated", async () => (++reads === 1 ? entries : current), {
				ownerSessionId: "task",
				select: async (_title, rows) => rows[1],
			}),
			/changed or disappeared/,
		);
	}
});

test("an abort while the picker is open never publishes attachment permission", async () => {
	const controller = new AbortController();
	await assert.rejects(
		selectAttachmentTarget(
			"http://isolated",
			async () => entries,
			{
				ownerSessionId: "task",
				select: async (_title, rows) => {
					controller.abort(new Error("interrupted task"));
					return rows[1];
				},
			},
			undefined,
			controller.signal,
		),
		/interrupted task/,
	);
});

test("exact target resolution never probes another visible tab", () => {
	const calls = [];
	assert.throws(() => selectedAttachmentTarget([target(entries[0], calls)], "PAGEwork.7"), /no longer available/);
	assert.deepEqual(calls, []);
	const filter = attachmentTargetFilter("PAGEwork.7");
	assert.equal(filter({ type: () => "tab", _targetId: "TABwork.7" }), true);
	assert.equal(filter({ type: () => "tab", _targetId: "TABpersonal.7" }), false);
	assert.equal(filter({ type: () => "other", _targetId: "iframe" }), true);
});

test("approved named attachments belong to the approving task only", () => {
	for (const kind of ["relay", "connected"]) {
		assert.doesNotThrow(() => assertAttachmentOwner(kind, "task-work", "task-work"));
		assert.throws(() => assertAttachmentOwner(kind, "task-work", "other-task"), /another task/);
		assert.throws(() => assertAttachmentOwner(kind, undefined, undefined), /another task/);
	}
	assert.doesNotThrow(() => assertAttachmentOwner("headless", "task-work", "other-task"));
});
