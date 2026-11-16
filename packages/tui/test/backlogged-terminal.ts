import { VirtualTerminal } from "./virtual-terminal";

/** A virtual terminal whose output backlog the test controls; lowering it reports a drain so the engine can resume. */
export class BackloggedTerminal extends VirtualTerminal {
	get pendingBytes(): number {
		return this.outputBacklog;
	}

	set pendingBytes(value: number) {
		this.setOutputBacklog(value);
	}
}
