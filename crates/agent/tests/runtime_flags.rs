//! Cross-crate runtime flags gate Director behavior at the kernel boundary.

use omp_agent::{
	DirectorRegistry, DirectorStack, DispatchPolicy, Kernel, RunControl, RuntimeFlags, StaticPrompt,
	TurnInput, directors::goal::Goal,
};
use omp_core::{Str, sf};
use omp_journal::blob::BlobStore;

mod support;

use support::{
	ScriptedInference, fresh_session, registry, spec, spec_family, text_script, tool_script,
};

const INLINE_EDIT: &str = "<SM:EDIT path=\"src/a.rs\">\n<SM:FIND>\nlet x = \
                           1;\n</SM:FIND>\n<SM:PUT>\nlet x = 2;\n</SM:PUT>\n</SM:EDIT>";

fn flags(compaction: bool, goal: bool) -> RuntimeFlags {
	RuntimeFlags {
		automatic_compaction:     compaction,
		goal_enabled:             goal,
		autolearn_enabled:        false,
		autolearn_min_tool_calls: 5,
		recover_inline_edits:     true,
	}
}

#[tokio::test]
async fn automatic_compaction_flag_controls_director_engagement() {
	for (enabled, expected) in [(false, 0), (true, 1)] {
		let temp = tempfile::tempdir().expect("tempdir");
		let (inference, _) = ScriptedInference::new([text_script("done")]);
		let mut kernel = Kernel::new(
			inference,
			registry(std::iter::empty()),
			DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blobs")),
			StaticPrompt(sf!("system")),
		)
		.with_runtime_flags(flags(enabled, true));
		let mut session = fresh_session(&temp.path().join("compaction.oms"));
		kernel
			.run_turn(
				&mut session,
				TurnInput { text: sf!("run"), attachments: Vec::new() },
				RunControl::default(),
			)
			.await
			.expect("turn");
		assert_eq!(
			session
				.dom()
				.count("directors director[family=compaction]")
				.expect("selector"),
			expected
		);
	}
}

#[tokio::test]
async fn autolearn_flag_and_minimum_schedule_exactly_one_learn_call() {
	let temp = tempfile::tempdir().expect("tempdir");
	let (inference, requests) = ScriptedInference::new([
		tool_script("read-1", "read", serde_json::json!({})),
		text_script("candidate"),
		tool_script("learn-1", "learn", serde_json::json!({})),
		text_script("final"),
	]);
	let mut kernel = Kernel::new(
		inference,
		registry([spec("read", 1, "read"), spec("learn", 1, "learned")]),
		DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blobs")),
		StaticPrompt(sf!("system")),
	)
	.with_runtime_flags(RuntimeFlags {
		automatic_compaction:     false,
		goal_enabled:             true,
		autolearn_enabled:        true,
		autolearn_min_tool_calls: 1,
		recover_inline_edits:     true,
	});
	let mut session = fresh_session(&temp.path().join("autolearn.oms"));
	kernel
		.run_turn(
			&mut session,
			TurnInput { text: sf!("run"), attachments: Vec::new() },
			RunControl::default(),
		)
		.await
		.expect("turn");
	assert_eq!(requests.lock().len(), 4);
	assert_eq!(session.dom().count("body turn learn").expect("selector"), 1);
}

#[tokio::test]
async fn disabled_autolearn_never_schedules_learn_after_the_same_tool_count() {
	let temp = tempfile::tempdir().expect("tempdir");
	let (inference, requests) = ScriptedInference::new([
		tool_script("read-1", "read", serde_json::json!({})),
		text_script("candidate"),
	]);
	let mut kernel = Kernel::new(
		inference,
		registry([spec("read", 1, "read"), spec("learn", 1, "learned")]),
		DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blobs")),
		StaticPrompt(sf!("system")),
	)
	.with_runtime_flags(RuntimeFlags {
		automatic_compaction:     false,
		goal_enabled:             true,
		autolearn_enabled:        false,
		autolearn_min_tool_calls: 1,
		recover_inline_edits:     true,
	});
	let mut session = fresh_session(&temp.path().join("no-autolearn.oms"));
	kernel
		.run_turn(
			&mut session,
			TurnInput { text: sf!("run"), attachments: Vec::new() },
			RunControl::default(),
		)
		.await
		.expect("turn");
	assert_eq!(requests.lock().len(), 2);
	assert_eq!(session.dom().count("body turn learn").expect("selector"), 0);
}

