use std::sync::Arc;

use omp_agent::{
	DirectorCx, DirectorStack, ForceUntil, LoopDecision, RouteFacts,
	directors::force_tool::ForceTool,
};
use omp_ai::{ChatRequest, NegotiationPolicy, Sampling, Setting, ToolChoice};
use omp_core::Str;

use crate::harness::{Call, Harness};

#[test]
fn test_two_rung_program_forces_write_then_none_and_completes() {
	let mut world = Harness::new();
	world.engage(ForceTool::new("write", ForceUntil::ToolCalled(Str::new_static("write")), None, 2));
	let mut req = request();
	let cx = DirectorCx::new(world.session.dom().body(), &world.route);
	DirectorStack::from_dom(world.session.dom(), &world.registry).prepare_inference(
		world.session.dom(),
		&cx,
		&mut req,
	);
	assert!(
		matches!(&req.tool_choice, Setting::Require(ToolChoice::Named(name)) if name == "write")
	);
	world.turn("", &[Call::new("write", serde_json::json!({}))], 0);
	assert!(!world.active().iter().any(|&id| id == "force_tool"));
	let req = request();
	assert!(matches!(req.tool_choice, Setting::Unset));
}

#[test]
fn test_run_scope_starts_after_prompt_and_expires_at_run_end() {
	let mut world = Harness::new();
	world.engage(ForceTool::new("write", ForceUntil::AnyToolCall, None, 2));
	world.turn("", &[Call::new("write", serde_json::json!({}))], 0);
	assert!(world.active().is_empty());
}

#[test]
fn test_forced_call_is_semantic_intent_for_inference_to_lower() {
	let mut world = Harness::new();
	world.route.forced_choice_free = false;
	world.engage(ForceTool::new("write", ForceUntil::AnyToolCall, None, 2));
	let mut req = request();
	let cx = DirectorCx::new(world.session.dom().body(), &world.route);
	DirectorStack::from_dom(world.session.dom(), &world.registry).prepare_inference(
		world.session.dom(),
		&cx,
		&mut req,
	);
	assert!(
		matches!(&req.tool_choice, Setting::Require(ToolChoice::Named(name)) if name == "write")
	);
	assert_eq!(req.messages.len(), 0, "Directors do not author provider-strategy prompts");
	assert_eq!(
		req.forced_call,
		Some(omp_ai::ForcedCall { non_compliant_turns: 0, escalations_left: 2 })
	);
	assert!(matches!(world.turn("provider response", &[], 0), LoopDecision::Continue { .. }));
	assert!(
		world
			.developer_texts()
			.iter()
			.any(|text| text.contains("write"))
	);
}

#[test]
fn test_claim_holder_outranks_queued_settle_force_and_ladder_pauses() {
	let mut world = Harness::new();
	world.engage(ForceTool::new("write", ForceUntil::AnyToolCall, None, 3));
	world.engage(ForceTool::new("ask", ForceUntil::AnyToolCall, None, 3));
	assert_eq!(world.queued(), vec!["force_tool"]);
	world.turn("first", &[], 0);
	assert_eq!(world.state_str("force_tool", "tool").as_deref(), Some("write"));
	world.turn("", &[Call::new("write", serde_json::json!({}))], 0);
	assert_eq!(world.state_str("force_tool", "tool").as_deref(), Some("ask"));
	assert_eq!(world.state_int("force_tool", "attempts"), Some(0));
}

#[test]
fn successful_any_call_stays_satisfied_until_the_next_candidate_yield() {
	let mut world = Harness::new();
	world.engage(ForceTool::new("grep", ForceUntil::AnyToolCall, None, 1));
	world.observe_only("", &[Call::new("read", serde_json::json!({}))], 0);
	assert_eq!(world.state_bool("force_tool", "satisfied"), Some(true));
	assert!(matches!(world.turn("now yielding", &[], 0), LoopDecision::Yield));
	assert!(world.active().is_empty());
}

#[test]
fn terminal_yield_force_survives_partial_items_and_closes_on_batch_completion() {
	let mut world = Harness::new();
	world.engage(
		ForceTool::new("yield", ForceUntil::TerminalYield, Some(Str::new_static("finish batch")), 3)
			.deferred(),
	);
	assert!(matches!(
		world.turn(
			"",
			&[Call::new("yield", serde_json::json!({"key": 1}))
				.with_outcome(serde_json::json!({"value":{"complete":false,"failed":false}}))],
			0,
		),
		LoopDecision::Continue { .. }
	));
	assert!(world.active().iter().any(|&id| id == "force_tool"));
	assert!(matches!(
		world.turn(
			"",
			&[Call::new("yield", serde_json::json!({"key": 2}))
				.with_outcome(serde_json::json!({"value":{"complete":true,"failed":false}}))],
			0,
		),
		LoopDecision::Yield
	));
	assert!(world.active().is_empty());
}

#[test]
fn test_force_tool_is_evaluated_from_engagement_state() {
	let mut world = Harness::new();
	world.engage(ForceTool::new("grep", ForceUntil::AnyToolCall, None, 1));
	let mut req = request();
	let facts = RouteFacts {
		forced_choice_free: true,
		context_window: 128_000,
		image_input: false,
		..RouteFacts::default()
	};
	let cx = DirectorCx::new(world.session.dom().body(), &facts);
	DirectorStack::from_dom(world.session.dom(), &world.registry).prepare_inference(
		world.session.dom(),
		&cx,
		&mut req,
	);
	assert!(matches!(&req.tool_choice, Setting::Require(ToolChoice::Named(name)) if name == "grep"));
}

fn request() -> ChatRequest {
	ChatRequest {
		messages:          Arc::from([]),
		tools:             Arc::from([]),
		hosted_tools:      Arc::from([]),
		tool_choice:       Setting::Unset,
		output:            Setting::Unset,
		reasoning:         Setting::Unset,
		verbosity:         Setting::Unset,
		cache_retention:   Setting::Unset,
		service_tier:      Setting::Unset,
		sampling:          Sampling::default(),
		max_output_tokens: None,
		top_logprobs:      None,
		safety:            Arc::from([]),
		negotiation:       NegotiationPolicy::default(),
		forced_call:       None,
	}
}
