//! Native read and write renderers.

use omp_core::{Str, sf};
use omp_tool::{CallOutcome, ToolIdentity, render::RenderFold};

use super::{
	fault_view, live_view,
	view::{El, Prop as ViewProp},
};
use crate::{
	gallery::RendererGalleryFixture,
	read::{
		Fault as ReadFault, Payload as ReadPayload, PayloadPart, Update as ReadUpdate,
		resolver::Scheme, selector::parse_uri,
	},
	view,
	write::{Fault as WriteFault, Payload as WritePayload, Update as WriteUpdate},
};

#[derive(Default)]
pub(super) struct WriteState {
	path:    Str,
	content: Str,
}

pub(super) struct WriteRenderer;

impl RenderFold for WriteRenderer {
	type Outcome = CallOutcome<WritePayload, WriteFault>;
	type State = WriteState;
	type Update = WriteUpdate;

	fn fold(&self, _state: &mut Self::State, update: Self::Update) {
		match update {}
	}

	fn fold_args(&self, state: &mut Self::State, args: &omp_core::slopjson::Value, _complete: bool) {
		if let Some(path) = args.get("path").and_then(omp_core::slopjson::Value::as_str) {
			state.path = Str::new(path);
		}
		if let Some(content) = args
			.get("content")
			.and_then(omp_core::slopjson::Value::as_str)
		{
			state.content = Str::new(content);
		}
	}

	fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str> {
		match outcome {
			None if state.path.is_empty() && state.content.is_empty() => {
				Some(live_view("write", "writing").into())
			},
			None => Some(render_write_live(state).into()),
			Some(CallOutcome::Ok(payload)) => Some(render_write_payload(state, payload).into()),
			Some(CallOutcome::Faulted(fault)) => Some(fault_view("write", &fault.to_string()).into()),
			Some(CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. }) => None,
		}
	}
}

#[derive(Default)]
pub(super) struct ReadState {
	phase: Option<Str>,
	path:  Str,
}

pub(super) struct ReadRenderer;

impl RenderFold for ReadRenderer {
	type Outcome = CallOutcome<ReadPayload, ReadFault>;
	type State = ReadState;
	type Update = ReadUpdate;

	fn fold(&self, state: &mut Self::State, update: Self::Update) {
		state.phase = Some(update.phase);
	}

	fn fold_args(&self, state: &mut Self::State, args: &omp_core::slopjson::Value, _complete: bool) {
		if let Some(path) = args.get("path").and_then(omp_core::slopjson::Value::as_str) {
			state.path = Str::new(path);
		}
	}

	fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str> {
		match outcome {
			None if state.path.is_empty() => {
				Some(live_view("read", state.phase.as_deref().unwrap_or("reading")).into())
			},
			None => Some(render_read_live(state).into()),
			Some(CallOutcome::Ok(payload)) => Some(render_read_payload(&state.path, payload).into()),
			Some(CallOutcome::Faulted(fault)) => {
				Some(if grouped_read_target(&state.path) && !state.path.is_empty() {
					render_read_fault_grouped(&state.path, fault.message()).into()
				} else {
					fault_view("read", fault.message()).into()
				})
			},
			Some(CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. }) => None,
		}
	}
}

const WRITE_PREVIEW_LINES: usize = 6;
const READ_PREVIEW_LINES: usize = 8;

fn render_read_live(state: &ReadState) -> El {
	let live = view! {
		<row sep=" · ">
			<spinner color=accent/>
			<fact label="Path">{&state.path}</fact>
			<fact label="Status">{state.phase.as_deref().unwrap_or("reading")}</fact>
		</row>
	};
	if grouped_read_target(&state.path) {
		live.prop(ViewProp::Chrome, "flush")
	} else {
		live
	}
}

