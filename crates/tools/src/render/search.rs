//! Native grep and glob renderers.

use std::collections::HashMap;

use omp_core::{Str, sf};
use omp_tool::{CallOutcome, ToolIdentity, render::RenderFold};

use super::{
	fault_view, live_view,
	paths::{GroupedTreeEventKind, PathTreeInput, build_path_tree, walk_path_tree},
	view::El,
};
use crate::{
	gallery::RendererGalleryFixture,
	glob::{
		DEFAULT_LIMIT as GLOB_DEFAULT_LIMIT, Fault as GlobFault, Payload as GlobPayload,
		Update as GlobUpdate, display_scope,
	},
	grep::{Fault as GrepFault, Payload as GrepPayload, Update as GrepUpdate},
	view,
};

const SEARCH_PREVIEW_ROWS: usize = 40;

#[derive(Default)]
pub(super) struct GrepState {
	pattern: Option<Str>,
	scope:   Option<Str>,
}

pub(super) struct GrepRenderer;

impl RenderFold for GrepRenderer {
	type Outcome = CallOutcome<GrepPayload, GrepFault>;
	type State = GrepState;
	type Update = GrepUpdate;

	fn fold(&self, _state: &mut Self::State, update: Self::Update) {
		match update {}
	}

	fn fold_args(&self, state: &mut Self::State, args: &omp_core::slopjson::Value, complete: bool) {
		state.pattern = args
			.get("pattern")
			.and_then(omp_core::slopjson::Value::as_str)
			.map(Str::new);
		state.scope = args
			.get("path")
			.and_then(omp_core::slopjson::Value::as_str)
			.map(Str::new)
			.or_else(|| complete.then(|| Str::new(".")));
	}

	fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str> {
		match outcome {
			None => Some(render_grep_live(state).into()),
			Some(CallOutcome::Ok(payload)) => Some(render_grep_payload(payload).into()),
			Some(CallOutcome::Faulted(fault)) => Some(fault_view("grep", &fault.to_string()).into()),
			Some(CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. }) => None,
		}
	}
}

#[derive(Default)]
pub(super) struct GlobState {
	pattern: Option<Str>,
	scope:   Option<Str>,
	limit:   Option<u64>,
}

pub(super) struct GlobRenderer;

impl RenderFold for GlobRenderer {
	type Outcome = CallOutcome<GlobPayload, GlobFault>;
	type State = GlobState;
	type Update = GlobUpdate;

	fn fold(&self, _state: &mut Self::State, update: Self::Update) {
		match update {}
	}

	fn fold_args(&self, state: &mut Self::State, args: &omp_core::slopjson::Value, complete: bool) {
		state.pattern = args
			.get("path")
			.and_then(omp_core::slopjson::Value::as_str)
			.map(Str::new)
			.or_else(|| complete.then(|| Str::new(".")));
		state.scope = state.pattern.as_deref().map(display_scope);
		state.limit = args
			.get("limit")
			.and_then(omp_core::slopjson::Value::as_u64)
			.or_else(|| complete.then_some(GLOB_DEFAULT_LIMIT));
	}

	fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str> {
		match outcome {
			None => Some(render_glob_live(state).into()),
			Some(CallOutcome::Ok(payload)) => Some(render_glob_payload(state, payload).into()),
			Some(CallOutcome::Faulted(fault)) => Some(fault_view("glob", &fault.to_string()).into()),
			Some(CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. }) => None,
		}
	}
}

fn render_grep_live(state: &GrepState) -> El {
	let Some(pattern) = state.pattern.as_deref() else {
		return live_view("grep", "searching");
	};
	view! {
		<row gap=1>
			<spinner color=accent/>
			<text bold>{pattern}</text>
			if let Some(scope) = &state.scope {
				<text fg=muted>{"in "}{scope}</text>
			}
		</row>
	}
}

fn render_glob_live(state: &GlobState) -> El {
	let Some(pattern) = state.pattern.as_deref() else {
		return live_view("glob", "matching paths");
	};
	view! {
		<row gap=1>
			<spinner color=accent/>
			<text bold>{pattern}</text>
			if let Some(limit) = state.limit {
				<text fg=muted>{sf!("limit:{limit}")}</text>
			}
		</row>
	}
}

