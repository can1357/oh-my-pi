import { test } from "bun:test";
import { create } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { AgentServerMessageSchema, ConversationStateStructureSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
test("dbg", () => {
	const m = create(AgentServerMessageSchema, {
		message: { case: "conversationCheckpointUpdate", value: create(ConversationStateStructureSchema, { pendingToolCalls: ["x"] }) },
	});
	console.log("case:", m.message.case, "pending:", m.message.case === "conversationCheckpointUpdate" ? m.message.value.pendingToolCalls : "?");
});