/// Whether a read target collapses into the compact, chrome-free grouped
/// presentation.
///
/// Filesystem paths, web URLs, and unrecognized schemes (including
/// extension-defined schemes) collapse into compact groups — while recognized
/// internal URLs (`skill://`, `agent://`, `pr://`, …) keep the full card so
/// their resolved content stays visible.
fn grouped_read_target(path: &str) -> bool {
	match parse_uri(path) {
		Ok(Some(uri)) => matches!(uri.scheme, Scheme::File | Scheme::Http | Scheme::Unknown),
		Ok(None) | Err(_) => true,
	}
}

/// One-line, chrome-free settled fault for a grouped read target.
fn render_read_fault_grouped(path: &str, message: &str) -> El {
	view! {
		<row gap=1 chrome="flush">
			<icon name="error" color=err/>
			<text bold fg=err>{"read"}</text>
			<text>{path}</text>
			<text fg=err>{message}</text>
		</row>
	}
}

fn render_write_live(state: &WriteState) -> El {
	let line_count = content_line_count(&state.content);
	view! {
		<col gap=1>
			<row sep=" · ">
				<spinner color=accent/>
				<fact label="Path">{&state.path}</fact>
				<fact label="Lines">{sf!("{line_count}")}</fact>
				<fact label="Size"><bytes value={state.content.len()}/></fact>
			</row>
			if !state.content.is_empty() {
				<pre numbers start=1 max-rows={WRITE_PREVIEW_LINES} overflow="lines">
					{&state.content}
				</pre>
			}
		</col>
	}
}

fn render_write_payload(state: &WriteState, payload: &WritePayload) -> El {
	let line_count = content_line_count(&state.content);
	view! {
		<col gap=1>
			<callout kind="success">{payload.disposition.to_string()}</callout>
			<fact label="Path">{&payload.display_path}</fact>
			<row sep=" · ">
				<fact label="Lines">{sf!("{line_count}")}</fact>
				<fact label="Size"><bytes value={payload.byte_len}/></fact>
				if payload.made_executable || payload.stripped_wrapper {
					<fact label="Flags">
						<row sep=" · ">
							if payload.made_executable {
								<text>{"executable"}</text>
							}
							if payload.stripped_wrapper {
								<text>{"stripped wrapper"}</text>
							}
						</row>
					</fact>
				}
			</row>
			if !state.content.is_empty() {
				<pre numbers start=1 max-rows={WRITE_PREVIEW_LINES} overflow="lines">
					{&state.content}
				</pre>
			}
		</col>
	}
}

fn content_line_count(content: &str) -> usize {
	if content.is_empty() {
		0
	} else {
		content
			.bytes()
			.filter(|byte| *byte == b'\n')
			.count()
			.saturating_add(1)
	}
}

fn render_read_payload(path: &str, payload: &ReadPayload) -> El {
	let mut text_bytes = 0u64;
	let mut blob_bytes = 0u64;
	let mut text_lines = 0usize;
	let mut preview = None;
	for part in &payload.parts {
		match part {
			PayloadPart::Text { text } => {
				text_bytes = text_bytes.saturating_add(u64::try_from(text.len()).unwrap_or(u64::MAX));
				text_lines =
					text_lines.saturating_add(text.lines().filter(|line| !is_read_header(line)).count());
				if preview.is_none() {
					preview = prepare_read_pre_body(text);
				}
			},
			PayloadPart::Blob { blob, .. } => {
				blob_bytes = blob_bytes.saturating_add(blob.byte_len);
			},
		}
	}
	let part_count = payload.parts.len();
	let byte_count = text_bytes.saturating_add(blob_bytes);
	if grouped_read_target(path) {
		return view! {
			<row sep=" · " chrome="flush">
				<row gap=1>
					<icon name="success" color=ok/>
					<text bold>{"read"}</text>
					<text>{path}</text>
				</row>
				<fact label="Lines">{sf!("{text_lines}")}</fact>
				<fact label="Size"><bytes value={byte_count}/></fact>
			</row>
		};
	}
	view! {
		<col gap=1>
			<fact label="Path">{path}</fact>
			<row sep=" · ">
				<fact label="Parts">{sf!("{part_count}")}</fact>
				<fact label="Lines">{sf!("{text_lines}")}</fact>
				<fact label="Size"><bytes value={byte_count}/></fact>
			</row>
			if let Some((start, body)) = preview {
				<pre numbers start={start} max-rows={READ_PREVIEW_LINES} overflow="lines">
					{body}
				</pre>
			}
		</col>
	}
}

