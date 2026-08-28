import { describe, expect, it } from "bun:test";
import type {
	EventSinkPort,
	LifecycleEventDraft,
	RedactorPort,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/event-gateway";
import { EventGateway } from "@oh-my-pi/pi-coding-agent/memory-fabric/event-gateway";
import type { MemoryLifecycleEvent } from "@oh-my-pi/pi-coding-agent/memory-fabric/event-timeline";
import { projectEventTimeline } from "@oh-my-pi/pi-coding-agent/memory-fabric/event-timeline";
import type { ScopingContext } from "@oh-my-pi/pi-coding-agent/memory-fabric/scoping";
import type { SourceReference } from "@oh-my-pi/pi-coding-agent/memory-fabric/types";

const SCOPE: ScopingContext = {
	projectId: "proj-1",
	worktreeId: "main",
	branchId: "br_abc",
	sessionId: "sess-1",
	taskId: "task-1",
	agentId: "agent-a",
};

const SOURCE: SourceReference = { type: "manual", id: "src-1" };

class MemorySink implements EventSinkPort {
	events: LifecycleEventDraft[] = [];
	failNext = false;

	append(event: LifecycleEventDraft): void {
		if (this.failNext) {
			this.failNext = false;
			throw new Error("sink down");
		}
		this.events.push(event);
	}
}

const UPPER_REDACTOR: RedactorPort = {
	redactText: text => ({ redacted: text.replaceAll("hunter2", "[REDACTED]"), hasSecrets: text.includes("hunter2") }),
	redactObject: value => ({ ...value, scrubbed: true }),
};

function gateway(sink: MemorySink, overrides: Partial<ConstructorParameters<typeof EventGateway>[0]> = {}) {
	return new EventGateway({ sink, scope: SCOPE, now: () => new Date("2024-01-01T00:00:00Z"), ...overrides });
}

describe("EventGateway", () => {
	it("builds a scoped, validated record and enqueues a memory-write event", async () => {
		const sink = new MemorySink();
		const gw = gateway(sink);
		const result = gw.recordEvent({ type: "fact", content: "the sky is blue", sourceRefs: [SOURCE] });
		await gw.flush();

		expect(result.recordId).toMatch(/^mem_/);
		expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
		expect(result.redacted).toBe(false);
		expect(sink.events.length).toBe(1);
		const event = sink.events[0];
		expect(event?.type).toBe("memory-write");
		expect(event?.sessionId).toBe("sess-1");
		expect(event?.record?.projectId).toBe("proj-1");
		expect(event?.record?.agentId).toBe("agent-a");
	});

	it("redacts content and structured data only when enabled", async () => {
		const sink = new MemorySink();
		const gw = gateway(sink, { redactor: UPPER_REDACTOR, redactSecrets: true });
		const result = gw.recordEvent({
			type: "fact",
			content: "password is hunter2",
			structured: { note: "x" },
			sourceRefs: [SOURCE],
		});
		await gw.flush();

		expect(result.redacted).toBe(true);
		expect(sink.events[0]?.record?.content).toBe("password is [REDACTED]");
		expect(sink.events[0]?.record?.structured?.scrubbed).toBe(true);

		const offSink = new MemorySink();
		const off = gateway(offSink, { redactor: UPPER_REDACTOR, redactSecrets: false });
		const offResult = off.recordEvent({ type: "fact", content: "password is hunter2", sourceRefs: [SOURCE] });
		await off.flush();
		expect(offResult.redacted).toBe(false);
		expect(offSink.events[0]?.record?.content).toContain("hunter2");
	});

	it("truncates over-long content with a marker", async () => {
		const sink = new MemorySink();
		const gw = gateway(sink, { maxContentLength: 10 });
		gw.recordEvent({ type: "fact", content: "a".repeat(50), sourceRefs: [SOURCE] });
		await gw.flush();
		const content = sink.events[0]?.record?.content ?? "";
		expect(content.startsWith("aaaaaaaaaa")).toBe(true);
		expect(content.endsWith("...[TRUNCATED]")).toBe(true);
	});

	it("rejects derived records without a sourceRef but allows bare evidence", () => {
		const sink = new MemorySink();
		const gw = gateway(sink);
		expect(() => gw.recordEvent({ type: "fact", content: "orphan", sourceRefs: [] })).toThrow(/sourceRef/);
		expect(() => gw.recordEvent({ type: "evidence", content: "raw", sourceRefs: [] })).not.toThrow();
	});

	it("records evidence with correction-boosted scores", async () => {
		const sink = new MemorySink();
		const gw = gateway(sink);
		gw.recordEvidence("user-correction", { was: "x", now: "y" }, SOURCE);
		gw.recordEvidence("tool-result", { ok: true }, SOURCE);
		await gw.flush();
		expect(sink.events[0]?.record?.confidence).toBe(1);
		expect(sink.events[0]?.record?.importance).toBe(1);
		expect(sink.events[1]?.record?.confidence).toBe(0.8);
		expect(sink.events[0]?.record?.tags).toEqual(["evidence", "user-correction"]);
	});

	it("emits checkpoint, maintenance, and deletion lifecycle events", async () => {
		const sink = new MemorySink();
		const gw = gateway(sink);
		gw.recordCheckpoint("ckpt-1", { currentStep: "compile", testStatus: "passing" });
		gw.recordMaintenance("decay", ["mem-1", "mem-2"], { reason: "expired" });
		gw.recordDeletion("mem-3");
		await gw.flush();

		expect(sink.events.map(e => e.type)).toEqual(["checkpoint", "maintenance", "memory-delete"]);
		expect(sink.events[0]?.recordId).toBe("ckpt-1");
		expect(sink.events[0]?.timestamp).toBe("2024-01-01T00:00:00.000Z");
		expect(sink.events[1]?.maintenance?.operation).toBe("decay");
		expect(sink.events[1]?.maintenance?.affectedIds).toEqual(["mem-1", "mem-2"]);
		expect(sink.events[2]?.recordId).toBe("mem-3");
	});

	it("counts sink failures without breaking later writes", async () => {
		const sink = new MemorySink();
		const errors: unknown[] = [];
		const gw = gateway(sink, { onError: error => errors.push(error) });
		sink.failNext = true;
		gw.recordDeletion("mem-lost");
		gw.recordDeletion("mem-kept");
		await gw.flush();

		expect(gw.droppedWrites).toBe(1);
		expect(errors.length).toBe(1);
		expect(sink.events.map(e => e.recordId)).toEqual(["mem-kept"]);
	});

	it("produces events the timeline projection consumes directly", async () => {
		const sink = new MemorySink();
		const gw = gateway(sink);
		gw.recordEvent({ type: "fact", content: "f1", sourceRefs: [SOURCE] });
		gw.recordCheckpoint("ckpt-1", { currentStep: "test" });
		await gw.flush();

		const events: MemoryLifecycleEvent[] = sink.events.map((event, index) => ({ ...event, seq: index + 1 }));
		const timeline = projectEventTimeline(events);
		expect(timeline.rowCount).toBe(2);
		expect(timeline.rows[0]?.category).toBe("memory");
		expect(timeline.rows[1]?.category).toBe("checkpoint");
		expect(timeline.sessions[0]?.sessionId).toBe("sess-1");
	});
});
