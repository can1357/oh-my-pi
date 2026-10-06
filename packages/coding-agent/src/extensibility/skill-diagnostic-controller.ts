import * as fs from "node:fs/promises";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import {
	analyzeResources,
	preflightResourceAnalysis,
	resolveResourceAnalysisModel,
	type ResourceAnalysis,
} from "./resource-analysis";
import { SEND_DISCLOSURE } from "./resource-consent";
import { excludeReviewedResources, StaleResourceReviewError } from "./resource-decisions";
import { snapshotResource, type ResourceCandidate, type ResourceSnapshot } from "./resource-snapshot";
import {
	serializeSkillDiagnosticEntry,
	type SkillDiagnosticEntry,
	type SkillDiagnosticDuplicate,
} from "./skill-diagnostics";
import type { SkillSelectionReason } from "./skills";

export type SkillAnalysisStatus = "prepared" | "running" | "complete" | "failed" | "cancelled" | "applied" | "stale";
export interface SkillAnalysisCandidate {
	id: string;
	name: string;
	filePath: string;
	root: string;
	fingerprint: string;
	complete: boolean;
	files: number;
	omissions: string[];
}
export interface SkillDiagnosticAnalysisRecord {
	id: string;
	name: string;
	status: SkillAnalysisStatus;
	model: string;
	bytes: number;
	candidates: SkillAnalysisCandidate[];
	disclosure: string;
	createdAt: number;
	result?: ResourceAnalysis;
	error?: string;
	applied: boolean;
}
export type SkillDiagnosticIssue = "conflict" | "redundancy" | "missing-provenance";
export interface SkillDiagnosticItem {
	name: string;
	issues: SkillDiagnosticIssue[];
	skills: SkillDiagnosticEntry[];
	duplicates: SkillDiagnosticDuplicate[];
	reason?: SkillSelectionReason;
	canAnalyze: boolean;
	unavailableReason?: string;
	analysis?: SkillDiagnosticAnalysisRecord;
	lastAnalysis?: SkillDiagnosticAnalysisRecord;
}
interface PreparedAnalysis {
	record: SkillDiagnosticAnalysisRecord;
	snapshots: ResourceSnapshot[];
	context: string;
	abort: AbortController;
	completion: PromiseWithResolvers<SkillDiagnosticAnalysisRecord>;
	applying?: Promise<SkillDiagnosticAnalysisRecord>;
}

