use omp_rpc::*;
use serde_json::{Value, json};

fn notification(frame: Value) -> Result<RpcNotification, serde_json::Error> {
	serde_json::from_value(frame)
}

#[test]
fn unknown_notification_keeps_raw_json() {
	let raw = json!({"type": "from_the_future", "payload": {"x": [1, 2]}});
	let decoded = notification(raw.clone()).unwrap();
	assert_eq!(decoded, RpcNotification::Unknown(raw.clone()));
	assert_eq!(serde_json::to_value(&decoded).unwrap(), raw);
	let frame: RpcServerFrame = serde_json::from_value(raw.clone()).unwrap();
	assert_eq!(frame, RpcServerFrame::Unknown(raw));
}

#[test]
fn subagent_event_routes_nested_session_event() {
	let raw = json!({"type": "subagent_event", "payload": {"id": "sa_1", "event": {"type": "agent_start"}}});
	let RpcNotification::SubagentEvent(event) = notification(raw.clone()).unwrap() else {
		panic!("not a subagent_event")
	};
	assert_eq!(event.payload.id, "sa_1");
	assert!(matches!(event.payload.event, OrUnknown::Known(RpcAgentEvent::AgentStart(_))));
	// Encoding re-inserts both discriminators.
	assert_eq!(serde_json::to_value(RpcNotification::SubagentEvent(event)).unwrap(), raw);
}

#[test]
fn session_event_routes_through_notification() {
	let raw = json!({"type": "agent_start"});
	assert!(matches!(
		notification(raw).unwrap(),
		RpcNotification::RpcAgentEvent(RpcAgentEvent::AgentStart(_))
	));
}

#[test]
fn extension_ui_request_routes_by_method() {
	let raw = json!({
		 "type": "extension_ui_request", "id": "ui_1", "method": "select",
		 "title": "Pick", "options": ["a", "b"], "optionDetails": [{"description": "first", "badge": "new"}],
	});
	let RpcNotification::ExtensionUiRequest(ExtensionUiRequest::Select(request)) =
		notification(raw.clone()).unwrap()
	else {
		panic!("not routed to select")
	};
	assert_eq!(request.options, ["a", "b"]);
	let details = request.option_details.as_ref().unwrap();
	assert_eq!(details[0].description.as_deref(), Some("first"));
	assert_eq!(details[0].extra["badge"], "new");
	let encoded = serde_json::to_value(RpcNotification::ExtensionUiRequest(
		ExtensionUiRequest::Select(request),
	))
	.unwrap();
	assert_eq!(encoded, raw);
}

#[test]
fn open_record_keeps_unknown_keys_and_tolerates_missing_fields() {
	// `timestamp` (declared) is missing; `futureField` is unknown.
	let raw = json!({"role": "user", "content": "hi", "futureField": {"a": 1}});
	let AgentMessage::User(message) = serde_json::from_value::<AgentMessage>(raw.clone()).unwrap()
	else {
		panic!("not routed to user")
	};
	assert_eq!(message.content, Some(MessageContent::String("hi".into())));
	assert_eq!(message.timestamp, None);
	assert_eq!(message.extra["futureField"], json!({"a": 1}));
	assert_eq!(serde_json::to_value(AgentMessage::User(message)).unwrap(), raw);
	// Only the discriminator is validated.
	assert!(serde_json::from_value::<AgentMessage>(json!({"role": "alien"})).is_err());
}

#[test]
fn unknown_fallback_field_keeps_raw_event() {
	let raw = json!({"type": "subagent_event", "payload": {"id": "sa_1", "event": {"type": "from_the_future", "n": 1}}});
	let RpcNotification::SubagentEvent(event) = notification(raw.clone()).unwrap() else {
		panic!("frame failed")
	};
	let OrUnknown::Unknown { raw: inner, error } = &event.payload.event else {
		panic!("event decoded")
	};
	assert_eq!(inner, &raw["payload"]["event"]);
	assert!(error.contains("from_the_future"), "{error}");
	// A known type with a bad payload degrades the same way.
	let bad = json!({"type": "subagent_event", "payload": {"id": "sa_1", "event": {"type": "goal_updated"}}});
	let RpcNotification::SubagentEvent(event) = notification(bad).unwrap() else {
		panic!("frame failed")
	};
	assert!(matches!(event.payload.event, OrUnknown::Unknown { .. }));
	assert_eq!(
		serde_json::to_value(RpcNotification::SubagentEvent(event.clone())).unwrap()["payload"]
			["event"]["type"],
		"goal_updated"
	);
}