fn prepare_read_pre_body(text: &str) -> Option<(u64, String)> {
	let mut start = 1;
	let mut body = String::new();
	let mut line_count = 0usize;
	for line in text.lines().filter(|line| !is_read_header(line)) {
		let (number, content) = line
			.split_once(':')
			.filter(|(number, _)| {
				!number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
			})
			.map_or((None, line), |(number, content)| (number.parse::<u64>().ok(), content));
		if line_count == 0 {
			start = number.unwrap_or(1);
		} else {
			body.push('\n');
		}
		body.push_str(content);
		line_count += 1;
	}
	(line_count != 0).then_some((start, body))
}

fn is_read_header(line: &str) -> bool {
	line.starts_with('[') && line.ends_with(']') && line.contains('#')
}

/// Native write and read renderer lifecycle fixtures for the visual QA gallery.
pub fn gallery_fixtures(write: ToolIdentity, read: ToolIdentity) -> Vec<RendererGalleryFixture> {
	vec![
		RendererGalleryFixture {
			identity: write,
			streaming_args: r#"{"path":"tests/session.test.ts","content":"import { descr"#,
			args: r#"{"path":"tests/session.test.ts","content":"import { describe, expect, test } from \"bun:test\";\nimport { createSession } from \"../src/session\";\n\ndescribe(\"session\", () => {\n\ttest(\"refreshes an expired token\", async () => {\n\t\tconst session = createSession({ expiresAt: 0 });\n\t\tawait session.refresh();\n\t\texpect(session.expired).toBe(false);\n\t});\n});"}"#,
			progress_update: None,
			success_outcome: br#"{"kind":"ok","value":{"resolved_path":"/work/app/tests/session.test.ts","display_path":"tests/session.test.ts","byte_len":320,"reported_len":320,"disposition":"created","stripped_wrapper":false,"made_executable":false,"snapshot_tag":"A7C2","operation":{"kind":"plain"}}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"kind":"document","message":"EACCES: permission denied, open 'tests/session.test.ts'"}}"#,
		},
		RendererGalleryFixture {
			identity: read,
			streaming_args: r#"{"path":"src/session.ts:437-"#,
			args: r#"{"path":"src/session.ts:437-442"}"#,
			progress_update: Some(br#"{"phase":"resolving source range"}"#),
			success_outcome: br#"{"kind":"ok","value":{"parts":[{"kind":"text","text":"[src/session.ts#D4E1]\n437:export const refreshSession = async (session: Session) => {\n438:\tif (!session.expired) return session;\n439:\tconst token = await auth.refresh(session.refreshToken);\n440:\treturn { ...session, token, expired: false };\n441:};\n442:"}]}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"kind":"source","message":"No such file or directory: src/session.ts"}}"#,
		},
	]
}

#[cfg(test)]
mod tests {
	use bytes::Bytes;
	use omp_core::sf;
	use omp_tool::{Abort, ArgIssue, ArgIssueKind, BlobRef, CallOutcome, render::ViewState};

	use crate::{
		read::{Fault as ReadFault, Payload as ReadPayload, PayloadPart, Update as ReadUpdate},
		render::test_support::{identities, registry},
		write::{Fault as WriteFault, Payload as WritePayload, WriteDisposition, WriteOperation},
	};

	#[test]
	fn typed_fault_renders_while_args_and_abort_use_generic_facts() {
		let (registry, identities) = registry(identities());
		let state = ViewState::new();
		let fault = CallOutcome::<ReadPayload, ReadFault>::Faulted(ReadFault::Source {
			message: sf!("missing <file> & owner"),
		});
		let encoded_fault = serde_json::to_vec(&fault).expect("fault serializes");
		assert_eq!(
			registry
				.view(identities.read.as_ref().unwrap(), &state, Some(&encoded_fault))
				.expect("typed fault renders")
				.as_str(),
			"<row gap=1><text bold fg=err>read</text><text fg=err>missing &lt;file&gt; &amp; \
			 owner</text></row>",
		);

		let write_fault = CallOutcome::<WritePayload, WriteFault>::Faulted(WriteFault::Document {
			message: sf!("cannot write <file> & owner"),
		});
		let encoded_write_fault = serde_json::to_vec(&write_fault).expect("write fault serializes");
		assert_eq!(
			registry
				.view(identities.write.as_ref().unwrap(), &state, Some(&encoded_write_fault),)
				.expect("typed write fault renders")
				.as_str(),
			"<row gap=1><text bold fg=err>write</text><text fg=err>cannot write &lt;file&gt; &amp; \
			 owner</text></row>",
		);

		let args = CallOutcome::<ReadPayload, ReadFault>::ArgsRejected(ArgIssue {
			path:     Vec::new(),
			expected: sf!("path"),
			kind:     ArgIssueKind::Missing,
			example:  Some(sf!(r#"{{"path":"src/lib.rs"}}"#)),
			found:    None,
		});
		let encoded_args = serde_json::to_vec(&args).expect("argument issue serializes");
		assert_eq!(
			registry
				.view(identities.read.as_ref().unwrap(), &state, Some(&encoded_args))
				.expect("argument fallback renders")
				.as_str(),
			std::str::from_utf8(&encoded_args).expect("JSON is UTF-8"),
		);

		let abort = CallOutcome::<ReadPayload, ReadFault>::aborted(Abort::Interrupted {
			reason: sf!("cancelled"),
		});
		let encoded_abort = serde_json::to_vec(&abort).expect("abort serializes");
		assert_eq!(
			registry
				.view(identities.read.as_ref().unwrap(), &state, Some(&encoded_abort))
				.expect("abort fallback renders")
				.as_str(),
			std::str::from_utf8(&encoded_abort).expect("JSON is UTF-8"),
		);
	}

	#[test]
	fn read_live_preserves_the_path_phase_and_escaping() {
		let (registry, identities) = registry(identities());
		let identity = identities.read.as_ref().expect("read identity registered");
		let mut state = ViewState::new();
		registry
			.fold_args(
				identity,
				&mut state,
				&omp_core::slopjson::parse_streaming(r#"{"path":"src/<&>.rs:9-"}"#),
				false,
			)
			.expect("streaming read args fold");
		let update = ReadUpdate { phase: sf!("resolving <source> & range") };
		registry
			.fold(
				identity,
				&mut state,
				Bytes::from(serde_json::to_vec(&update).expect("update serializes")),
			)
			.expect("read update folds");
		assert_eq!(
			registry
				.view(identity, &state, None)
				.expect("live read renders")
				.as_str(),
			"<row sep=\" · \" chrome=flush><spinner color=accent/><fact \
			 label=Path>src/&lt;&amp;&gt;.rs:9-</fact><fact label=Status>resolving &lt;source&gt; \
			 &amp; range</fact></row>",
		);
	}

	#[test]
	fn streaming_write_args_render_a_numbered_partial_preview() {
		let (registry, identities) = registry(identities());
		let identity = identities
			.write
			.as_ref()
			.expect("write identity registered");
		let mut state = ViewState::new();
		registry
			.fold_args(
				identity,
				&mut state,
				&omp_core::slopjson::parse_streaming(
					r#"{"path":"tests/session.test.ts","content":"import { descr"#,
				),
				false,
			)
			.expect("streaming write args fold");
		assert_eq!(
			registry
				.view(identity, &state, None)
				.expect("streaming write renders")
				.as_str(),
			"<col gap=1><row sep=\" · \"><spinner color=accent/><fact \
			 label=Path>tests/session.test.ts</fact><fact label=Lines>1</fact><fact \
			 label=Size><bytes value=14/></fact></row><pre numbers start=1 max-rows=6 \
			 overflow=lines>import { descr</pre></col>",
		);
	}

	#[test]
	fn settled_output_is_deterministic_and_escapes_payload_text() {
		let (registry, identities) = registry(identities());
		let outcome = CallOutcome::<WritePayload, WriteFault>::Ok(WritePayload {
			resolved_path:      sf!("/tmp/a<&.txt"),
			display_path:       sf!("a<&.txt"),
			canonical_recovery: None,
			byte_len:           9,
			reported_len:       9,
			disposition:        WriteDisposition::Created,
			stripped_wrapper:   true,
			made_executable:    true,
			snapshot_tag:       Some(sf!("ABCD")),
			operation:          WriteOperation::Plain,
		});
		let encoded = serde_json::to_vec(&outcome).expect("outcome serializes");
		let mut state = ViewState::new();
		let write_identity = identities
			.write
			.as_ref()
			.expect("write identity registered");
		registry
			.fold_args(
				write_identity,
				&mut state,
				&omp_core::slopjson::parse_streaming(r#"{"path":"a<&.txt","content":"a<&>\nline"}"#),
				true,
			)
			.expect("write args fold");
		let first = registry
			.view(write_identity, &state, Some(&encoded))
			.expect("write renders");
		let second = registry
			.view(write_identity, &state, Some(&encoded))
			.expect("write rerenders");
		assert_eq!(first, second);
		assert_eq!(
			first.as_str(),
			"<col gap=1><callout kind=success>created</callout><fact \
			 label=Path>a&lt;&amp;.txt</fact><row sep=\" · \"><fact label=Lines>2</fact><fact \
			 label=Size><bytes value=9/></fact><fact label=Flags><row sep=\" · \
			 \"><text>executable</text><text>stripped wrapper</text></row></fact></row><pre numbers \
			 start=1 max-rows=6 overflow=lines>a&lt;&amp;&gt;\nline</pre></col>",
		);
	}

	#[test]
	fn read_success_shows_path_metadata_and_numbered_preview() {
		let (registry, identities) = registry(identities());
		let outcome = CallOutcome::<ReadPayload, ReadFault>::Ok(ReadPayload {
			parts: vec![PayloadPart::Text {
				text: sf!("[src/a.rs#ABCD]\n437:let x = <tag>;\n438:return x & 1;"),
			}],
		});
		let encoded = serde_json::to_vec(&outcome).expect("outcome serializes");
		let read_identity = identities.read.as_ref().expect("read identity registered");
		let mut state = ViewState::new();
		registry
			.fold_args(
				read_identity,
				&mut state,
				&omp_core::slopjson::parse_streaming(r#"{"path":"skill://react"}"#),
				true,
			)
			.expect("read args fold");
		let rendered = registry
			.view(read_identity, &state, Some(&encoded))
			.expect("read renders");
		assert_eq!(
			rendered.as_str(),
			"<col gap=1><fact label=Path>skill://react</fact><row sep=\" · \"><fact \
			 label=Parts>1</fact><fact label=Lines>2</fact><fact label=Size><bytes \
			 value=52/></fact></row><pre numbers start=437 max-rows=8 overflow=lines>let x = \
			 &lt;tag&gt;;\nreturn x &amp; 1;</pre></col>",
		);
	}
	#[test]
	fn grouped_file_read_settles_to_a_flush_one_liner() {
		let payload = ReadPayload {
			parts: vec![PayloadPart::Text {
				text: sf!("[src/a.rs#ABCD]\n437:let x = <tag>;\n438:return x & 1;"),
			}],
		};
		let rendered = super::render_read_payload("src/a.rs:437-438", &payload).to_tml();
		assert_eq!(
			rendered.as_str(),
			"<row sep=\" · \" chrome=flush><row gap=1><icon color=ok>success</icon><text \
			 bold>read</text><text>src/a.rs:437-438</text></row><fact label=Lines>2</fact><fact \
			 label=Size><bytes value=52/></fact></row>",
		);
		let fault = super::render_read_fault_grouped("src/a.rs", "No such file").to_tml();
		assert_eq!(
			fault.as_str(),
			"<row gap=1 chrome=flush><icon color=err>error</icon><text bold \
			 fg=err>read</text><text>src/a.rs</text><text fg=err>No such file</text></row>",
		);
	}

	#[test]
	fn overflow_pre_retains_the_full_semantic_body_without_manual_chrome() {
		let payload = ReadPayload {
			parts: vec![PayloadPart::Text {
				text: sf!(
					"[src/a.rs#ABCD]\n21:one\n22:two\n23:three\n24:four\n25:five\n26:six\n27:seven\n28:\
					 eight\n29:nine\n30:ten"
				),
			}],
		};
		let rendered = super::render_read_payload("agent://abc123", &payload);
		let rendered = rendered.to_tml();
		assert_eq!(
			rendered.as_str(),
			"<col gap=1><fact label=Path>agent://abc123</fact><row sep=\" · \"><fact \
			 label=Parts>1</fact><fact label=Lines>10</fact><fact label=Size><bytes \
			 value=94/></fact></row><pre numbers start=21 max-rows=8 \
			 overflow=lines>one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten</pre></col>",
		);
		assert!(!rendered.contains("ctrl+o"));
		assert!(!rendered.contains('│'));
		assert!(!rendered.contains("[src/a.rs#ABCD]"));
	}

	#[test]
	fn read_blob_and_multipart_counts_remain_semantic() {
		let (registry, identities) = registry(identities());
		let read_identity = identities.read.as_ref().expect("read identity registered");
		let mut state = ViewState::new();
		registry
			.fold_args(
				read_identity,
				&mut state,
				&omp_core::slopjson::parse_streaming(r#"{"path":"assets/<&>.bin"}"#),
				true,
			)
			.expect("read args fold");

		let blob = BlobRef {
			hash:       sf!("blob-hash"),
			media_type: sf!("application/octet-stream"),
			byte_len:   7,
		};
		let multipart = CallOutcome::<ReadPayload, ReadFault>::Ok(ReadPayload {
			parts: vec![
				PayloadPart::Text { text: sf!("[a#1]\n9:&") },
				PayloadPart::Blob { blob: blob.clone(), alt: sf!("binary"), vision: None },
				PayloadPart::Text { text: sf!("[b#2]\n20:<") },
			],
		});
		let encoded = serde_json::to_vec(&multipart).expect("multipart outcome serializes");
		assert_eq!(
			registry
				.view(read_identity, &state, Some(&encoded))
				.expect("multipart read renders")
				.as_str(),
			"<row sep=\" · \" chrome=flush><row gap=1><icon color=ok>success</icon><text \
			 bold>read</text><text>assets/&lt;&amp;&gt;.bin</text></row><fact \
			 label=Lines>2</fact><fact label=Size><bytes value=26/></fact></row>",
		);

		let blob_only = CallOutcome::<ReadPayload, ReadFault>::Ok(ReadPayload {
			parts: vec![PayloadPart::Blob { blob, alt: sf!("binary"), vision: None }],
		});
		let encoded = serde_json::to_vec(&blob_only).expect("blob outcome serializes");
		assert_eq!(
			registry
				.view(read_identity, &state, Some(&encoded))
				.expect("blob read renders")
				.as_str(),
			"<row sep=\" · \" chrome=flush><row gap=1><icon color=ok>success</icon><text \
			 bold>read</text><text>assets/&lt;&amp;&gt;.bin</text></row><fact \
			 label=Lines>0</fact><fact label=Size><bytes value=7/></fact></row>",
		);
	}
}