fn render_grep_payload(payload: &GrepPayload) -> El {
	let match_count = payload
		.files
		.iter()
		.map(|file| file.matches.len())
		.sum::<usize>();
	let files = payload
		.files
		.iter()
		.map(|file| (file.path.as_str(), file))
		.collect::<HashMap<_, _>>();
	let tree = build_path_tree(
		payload
			.files
			.iter()
			.map(|file| PathTreeInput::with_key(&file.path, false, &file.path)),
	);
	view! {
		<col gap=0>
			<row sep=" · ">
				<fact label="matches"><num value={match_count}/></fact>
				<fact label="files">
					<num value={payload.total_files}/>
					if payload.total_files_lower_bound { {"+"} }
				</fact>
			</row>
			<col gap=0 max-rows={SEARCH_PREVIEW_ROWS} overflow="results">
				for event in walk_path_tree(&tree) {
					match event.kind {
						GroupedTreeEventKind::Directory => {
							<row pad-x={event.depth.saturating_mul(2)}>
								<text bold fg=accent>{event.name}{"/"}</text>
							</row>
						},
						GroupedTreeEventKind::File => {
							<col gap=0 pad-x={event.depth.saturating_mul(2)}>
								<row><text bold>{event.name}</text></row>
								if let Some(file) = files.get(event.key) {
									for matched in &file.matches {
										<row gap=0>
											<text fg=accent>{"*"}</text>
											<pre numbers start={matched.line_number}>
												{&matched.line}
												if matched.truncated { {"…"} }
											</pre>
										</row>
									}
								}
							</col>
						},
					}
				}
			</col>
		</col>
	}
}

fn render_glob_payload(state: &GlobState, payload: &GlobPayload) -> El {
	let remaining = payload
		.partial_match_count
		.saturating_sub(payload.matches.len() as u64);
	view! {
		<col gap=0>
			<row sep=" · ">
				<fact label="files"><num value={payload.matches.len()}/></fact>
				<fact label="in">{state.scope.as_deref().unwrap_or(".")}</fact>
			</row>
			<files max-rows={SEARCH_PREVIEW_ROWS} overflow="files">
				for entry in &payload.matches {
					{&entry.path}
					if entry.is_dir && !entry.path.ends_with('/') { {"/"} }
					{"\n"}
				}
			</files>
			if payload.truncated {
				<fact label="truncated">
					<text fg=muted>
						if remaining > 0 { {sf!("{remaining} more files")} } else { {"more files"} }
					</text>
				</fact>
			}
			if payload.timed_out {
				<fact label="timed out"><time ms={payload.timeout_ms} kind="duration"/></fact>
			}
		</col>
	}
}

/// Native grep and glob renderer lifecycle fixtures for the visual QA gallery.
pub fn gallery_fixtures(grep: ToolIdentity, glob: ToolIdentity) -> Vec<RendererGalleryFixture> {
	vec![
		RendererGalleryFixture {
			identity:       grep,
			streaming_args: r#"{"pattern":"useSta"#,
			args:           r#"{"pattern":"useState","path":"packages/tui/src","case":true}"#,
			progress_update: None,
			success_outcome: br#"{"kind":"ok","value":{"files":[{"path":"packages/tui/src/components/Chat.tsx","source_key":"packages/tui/src/components/Chat.tsx","snapshot_tag":null,"matches":[{"line_number":18,"line":"  const [query, setQuery] = useState(\"\");","truncated":false,"context_before":[],"context_after":[]},{"line_number":42,"line":"  const [isStreaming, setIsStreaming] = useState(false);","truncated":false,"context_before":[],"context_after":[]}]},{"path":"packages/tui/src/components/SearchPanel.tsx","source_key":"packages/tui/src/components/SearchPanel.tsx","snapshot_tag":null,"matches":[{"line_number":27,"line":"  const [results, setResults] = useState<SearchResult[]>([]);","truncated":false,"context_before":[],"context_after":[]},{"line_number":31,"line":"  const [selectedIndex, setSelectedIndex] = useState(0);","truncated":false,"context_before":[],"context_after":[]}]},{"path":"packages/tui/src/hooks/useSession.ts","source_key":"packages/tui/src/hooks/useSession.ts","snapshot_tag":null,"matches":[{"line_number":11,"line":"  const [session, setSession] = useState<Session | null>(null);","truncated":false,"context_before":[],"context_after":[]}]}],"total_files":3,"total_files_lower_bound":false,"multi_scope":true,"skip":0,"file_limit_reached":false,"per_file_limit_reached":false,"notes":[]}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"kind":"invalid_regex","message":"unclosed group at position 9"}}"#,
		},
		RendererGalleryFixture {
			identity:       glob,
			streaming_args: r#"{"path":"packages/**/*.{test,sp"#,
			args:           r#"{"path":"packages/**/*.{test,spec}.ts","limit":200}"#,
			progress_update: None,
			success_outcome: br#"{"kind":"ok","value":{"matches":[{"path":"packages/coding-agent/src/tools/grep.test.ts","modified_ms":1787702400000,"is_dir":false},{"path":"packages/coding-agent/src/tools/glob.test.ts","modified_ms":1787702100000,"is_dir":false},{"path":"packages/tui/src/components/Chat.test.ts","modified_ms":1787701800000,"is_dir":false},{"path":"packages/tui/src/components/SearchPanel.spec.ts","modified_ms":1787701500000,"is_dir":false},{"path":"packages/core/src/session/session.test.ts","modified_ms":1787701200000,"is_dir":false}],"missing_paths":[],"timed_out":false,"truncated":false,"result_limit_reached":null,"partial_match_count":5,"timeout_ms":5000}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"kind":"invalid_pattern","pattern":"packages/**/[","message":"unclosed character class"}}"#,
		},
	]
}

