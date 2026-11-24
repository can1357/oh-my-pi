import type { AgentActivitySnapshot, CoordinationDetails, JobSnapshot } from "./wait";
import { type PersistedSnapshot } from "../../daemon/daemon-types";

export interface ProcReadDetails {
	jobs?: JobSnapshot[];
	agents?: AgentActivitySnapshot[];
	daemons?: PersistedSnapshot[];
	job?: JobSnapshot;
	daemon?: PersistedSnapshot;
	log?: string;
	terminalRows?: string[];
}

export type ProcWriteDetails =
	| CoordinationDetails
	| { action: "stop" | "stdin" | "mode"; daemon: PersistedSnapshot; input?: string; mode?: string };