#[test]
fn scalar_or_array_field_accepts_bare_scalar() {
	let state: SessionState =
		serde_json::from_value(json!({"sessionId": "s", "systemPrompt": "one"})).unwrap();
	assert_eq!(state.system_prompt, ["one"]);
	let state: SessionState =
		serde_json::from_value(json!({"sessionId": "s", "systemPrompt": ["a", "b"]})).unwrap();
	assert_eq!(state.system_prompt, ["a", "b"]);
	let state: SessionState = serde_json::from_value(json!({"sessionId": "s"})).unwrap();
	assert!(state.system_prompt.is_empty());
	assert!(
		serde_json::from_value::<SessionState>(json!({"sessionId": "s", "systemPrompt": 3})).is_err()
	);
}

#[test]
fn message_content_alias_is_untagged() {
	let blocks: MessageContent =
		serde_json::from_value(json!([{"type": "text", "text": "hi"}])).unwrap();
	assert!(
		matches!(&blocks, MessageContent::UserContentList(list) if matches!(list[0], UserContent::Text(_)))
	);
}

#[test]
fn closed_record_missing_required_field_fails() {
	let error = serde_json::from_value::<RpcNotification>(
		json!({"type": "subagent_event", "payload": {"id": "x"}}),
	)
	.unwrap_err();
	assert!(error.to_string().contains("event"), "{error}");
	// A required nullable field must be present too.
	assert!(notification(json!({"type": "goal_updated"})).is_err());
	assert!(notification(json!({"type": "goal_updated", "goal": null})).is_ok());
}