async fn inline_recovery(flags_enabled: bool, family: &str, text: &str) -> (usize, usize, String) {
	let temp = tempfile::tempdir().expect("tempdir");
	let scripts = if flags_enabled && family == "sloppy" && text.contains("</SM:EDIT>") {
		vec![text_script(text), text_script("done")]
	} else {
		vec![text_script(text)]
	};
	let (inference, requests) = ScriptedInference::new(scripts);
	let mut kernel = Kernel::new(
		inference,
		registry([spec_family("edit", family, 1, "edited")]),
		DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blobs")),
		StaticPrompt(sf!("system")),
	)
	.with_runtime_flags(RuntimeFlags {
		automatic_compaction:     false,
		goal_enabled:             true,
		autolearn_enabled:        false,
		autolearn_min_tool_calls: 5,
		recover_inline_edits:     flags_enabled,
	});
	let mut session = fresh_session(&temp.path().join("inline.oms"));
	kernel
		.run_turn(
			&mut session,
			TurnInput { text: sf!("run"), attachments: Vec::new() },
			RunControl::default(),
		)
		.await
		.expect("turn");
	let assistant = session
		.dom()
		.select("body turn assistant")
		.expect("selector")
		.next()
		.and_then(|handle| session.dom().get(handle))
		.and_then(|node| node.prop(&omp_dom::PropKey::from(omp_dom::PropId::Text)))
		.and_then(omp_dom::Value::as_str)
		.unwrap_or("")
		.to_owned();
	let request_count = requests.lock().len();
	(request_count, session.dom().count("body turn edit").expect("selector"), assistant)
}

#[tokio::test]
async fn inline_sloppy_edit_recovery_is_gated_and_rejects_malformed_or_non_sloppy_text() {
	let prose = format!("Fixing now.\n\n{INLINE_EDIT}\n\nDone.");
	let (requests, calls, assistant) = inline_recovery(true, "sloppy", &prose).await;
	assert_eq!((requests, calls), (2, 1));
	assert_eq!(assistant, "Fixing now.\n\n\n\nDone.");

	let (requests, calls, assistant) = inline_recovery(false, "sloppy", &prose).await;
	assert_eq!((requests, calls), (1, 0));
	assert!(assistant.contains("<SM:EDIT"));

	let (requests, calls, _) = inline_recovery(true, "test", &prose).await;
	assert_eq!((requests, calls), (1, 0));

	let malformed = "<SM:EDIT path=\"src/a.rs\">\n<SM:FIND>\nmissing close";
	let (requests, calls, assistant) = inline_recovery(true, "sloppy", malformed).await;
	assert_eq!((requests, calls), (1, 0));
	assert_eq!(assistant, malformed);
}

#[tokio::test]
async fn goal_tool_roster_follows_the_durable_engagement_state() {
	for (paused, expected) in [(false, true), (true, false)] {
		let temp = tempfile::tempdir().expect("tempdir");
		let directors = DirectorRegistry::standard();
		let mut session = fresh_session(&temp.path().join("goal-roster.oms"));
		let mut stack = DirectorStack::from_dom(session.dom(), &directors);
		stack
			.engage(&mut session, Box::new(Goal::new("finish", None)))
			.expect("goal engages");
		if paused {
			stack.pause(&mut session, "goal").expect("goal pauses");
		}
		let (inference, requests) = ScriptedInference::new([text_script("candidate")]);
		let mut kernel = Kernel::new(
			inference,
			registry([spec("goal", 1, "goal")]),
			DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blobs")),
			StaticPrompt(Str::new_static("system")),
		)
		.with_director_registry(directors)
		.with_runtime_flags(flags(false, true));
		kernel
			.run_turn(
				&mut session,
				TurnInput { text: sf!("run"), attachments: Vec::new() },
				RunControl::default(),
			)
			.await
			.expect("turn");
		let requests = requests.lock();
		assert_eq!(
			requests[0].tools.iter().any(|tool| tool.name == "goal"),
			expected,
			"pause and replay must re-derive hidden Goal tool visibility"
		);
	}
}

#[tokio::test]
async fn disabled_goal_is_removed_before_inference_while_enabled_goal_remains() {
	for (enabled, expected) in [(false, 0), (true, 1)] {
		let temp = tempfile::tempdir().expect("tempdir");
		let directors = DirectorRegistry::standard();
		let mut session = fresh_session(&temp.path().join("goal.oms"));
		DirectorStack::from_dom(session.dom(), &directors)
			.engage(&mut session, Box::new(Goal::new("finish", None)))
			.expect("goal engages");
		let (inference, requests) = ScriptedInference::new([text_script("candidate")]);
		let mut kernel = Kernel::new(
			inference,
			registry(std::iter::empty()),
			DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blobs")),
			StaticPrompt(Str::new_static("system")),
		)
		.with_director_registry(directors)
		.with_runtime_flags(flags(false, enabled));
		kernel
			.run_turn(
				&mut session,
				TurnInput { text: sf!("run"), attachments: Vec::new() },
				RunControl::default(),
			)
			.await
			.expect("turn");
		assert_eq!(
			session
				.dom()
				.count("directors director[family=goal]")
				.expect("selector"),
			expected
		);
		assert_eq!(requests.lock().len(), 1, "one provider request per prose-only turn");
	}
}