/** Shared session-owned workflow; neither navigating a panel nor querying RPC starts a model call. */
export class SkillDiagnosticController {
	readonly #session: AgentSession;
	readonly #plans = new Map<string, PreparedAnalysis>();
	readonly #lastCompleted = new Map<string, SkillDiagnosticAnalysisRecord>();
	readonly #listeners = new Set<() => void>();
	#context: string;
	#disposed = false;
	constructor(session: AgentSession) {
		this.#session = session;
		this.#context = this.#currentContext();
		const unsubscribe = session.subscribeCommandMetadataChanged(() => {
			this.#syncContext();
			for (const plan of this.#plans.values()) this.#reconcileApplied(plan);
			this.#emit();
		});
		session.addDisposer(() => {
			unsubscribe();
			this.dispose();
		});
		session.addDisposer(session.registerSessionChangeCallback(() => this.#syncContext()));
	}

	items(): SkillDiagnosticItem[] {
		if (this.#disposed) return [];
		this.#syncContext();
		const items: SkillDiagnosticItem[] = [];
		const grouped = new Set<string>();
		for (const group of this.#session.skillDiagnostics) {
			const skills = group.skills.map(serializeSkillDiagnosticEntry);
			for (const skill of group.skills) grouped.add(skill.filePath);
			const duplicates = group.duplicates.map(copy => ({
				skill: serializeSkillDiagnosticEntry(copy.skill),
				retained: serializeSkillDiagnosticEntry(copy.retained),
				match: copy.match,
			}));
			const variants = [...skills, ...duplicates.map(copy => copy.skill)];
			const issues: SkillDiagnosticIssue[] = [];
			if (skills.length > 1) issues.push("conflict");
			if (duplicates.length > 0) issues.push("redundancy");
			if (variants.some(skill => !skill.repository)) issues.push("missing-provenance");
			const canAnalyze = new Set(variants.map(skill => skill.filePath)).size > 1;
			items.push({
				name: group.name,
				skills,
				duplicates,
				reason: group.reason,
				issues,
				canAnalyze,
				...(!canAnalyze && { unavailableReason: "No competing copies are available to compare." }),
			});
		}
		for (const skill of this.#session.skills) {
			if (grouped.has(skill.filePath)) continue;
			const entry = serializeSkillDiagnosticEntry(skill);
			items.push({
				name: skill.name,
				skills: [entry],
				duplicates: [],
				issues: entry.repository ? [] : ["missing-provenance"],
				canAnalyze: false,
				unavailableReason: "Only one loaded copy is available; relationship analysis needs comparable variants.",
			});
		}
		for (const item of items) {
			const plan = this.#plans.get(item.name);
			const current = plan?.record;
			if (plan) this.#reconcileApplied(plan);
			const previous = this.#lastCompleted.get(item.name);
			if (current) item.analysis = structuredClone(current);
			if (previous && previous.id !== current?.id) item.lastAnalysis = structuredClone(previous);
		}
		return items.sort((a, b) => a.name.localeCompare(b.name));
	}

	async prepare(name: string, modelSelector?: string): Promise<SkillDiagnosticAnalysisRecord> {
		this.#assertOpen();
		this.#syncContext();
		const context = this.#context;
		const previous = this.#plans.get(name);
		if (previous?.record.status === "running" || previous?.applying)
			throw new Error("This skill already has an active analysis or application; cancel or wait for it first.");
		const group = this.#session.skillDiagnostics.find(group => group.name === name);
		if (!group) throw new Error("No comparable diagnostic variants exist for the selected skill.");
		const candidates: ResourceCandidate[] = [];
		const seen = new Set<string>();
		for (const skill of [...group.skills, ...group.duplicates.map(copy => copy.skill)]) {
			const root = await fs.realpath(skill.baseDir);
			if (seen.has(root)) continue;
			seen.add(root);
			candidates.push({
				id: `skill-${candidates.length + 1}`,
				label: skill.name,
				kind: "skill",
				root,
				entrypoint: await fs.realpath(skill.filePath),
			});
		}
		if (candidates.length < 2) throw new Error("These entries refer to the same resource directory.");
		const snapshots = await Promise.all(candidates.map(candidate => snapshotResource(candidate)));
		const { bytes } = preflightResourceAnalysis(snapshots);
		const selected = resolveResourceAnalysisModel(this.#session.modelRegistry, this.#session.settings, modelSelector);
		this.#assertContext(context);
		const model = `${selected.model.provider}/${selected.model.id}${selected.thinkingLevel ? `:${selected.thinkingLevel}` : ""}`;
		const record: SkillDiagnosticAnalysisRecord = {
			id: crypto.randomUUID(),
			name,
			status: "prepared",
			model,
			bytes,
			disclosure: SEND_DISCLOSURE,
			createdAt: Date.now(),
			applied: false,
			candidates: snapshots.map(snapshot => ({
				id: snapshot.candidate.id,
				name: snapshot.candidate.label,
				filePath: snapshot.candidate.entrypoint!,
				root: snapshot.candidate.root,
				fingerprint: snapshot.fingerprint,
				complete: snapshot.complete,
				files: snapshot.files.length,
				omissions: [...snapshot.omissions],
			})),
		};
		// A different client may have prepared and started this name while the snapshots were read.
		const superseded = this.#plans.get(name);
		if (superseded?.record.status === "running" || superseded?.applying)
			throw new Error("This skill already has an active analysis or application; cancel or wait for it first.");
		superseded?.abort.abort();
		this.#plans.set(name, {
			record,
			snapshots,
			context,
			abort: new AbortController(),
			completion: Promise.withResolvers<SkillDiagnosticAnalysisRecord>(),
		});
		this.#emit();
		return structuredClone(record);
	}

	start(id: string, consent: boolean): SkillDiagnosticAnalysisRecord {
		if (consent !== true) throw new Error("Explicit analysis consent is required; no files were sent.");
		const plan = this.#get(id);
		if (plan.record.status === "running" || plan.record.status === "complete" || plan.record.status === "applied")
			return structuredClone(plan.record);
		if (plan.record.status !== "prepared")
			throw new Error("Prepare a new consent plan before starting this analysis.");
		plan.record.status = "running";
		this.#emit();
		void this.#run(plan);
		return structuredClone(plan.record);
	}

	wait(id: string): Promise<SkillDiagnosticAnalysisRecord> {
		const plan = this.#get(id);
		return plan.record.status === "running"
			? plan.completion.promise.then(record => structuredClone(record))
			: Promise.resolve(structuredClone(plan.record));
	}

	cancel(id: string): SkillDiagnosticAnalysisRecord {
		const plan = this.#get(id);
		if (plan.applying)
			throw new Error("An already confirmed application is being saved; it cannot be cancelled as an analysis.");
		if (plan.record.status === "prepared" || plan.record.status === "running") {
			plan.abort.abort();
			plan.record.status = "cancelled";
			plan.completion.resolve(structuredClone(plan.record));
			this.#emit();
		}
		return structuredClone(plan.record);
	}

	async apply(id: string, confirmed: boolean): Promise<SkillDiagnosticAnalysisRecord> {
		if (confirmed !== true) throw new Error("Applying a recommendation needs a separate explicit confirmation.");
		const plan = this.#get(id);
		if (plan.applying) return plan.applying;
		if (plan.record.status === "applied" && !plan.record.error) return structuredClone(plan.record);
		const result = plan.record.result;
		if (
			(plan.record.status !== "complete" && !(plan.record.status === "applied" && plan.record.error)) ||
			result?.recommendation.action !== "prefer" ||
			!result.recommendation.preferredId ||
			plan.snapshots.some(snapshot => !snapshot.complete)
		) {
			throw new Error("Only a complete, reviewed preference recommendation can be applied.");
		}
		plan.applying = this.#apply(plan, result.recommendation.preferredId).finally(() => {
			plan.applying = undefined;
		});
		return plan.applying;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#invalidate();
		this.#listeners.clear();
	}

	async #run(plan: PreparedAnalysis): Promise<void> {
		try {
			if (!(await this.#unchanged(plan))) {
				this.#finish(plan, "stale", "Resource contents changed after preparation; review a new consent plan.");
				return;
			}
			if (!this.#active(plan) || plan.abort.signal.aborted) return;
			const result = await analyzeResources(plan.snapshots, this.#session.modelRegistry, this.#session.settings, {
				modelSelector: plan.record.model,
				signal: plan.abort.signal,
			});
			if (!this.#active(plan) || plan.abort.signal.aborted) return;
			plan.record.result = result;
			this.#finish(plan, "complete");
		} catch (error) {
			if (this.#active(plan) && !plan.abort.signal.aborted)
				this.#finish(plan, "failed", sanitizeText(error instanceof Error ? error.message : String(error)));
		}
	}
	async #apply(plan: PreparedAnalysis, preferredId: string): Promise<SkillDiagnosticAnalysisRecord> {
		delete plan.record.error;
		try {
			this.#assertContext(plan.context);
			await excludeReviewedResources(plan.snapshots, preferredId, this.#session.settings, () =>
				this.#assertContext(plan.context),
			);
			// Saving and reloading are distinct: a reload failure must not imply the global choice was unsaved.
			plan.record.applied = true;
			plan.record.status = "applied";
			this.#assertContext(plan.context);
			await this.#session.refreshSkills();
			this.#assertContext(plan.context);
			this.#lastCompleted.set(plan.record.name, structuredClone(plan.record));
			this.#emit();
			return structuredClone(plan.record);
		} catch (error) {
			if (error instanceof StaleResourceReviewError) this.#finish(plan, "stale", sanitizeText(error.message));
			if (this.#active(plan)) {
				const message = sanitizeText(error instanceof Error ? error.message : String(error));
				plan.record.error = plan.record.applied ? `Choice saved, but session reload failed: ${message}` : message;
				if (plan.record.applied) this.#lastCompleted.set(plan.record.name, structuredClone(plan.record));
				this.#emit();
			}
			throw error;
		}
	}
	async #unchanged(plan: PreparedAnalysis): Promise<boolean> {
		this.#assertContext(plan.context);
		const current = await Promise.all(plan.snapshots.map(snapshot => snapshotResource(snapshot.candidate)));
		this.#assertContext(plan.context);
		return current.every(
			(snapshot, index) =>
				snapshot.complete === plan.snapshots[index].complete &&
				snapshot.fingerprint === plan.snapshots[index].fingerprint,
		);
	}
	#finish(plan: PreparedAnalysis, status: SkillAnalysisStatus, error?: string): void {
		if (!this.#active(plan)) return;
		plan.record.status = status;
		if (status === "stale") plan.record.applied = false;
		if (error) plan.record.error = error;
		if (status === "complete") this.#lastCompleted.set(plan.record.name, structuredClone(plan.record));
		plan.completion.resolve(structuredClone(plan.record));
		this.#emit();
	}
	#reconcileApplied(plan: PreparedAnalysis): void {
		if (plan.record.status !== "applied" || plan.applying || plan.record.error) return;
		const group = this.#session.skillDiagnostics.find(group => group.name === plan.record.name);
		if (!group || group.skills.length + group.duplicates.length < 2) return;
		plan.record.status = "stale";
		plan.record.applied = false;
		plan.record.error = "Skill copies changed or the preference was restored; review the current copies again.";
		this.#lastCompleted.set(plan.record.name, structuredClone(plan.record));
	}
	#get(id: string): PreparedAnalysis {
		this.#assertOpen();
		this.#syncContext();
		const plan = [...this.#plans.values()].find(plan => plan.record.id === id);
		if (!plan) throw new Error("Unknown or superseded analysis id; prepare a new consent plan in this session.");
		this.#reconcileApplied(plan);
		return plan;
	}
	#active(plan: PreparedAnalysis): boolean {
		this.#syncContext();
		return !this.#disposed && this.#plans.get(plan.record.name) === plan && plan.context === this.#context;
	}
	#currentContext(): string {
		return `${this.#session.sessionId}\0${this.#session.sessionManager.getCwd()}`;
	}
	#assertOpen(): void {
		if (this.#disposed) throw new Error("This diagnostics session has been disposed.");
	}
	#assertContext(context: string): void {
		this.#assertOpen();
		this.#syncContext();
		if (context !== this.#context) throw new Error("Session changed; the old analysis cannot be used here.");
	}
	#syncContext(): void {
		const current = this.#currentContext();
		if (current === this.#context) return;
		this.#context = current;
		this.#invalidate();
		this.#emit();
	}
	#invalidate(): void {
		for (const plan of this.#plans.values()) {
			plan.abort.abort();
			plan.record.status = "cancelled";
			delete plan.record.result;
			plan.completion.resolve(structuredClone(plan.record));
		}
		this.#plans.clear();
		this.#lastCompleted.clear();
	}
	#emit(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (error) {
				logger.warn("Skill diagnostics subscriber failed", { error: String(error) });
			}
		}
	}
}
