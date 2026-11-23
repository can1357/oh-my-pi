import type { ASIData, NumericMetricMap, ExperimentState } from "@oh-my-pi/pi-tui/tools/autoresearch";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../extensibility/extensions";
import type { SessionEntry } from "../session/session-entries";
import type { DashboardController } from "@oh-my-pi/pi-tui/apps/autoresearch-dashboard";

export interface PendingRunSummary {
	command: string;
	durationSeconds: number | null;
	parsedAsi: ASIData | null;
	parsedMetrics: NumericMetricMap | null;
	parsedPrimary: number | null;
	passed: boolean;
	preRunDirtyPaths: string[];
	runDirectory: string;
	runNumber: number;
	exitCode: number | null;
	timedOut: boolean;
}

export interface RunningExperiment {
	startedAt: number;
	command: string;
	runDirectory: string;
	runNumber: number;
}

export interface AutoresearchRuntime {
	autoresearchMode: boolean;
	autoResumeArmed: boolean;
	dashboardExpanded: boolean;
	lastAutoResumePendingRunNumber: number | null;
	lastRunDuration: number | null;
	lastRunAsi: ASIData | null;
	lastRunArtifactDir: string | null;
	lastRunNumber: number | null;
	lastRunSummary: PendingRunSummary | null;
	runningExperiment: RunningExperiment | null;
	state: ExperimentState;
	goal: string | null;
}

export interface AutoresearchControlEntryData {
	mode: "on" | "off" | "clear";
	goal?: string;
}

export interface ReconstructedControlState {
	autoresearchMode: boolean;
	goal: string | null;
	lastMode: AutoresearchControlEntryData["mode"] | null;
}

export interface RuntimeStore {
	clear(sessionKey: string): void;
	ensure(sessionKey: string): AutoresearchRuntime;
}

export interface AutoresearchToolFactoryOptions {
	dashboard: DashboardController;
	getRuntime(ctx: ExtensionContext): AutoresearchRuntime;
	pi: ExtensionAPI;
}

export type AutoresearchToolResult<TDetails> = AgentToolResult<TDetails>;
export type SessionEntries = SessionEntry[];
