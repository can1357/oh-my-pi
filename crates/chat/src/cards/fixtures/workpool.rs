//! Eval workpool status/result gallery fixture.

use super::{CardFixture, FixtureState};

const ARGS: &str = r#"{"language":"py","title":"parallel audit","code":"pool = workpool(\"scout\", name=\"audit\")\npool.push(\"Inspect parser\", \"Inspect lexer\", \"Inspect recovery\")\ndisplay(pool.status())\ndisplay(pool.peek())\npool.close()"}"#;

const RESULT: &str = r#"{"frames":[],"display_outputs":[{"type":"status","event":{"op":"workpool","action":"create","pool":"audit"}},{"type":"status","event":{"op":"workpool","action":"push","pool":"audit"}},{"type":"status","event":{"op":"workpool","action":"status","pool":"audit"}},{"type":"status","event":{"op":"workpool","action":"peek","pool":"audit"}},{"type":"status","event":{"op":"workpool","action":"close","pool":"audit"}},{"type":"json","data":{"name":"audit","agent":"scout","model":"anthropic/claude-sonnet-4-5","limit":3,"closed":false,"freshAgents":false,"agents":[{"id":"audit-1","state":"running","queued":1,"turns":1,"contextTokens":18200,"contextWindow":200000,"current":"audit-1-b2"},{"id":"audit-2","state":"idle","queued":0,"turns":1,"contextTokens":12100,"contextWindow":200000}],"items":{"queued":1,"running":1,"completed":1,"failed":1,"cancelled":0},"batches":3}},{"type":"json","data":{"batches":[{"id":"audit-1-b1","agent":"audit-1","items":["audit#1"],"status":"completed","output":"Parser uses a Pratt loop with binding powers."},{"id":"audit-2-b1","agent":"audit-2","items":["audit#2"],"status":"failed","output":"Lexer fixture is missing."},{"id":"audit-1-b2","agent":"audit-1","items":["audit#3"],"status":"running"}],"pending":1}}],"status":{"outcome":"complete","exit_code":0,"duration_ms":842,"exception":null}}"#;

const FAILED_RESULT: &str = r#"{"frames":[],"display_outputs":[{"type":"status","event":{"op":"workpool","action":"create","pool":"audit"}},{"type":"status","event":{"op":"workpool","action":"push","pool":"audit"}},{"type":"status","event":{"op":"workpool","action":"close","pool":"audit","error":"worker audit-1 exited before yielding"}},{"type":"json","data":{"batches":[{"id":"audit-1-b1","agent":"audit-1","items":["audit#1"],"status":"failed","output":"worker audit-1 exited before yielding"},{"id":"audit-2-b1","agent":"audit-2","items":["audit#2"],"status":"cancelled","output":"cancelled before dispatch"}],"pending":0}}],"status":{"outcome":"error","exit_code":1,"duration_ms":391,"exception":{"name":"RuntimeError","message":"workpool audit failed","traceback":["RuntimeError: workpool audit failed"]}}}"#;

pub(super) const FIXTURES: &[CardFixture] = &[CardFixture {
	tool:   "eval_workpool",
	title:  "Eval workpool",
	states: [
		FixtureState {
			args:   r#"{"language":"py","title":"parallel audit","code":"pool = workpool(\"scout\", name=\"audit\")\npool.push("#,
			update: None,
			result: None,
			fault:  None,
		},
		FixtureState { args: ARGS, update: None, result: None, fault: None },
		FixtureState { args: ARGS, update: None, result: Some(RESULT), fault: None },
		FixtureState { args: ARGS, update: None, result: Some(FAILED_RESULT), fault: None },
	],
}];

#[cfg(test)]
mod tests {
	use omp_tui::frame_text;

	use crate::gallery::{GalleryState, render_sections};

	#[test]
	fn workpool_gallery_covers_aggregate_workers_items_results_errors_and_fold() {
		let collapsed = render_sections(Some("eval_workpool"), &[GalleryState::Done], 120, false)
			.expect("workpool fixture renders");
		let collapsed = frame_text(&collapsed[0].frame);
		assert!(collapsed.contains("Workpool updates"), "{collapsed}");
		assert!(collapsed.contains("… 2 earlier updates"), "{collapsed}");
		assert!(collapsed.contains("status audit"), "{collapsed}");
		assert!(collapsed.contains("peek audit"), "{collapsed}");
		assert!(collapsed.contains("close audit"), "{collapsed}");
		assert!(
			collapsed.contains("Pool audit ⟨anthropic/claude-sonnet-4-5⟩ 3 batches"),
			"{collapsed}"
		);
		assert!(collapsed.contains("1 queued"), "{collapsed}");
		assert!(collapsed.contains("1 running"), "{collapsed}");
		assert!(collapsed.contains("1 completed"), "{collapsed}");
		assert!(collapsed.contains("1 failed"), "{collapsed}");
		assert!(collapsed.contains("audit-1 ⟨running⟩"), "{collapsed}");
		assert!(collapsed.contains("audit-2 ⟨idle⟩"), "{collapsed}");
		assert!(collapsed.contains("Workpool results 1 pending"), "{collapsed}");
		assert!(collapsed.contains("audit-1-b1 ⟨completed⟩ ⟨audit-1⟩"), "{collapsed}");
		assert!(collapsed.contains("audit-2-b1 ⟨failed⟩ ⟨audit-2⟩"), "{collapsed}");

		let expanded = render_sections(Some("eval_workpool"), &[GalleryState::Done], 120, true)
			.expect("expanded workpool fixture renders");
		let expanded = frame_text(&expanded[0].frame);
		let create = expanded.find("create audit").expect("create update");
		let push = expanded.find("push audit").expect("push update");
		let status = expanded.find("status audit").expect("status update");
		let peek = expanded.find("peek audit").expect("peek update");
		let close = expanded.find("close audit").expect("close update");
		assert!(create < push && push < status && status < peek && peek < close, "{expanded}");
		assert!(expanded.contains("Parser uses a Pratt loop"), "{expanded}");
		assert!(expanded.contains("Lexer fixture is missing"), "{expanded}");
	}

	#[test]
	fn workpool_gallery_keeps_cancel_and_error_evidence_on_failed_eval() {
		let sections = render_sections(Some("eval_workpool"), &[GalleryState::Failed], 120, true)
			.expect("failed workpool fixture renders");
		let text = frame_text(&sections[0].frame);
		assert!(text.contains("close audit"), "{text}");
		assert!(text.contains("worker audit-1 exited before yielding"), "{text}");
		assert!(text.contains("audit-2-b1 ⟨cancelled⟩"), "{text}");
		assert!(text.contains("RuntimeError: workpool audit failed"), "{text}");
	}
}
