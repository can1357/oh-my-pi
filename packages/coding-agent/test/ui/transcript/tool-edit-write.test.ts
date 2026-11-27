import { flowSuite } from "./tool-flows";

for (const id of [
	"edit",
	"edit-multi-file-preview",
	"edit_delete",
	"edit_move",
	"apply_patch",
	"write",
	"write_agent",
	"write_agent_broadcast",
	"write_agent_failed_receipt",
	"write_proc_cancel",
	"write_proc_mode",
	"write_proc_stdin",
	"write_proc_stop",
	"todo",
	"wait",
	"think",
	"resolve",
	"reject",
	"yield",
])
	flowSuite(id);