#[test]
fn defaulted_field_takes_default_when_absent() {
	let usage: TokenUsage = serde_json::from_value(
		json!({"input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 0, "total": 3}),
	)
	.unwrap();
	assert_eq!(usage.reasoning, 0);
	let state: SessionState =
		serde_json::from_value(json!({"sessionId": "s"})).unwrap_or_else(|error| panic!("{error}"));
	assert_eq!(state.steering_mode, QueueMode::OneAtATime);
	assert!(!state.is_streaming);
	assert_eq!(state.goal, None);
}

#[test]
fn unknown_enum_value_fails() {
	assert!(serde_json::from_value::<QueueMode>(json!("sometimes")).is_err());
	assert_eq!(
		serde_json::from_value::<QueueMode>(json!("one-at-a-time")).unwrap(),
		QueueMode::OneAtATime
	);
	let item = json!({"content": "x", "status": "exploded"});
	assert!(serde_json::from_value::<TodoItem>(item).is_err());
}

#[test]
fn command_encoding() {
	let frame = encode_command("req_1", &GetEntriesCommand::default()).unwrap();
	assert_eq!(frame, json!({"id": "req_1", "type": "get_entries"}));
	let frame = encode_command("req_2", &SetEventFilterCommand { events: None }).unwrap();
	assert_eq!(frame, json!({"id": "req_2", "type": "set_event_filter", "events": null}));
	let frame = encode_command("req_3", &GetStateCommand {}).unwrap();
	assert_eq!(frame, json!({"id": "req_3", "type": "get_state"}));
	let goal = GoalCommand {
		op:           GoalOp::Create,
		objective:    Some("ship".into()),
		token_budget: None,
	};
	assert_eq!(
		encode_command("req_4", &goal).unwrap(),
		json!({"id": "req_4", "type": "goal", "op": "create", "objective": "ship"})
	);
}

#[test]
fn inbound_frames_carry_constants() {
	let cancel =
		RpcInbound::ExtensionUiResponse(ExtensionUiResponse::CancelUiResponse(CancelUiResponse {
			id:        "ui_1".into(),
			cancelled: LitTrue,
			timed_out: None,
		}));
	let encoded = serde_json::to_value(&cancel).unwrap();
	assert_eq!(encoded, json!({"type": "extension_ui_response", "id": "ui_1", "cancelled": true}));
	assert_eq!(serde_json::from_value::<RpcInbound>(encoded).unwrap(), cancel);
}

#[test]
fn result_unwrap_and_nullable() {
	assert!(!CancelSubagentCommand::decode(Some(json!({"cancelled": false}))).unwrap());
	assert_eq!(SetEventFilterCommand::decode(Some(json!({"events": null}))).unwrap(), None);
	assert_eq!(CycleModelCommand::decode(None).unwrap(), None);
	assert_eq!(CycleModelCommand::decode(Some(Value::Null)).unwrap(), None);
	assert!(CancelSubagentCommand::decode(None).is_err());
	assert!(<SteerCommand as Command>::decode(None).is_ok());
}

fn skill_analysis_record() -> Value {
	json!({
		"id": "analysis-1", "name": "review", "status": "complete", "model": "fake/fake-model", "bytes": 120,
		"candidates": [{
			"id": "skill-1", "name": "review", "filePath": "/a/review/SKILL.md", "root": "/a/review",
			"fingerprint": "ff", "complete": true, "files": 1, "omissions": [],
		}],
		"disclosure": "d", "createdAt": 1_700_000_000_000_i64, "applied": false,
		"result": {
			"relationship": "adaptation",
			"evidence": [{"candidateId": "skill-1", "file": "SKILL.md", "quote": "Review changes carefully.", "explanation": "same"}],
			"differences": ["x"],
			"recommendation": {"action": "prefer", "preferredId": "skill-1", "reason": "r"},
			"limitations": [],
		},
	})
}

#[test]
fn skill_analysis_commands_encode_and_decode_records() {
	let prepare = PrepareSkillDiagnosticAnalysisCommand {
		name:  "review".into(),
		model: Some("fake/fake-model".into()),
	};
	assert_eq!(
		encode_command("req_1", &prepare).unwrap(),
		json!({"id": "req_1", "type": "prepare_skill_diagnostic_analysis", "name": "review", "model": "fake/fake-model"})
	);
	let analyze =
		AnalyzeSkillDiagnosticsCommand { analysis_id: "analysis-1".into(), consent: true };
	assert_eq!(
		encode_command("req_2", &analyze).unwrap(),
		json!({"id": "req_2", "type": "analyze_skill_diagnostics", "analysisId": "analysis-1", "consent": true})
	);
	let cancel = CancelSkillDiagnosticAnalysisCommand { analysis_id: "analysis-1".into() };
	assert_eq!(
		encode_command("req_3", &cancel).unwrap(),
		json!({"id": "req_3", "type": "cancel_skill_diagnostic_analysis", "analysisId": "analysis-1"})
	);
	let apply =
		ApplySkillDiagnosticAnalysisCommand { analysis_id: "analysis-1".into(), confirmed: true };
	assert_eq!(
		encode_command("req_4", &apply).unwrap(),
		json!({"id": "req_4", "type": "apply_skill_diagnostic_analysis", "analysisId": "analysis-1", "confirmed": true})
	);

	let record =
		PrepareSkillDiagnosticAnalysisCommand::decode(Some(skill_analysis_record())).unwrap();
	assert_eq!(record.status, SkillAnalysisStatus::Complete);
	assert!(!record.applied);
	let mut paused = skill_analysis_record();
	paused["status"] = json!("paused");
	assert!(PrepareSkillDiagnosticAnalysisCommand::decode(Some(paused)).is_err());
	let mut without_applied = skill_analysis_record();
	without_applied.as_object_mut().unwrap().remove("applied");
	assert!(ApplySkillDiagnosticAnalysisCommand::decode(Some(without_applied)).is_err());
}

#[test]
fn skill_snapshot_items_are_optional_and_strict() {
	let legacy: SkillDiagnosticsSnapshot = serde_json::from_value(
		json!({"cwd": "/w", "showStartupDiagnostics": true, "diagnostics": []}),
	)
	.unwrap();
	assert_eq!(legacy.items, None);

	let entry = json!({"name": "review", "filePath": "/a/SKILL.md", "source": "custom:user"});
	let item = json!({
		"name": "review", "issues": ["conflict"], "skills": [entry], "duplicates": [],
		"canAnalyze": true, "analysis": skill_analysis_record(),
	});
	let snapshot = json!({"cwd": "/w", "showStartupDiagnostics": true, "diagnostics": [], "items": [item.clone()]});
	let decoded: SkillDiagnosticsSnapshot = serde_json::from_value(snapshot).unwrap();
	let items = decoded.items.unwrap();
	assert!(items[0].can_analyze);
	assert_eq!(items[0].analysis.as_ref().unwrap().id, "analysis-1");
	assert_eq!(items[0].last_analysis, None);

	let mut bad = item;
	bad["issues"] = json!(["bogus"]);
	let snapshot =
		json!({"cwd": "/w", "showStartupDiagnostics": true, "diagnostics": [], "items": [bad]});
	assert!(serde_json::from_value::<SkillDiagnosticsSnapshot>(snapshot).is_err());
}