#[cfg(test)]
mod tests {
	use omp_tool::Rev;

	use super::*;

	fn identity(name: &str) -> ToolIdentity {
		ToolIdentity { name: Str::new(name), rev: Rev { family: Str::new(""), n: 1 } }
	}

	#[test]
	fn grep_fixture_renders_grouped_numbered_matches() {
		let fixture = gallery_fixtures(identity("grep"), identity("glob")).remove(0);
		let outcome: CallOutcome<GrepPayload, GrepFault> =
			serde_json::from_slice(fixture.success_outcome).unwrap();
		let mut state = GrepState::default();
		GrepRenderer.fold_args(
			&mut state,
			&omp_core::slopjson::parse_streaming(fixture.streaming_args),
			false,
		);
		assert!(
			GrepRenderer
				.view(&state, None)
				.expect("streaming grep renders")
				.contains("useSta")
		);
		GrepRenderer.fold_args(&mut state, &omp_core::slopjson::parse_streaming(fixture.args), true);
		let view = GrepRenderer
			.view(&state, Some(&outcome))
			.expect("grep renders");

		assert!(view.contains("<fact label=matches><num value=5/></fact>"));
		assert!(view.contains("<fact label=files><num value=3/></fact>"));
		assert!(view.contains("<row pad-x=0><text bold fg=accent>packages/tui/src/</text>"));
		assert!(view.contains("<row pad-x=2><text bold fg=accent>components/</text>"));
		assert!(view.contains("<col gap=0 pad-x=4><row><text bold>Chat.tsx</text></row>"));
		assert!(view.contains("<text fg=accent>*</text><pre numbers start=18>"));
		assert!(view.contains("&lt;SearchResult"));
		assert!(!view.contains("ctrl+o"));
	}

	#[test]
	fn glob_fixture_renders_folded_path_tree() {
		let fixture = gallery_fixtures(identity("grep"), identity("glob")).remove(1);
		let outcome: CallOutcome<GlobPayload, GlobFault> =
			serde_json::from_slice(fixture.success_outcome).unwrap();
		let mut state = GlobState::default();
		GlobRenderer.fold_args(
			&mut state,
			&omp_core::slopjson::parse_streaming(fixture.streaming_args),
			false,
		);
		assert!(
			GlobRenderer
				.view(&state, None)
				.expect("streaming glob renders")
				.contains("test,sp")
		);
		GlobRenderer.fold_args(&mut state, &omp_core::slopjson::parse_streaming(fixture.args), true);
		let view = GlobRenderer
			.view(&state, Some(&outcome))
			.expect("glob renders");

		assert!(view.contains("<fact label=files><num value=5/></fact>"));
		assert!(view.contains("<fact label=in>packages</fact>"));
		assert!(view.contains("<files max-rows=40 overflow=files>"));
		assert!(view.contains("packages/tui/src/components/SearchPanel.spec.ts"));
		assert!(!view.contains("ctrl+o"));
	}

	#[test]
	fn glob_truncation_and_timeout_use_semantic_facts() {
		let outcome: CallOutcome<GlobPayload, GlobFault> = serde_json::from_slice(
			br#"{"kind":"ok","value":{"matches":[{"path":"src/lib.rs","modified_ms":1,"is_dir":false}],"missing_paths":[],"timed_out":true,"truncated":true,"result_limit_reached":1,"partial_match_count":4,"timeout_ms":2500}}"#,
		)
		.unwrap();
		let mut state = GlobState::default();
		GlobRenderer.fold_args(
			&mut state,
			&omp_core::slopjson::parse_streaming(r#"{"path":"src/**","limit":1}"#),
			true,
		);
		let view = GlobRenderer
			.view(&state, Some(&outcome))
			.expect("glob renders");

		assert!(view.contains("<fact label=truncated><text fg=muted>3 more files</text></fact>"));
		assert!(view.contains("<fact label=\"timed out\"><time ms=2500 kind=duration/></fact>"));
		assert!(!view.contains("ctrl+o"));
	}
}
