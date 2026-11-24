import { flowSuite } from "./tool-flows";

for (const id of [
	"ask",
	"ast_edit",
	"ast_grep",
	"bash",
	"bash_service",
	"eval",
	"read",
	"read_proc_job",
	"read_proc_list",
	"read_proc_service",
])
	flowSuite(id);
