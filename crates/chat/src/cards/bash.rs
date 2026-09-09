//! Typed card for `bash@1`.

use omp_tui::{IntoComponent as _, UiContext, dom};
use serde_json::Value;

use super::{
	Card, CardStatus, CardView, Component, elapsed_badge, typed_fault, typed_input, typed_result,
};

/// Collapsed output rows shown while a command runs: the tail of the live
/// output behind an "earlier lines" marker.
pub const BASH_DEFAULT_PREVIEW_LINES: usize = 10;

/// Shell-command card with durable transcript and terminal metadata.
pub struct BashCard;

/// The live output window while a command runs: the last
/// [`BASH_DEFAULT_PREVIEW_LINES`] logical lines (all of them when expanded)
/// and, when lines were skipped, the dim marker
/// `… (N earlier lines, showing M of T) (ctrl+o to expand)`.
fn output_tail(output: &str, expanded: bool) -> Option<(Option<String>, String)> {
	let output = output.trim_end();
	if output.trim().is_empty() {
		return None;
	}
	let total = output.lines().count();
	if expanded || total <= BASH_DEFAULT_PREVIEW_LINES {
		return Some((None, output.to_owned()));
	}
	let skipped = total - BASH_DEFAULT_PREVIEW_LINES;
	let marker = format!(
		"… ({skipped} earlier lines, showing {BASH_DEFAULT_PREVIEW_LINES} of {total}) (ctrl+o to \
		 expand)"
	);
	// `lines()` strips `\n` and `\r\n` alike, so the window is rejoined from
	// the logical lines rather than sliced at a computed byte offset.
	let tail = output.lines().skip(skipped).collect::<Vec<_>>().join("\n");
	Some((Some(marker), tail))
}

impl Card for BashCard {
	fn tool(&self) -> &'static str {
		"bash"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, _ui: &UiContext) -> Component {
		let args = typed_input::<omp_tools::shell::Params>(view);
		let command = args
			.as_ref()
			.and_then(|value| value.get("command"))
			.and_then(Value::as_str)
			.map(str::to_owned)
			.or_else(|| partial_string(view.args_text().unwrap_or_default(), "command"))
			.unwrap_or_default();
		let cwd = args
			.as_ref()
			.and_then(|value| value.get("cwd"))
			.and_then(Value::as_str);
		let shown_command =
			cwd.map_or_else(|| command.clone(), |cwd| format!("cd {cwd} && {command}"));
		// A non-zero exit is `Fault::CommandFailed { payload }`: paint it as
		// the ordinary output box with `Exit: N`, so the failed payload is
		// the result and the fault line is dropped.
		let failed = view
			.fault::<omp_tools::shell::Fault>()
			.and_then(|fault| match fault {
				omp_tools::shell::Fault::CommandFailed { payload } => {
					serde_json::to_value(payload).ok()
				},
				_ => None,
			});
		let result = failed.or_else(|| typed_result::<omp_tools::shell::Payload>(view));
		let output = result.as_ref().map(output_text).unwrap_or_default();
		let fault = if result.is_some() && view.status == CardStatus::Failed {
			None
		} else {
			diag_text(view).or_else(|| {
				result
					.as_ref()
					.and_then(|value| value.get("text").or_else(|| value.get("error")))
					.and_then(Value::as_str)
					.map(str::to_owned)
			})
		};
		let wall_ms = result.as_ref().and_then(|value| {
			value
				.get("wall_ms")
				.or_else(|| value.pointer("/status/wall_clock_ms"))
				.and_then(Value::as_u64)
		});
		let timeout = args
			.as_ref()
			.and_then(|value| value.get("timeout"))
			.and_then(Value::as_f64);
		let exit = result.as_ref().and_then(|value| {
			value
				.get("exit")
				.or_else(|| value.pointer("/status/exit_code"))
				.and_then(Value::as_i64)
		});
		let meta = wall_ms.map(|wall| {
			let mut text = format!("Wall: {:.2}s", wall as f64 / 1_000.0);
			if let Some(timeout) = timeout {
				text.push_str(&format!(" | Timeout: {timeout}s"));
			}
			if view.status == CardStatus::Failed || exit.is_some_and(|code| code != 0) {
				if let Some(exit) = exit {
					text.push_str(&format!(" | Exit: {exit}"));
				}
			}
			text
		});
		let tail = (view.status == CardStatus::InProgress)
			.then(|| view.output.and_then(|output| output_tail(output, expanded)))
			.flatten();
		// The collapsed window applies after completion too, so the block never
		// jumps when the call settles; only ctrl+o uncaps.
		let settled = output_tail(&output, expanded);
		dom! {
			<box border=round bc={match view.status { CardStatus::Failed => "err", CardStatus::Done => "muted", CardStatus::StreamingArgs | CardStatus::InProgress => "accent" }} bg={if view.status == CardStatus::Failed { "error_surface" } else { "panel" }} bleed>
				<row pad-x=1 gap=0><text fg=muted>{"$"}</text><text fg=muted>{" "}</text><pre path="command.sh">{shown_command}</pre>
					if let Some(badge) = elapsed_badge(view) { {badge} }
				</row>
				if let Some((marker, lines)) = tail {
					<hr title="Output" title_pad=3 bc=muted/>
					<col pad-x=1>
						if let Some(marker) = marker { <text fg=muted truncate>{marker}</text> }
						<pre fg=output>{lines}</pre>
					</col>
				}
				if matches!(view.status, CardStatus::Done | CardStatus::Failed) && (settled.is_some() || fault.is_some()) {
					<hr title="Output" title_pad=3 bc={if view.status == CardStatus::Failed { "err" } else { "muted" }}/>
					<col pad-x=1>
						if let Some((marker, lines)) = settled {
							if let Some(marker) = marker { <text fg=muted truncate>{marker}</text> }
							<pre fg=output>{lines}</pre>
						}
						if let Some(message) = fault {
							<pre fg=output>{message}</pre>
						}
						if let Some(meta) = meta {
							<row fg=muted><i:bracket-left fg=muted/><text>{meta}</text><i:bracket-right fg=muted/></row>
						}
					</col>
				}
			</box>
		}
		.into_component()
	}
}

fn output_text(result: &Value) -> String {
	if let Some(frames) = result.get("transcript").and_then(Value::as_array) {
		return frames
			.iter()
			.filter_map(|frame| frame.get("data"))
			.map(bytes_or_text)
			.collect();
	}
	result
		.get("output")
		.and_then(Value::as_str)
		.unwrap_or_default()
		.to_owned()
}

fn bytes_or_text(value: &Value) -> String {
	if let Some(text) = value.as_str() {
		return text.to_owned();
	}
	value
		.as_array()
		.map(|bytes| {
			String::from_utf8_lossy(
				&bytes
					.iter()
					.filter_map(Value::as_u64)
					.filter_map(|byte| u8::try_from(byte).ok())
					.collect::<Vec<_>>(),
			)
			.into_owned()
		})
		.unwrap_or_default()
}

fn partial_string(raw: &str, key: &str) -> Option<String> {
	let start = raw.find(&format!("\"{key}\""))?;
	let value = raw[start..].find(':')? + start + 1;
	let quote = raw[value..].find('"')? + value + 1;
	let bytes = raw.as_bytes();
	let mut escaped = false;
	for index in quote..bytes.len() {
		match (bytes[index], escaped) {
			(b'"', false) => return serde_json::from_str(&raw[quote - 1..=index]).ok(),
			(b'\\', false) => escaped = true,
			_ => escaped = false,
		}
	}
	Some(raw[quote..].replace("\\n", "\n").replace("\\\"", "\""))
}

fn diag_text(view: &CardView<'_>) -> Option<String> {
	typed_fault::<omp_tools::shell::Fault>(view)
		.map(|fault| fault.to_string())
		.or_else(|| {
			view.diag.and_then(|node| {
				node
					.content
					.as_deref()
					.or_else(|| {
						node
							.prop(&omp_dom::PropId::Text.into())
							.and_then(omp_dom::Value::as_str)
					})
					.filter(|text| !text.is_empty())
					.map(str::to_owned)
			})
		})
}

#[cfg(test)]
mod tests {
	use omp_core::Str;
	use omp_dom::{KnownTag, Node, PropId, Value};
	use omp_tui::{Ui, UiContext, test_support::frame_row_text};

	use super::{BASH_DEFAULT_PREVIEW_LINES, BashCard, output_tail};
	use crate::cards::{Card as _, CardStatus, CardView};

	fn text_node(tag: KnownTag, text: &'static str) -> Node {
		let mut props = smallvec::SmallVec::new();
		props.push((PropId::Text.into(), Value::Str(Str::new_static(text))));
		Node { tag: tag.into(), props, kids: Vec::new(), content: None }
	}

	fn rows(view: &CardView<'_>, expanded: bool) -> Vec<String> {
		let ui = Ui::from_root(
			BashCard.render(view, expanded, &UiContext::default()),
			100,
			UiContext::default(),
		);
		(0..ui.frame().size().height)
			.map(|y| frame_row_text(ui.frame(), y))
			.collect()
	}

	#[test]
	fn bash_card_streams_the_last_ten_output_lines_while_running() {
		let input = text_node(KnownTag::Input, r#"{"command":"cargo build"}"#);
		let output = (1..=25).map(|n| format!("line {n}\n")).collect::<String>();
		let view = CardView {
			input:   &input,
			result:  None,
			diag:    None,
			notices: smallvec::SmallVec::new(),
			usage:   None,
			status:  CardStatus::InProgress,
			output:  Some(&output),
			started: None,
		};
		let rows = rows(&view, false);
		let joined = rows.join("\n");
		assert!(joined.contains("$ cargo build"), "{joined}");
		assert!(joined.contains("Output"), "{joined}");
		assert!(
			joined.contains("… (15 earlier lines, showing 10 of 25) (ctrl+o to expand)"),
			"{joined}"
		);
		for n in 16..=25 {
			assert!(joined.contains(&format!("line {n}")), "line {n} missing: {joined}");
		}
		assert!(!joined.contains("line 15 ") && !joined.contains("line 1 "), "{joined}");
		let shown = rows.iter().filter(|row| row.contains("line ")).count();
		assert_eq!(shown, BASH_DEFAULT_PREVIEW_LINES);

		// Ctrl+O uncaps the window; a settled card never shows the tail.
		let expanded = rows_join(&view, true);
		assert!(expanded.contains("line 1 ") && expanded.contains("line 25"), "{expanded}");
		assert!(!expanded.contains("earlier lines"), "{expanded}");
		let settled = CardView { status: CardStatus::Done, ..view };
		assert!(!rows_join(&settled, false).contains("line 25"));
	}

	fn rows_join(view: &CardView<'_>, expanded: bool) -> String {
		rows(view, expanded).join("\n")
	}

	/// A settled call carries the journaled `CallOutcome` envelope on its
	/// `<result>`; the collapsed card windows the output like the streaming
	/// tail so the block never jumps on settle.
	#[test]
	fn settled_bash_card_reads_the_outcome_envelope_and_keeps_the_tail_window() {
		let input = text_node(KnownTag::Input, r#"{"command":"cargo build"}"#);
		let transcript = (1..=25)
			.map(|n| {
				let bytes = format!("line {n}\n").into_bytes();
				serde_json::json!({"channel": "stdout", "data": bytes, "sequence": n})
			})
			.collect::<Vec<_>>();
		let envelope = serde_json::json!({
			"kind": "ok",
			"value": {
				"session_id": [], "exec_id": [], "command": "cargo build",
				"transcript": transcript, "attachments": [], "adjustments": [],
				"status": {"outcome": "exited", "exit_code": 0, "signal": null,
					"wall_clock_ms": 180, "spilled_output": null, "aborted": false,
					"effects_unknown": false, "final_cwd_uri": null, "final_cwd_revision": 0}
			}
		});
		let mut result = text_node(KnownTag::Result, "");
		result.props.push((
			PropId::Outcome.into(),
			Value::Json(serde_json::value::to_raw_value(&envelope).unwrap()),
		));
		let view = CardView {
			input:   &input,
			result:  Some(&result),
			diag:    None,
			notices: smallvec::SmallVec::new(),
			usage:   None,
			status:  CardStatus::Done,
			output:  None,
			started: None,
		};
		let collapsed = rows_join(&view, false);
		assert!(
			collapsed.contains("… (15 earlier lines, showing 10 of 25) (ctrl+o to expand)"),
			"{collapsed}"
		);
		assert!(collapsed.contains("line 25") && !collapsed.contains("line 15 "), "{collapsed}");
		assert!(collapsed.contains("Wall: 0.18s"), "{collapsed}");
		let expanded = rows_join(&view, true);
		assert!(expanded.contains("line 1 ") && !expanded.contains("earlier lines"), "{expanded}");
	}

	/// A non-zero exit is still the ordinary output box, with `Exit: N` in
	/// the meta row and no raw fault JSON.
	#[test]
	fn failed_bash_card_renders_the_command_failed_payload_as_output() {
		let input = text_node(KnownTag::Input, r#"{"command":"false"}"#);
		let envelope = serde_json::json!({
			"kind": "faulted",
			"value": {"kind": "command_failed", "payload": {
				"session_id": [], "exec_id": [], "command": "false", "attachments": [], "adjustments": [],
				"transcript": [{"channel": "stderr", "data": b"boom\n".to_vec(), "sequence": 1}],
				"status": {"outcome": "exited", "exit_code": 2, "signal": null, "wall_clock_ms": 20,
					"spilled_output": null, "aborted": false, "effects_unknown": false,
					"final_cwd_uri": null, "final_cwd_revision": 0}}}
		});
		let mut diag = text_node(KnownTag::Diag, "");
		diag.props.push((
			PropId::Fault.into(),
			Value::Json(serde_json::value::to_raw_value(&envelope).unwrap()),
		));
		let view = CardView {
			input:   &input,
			result:  None,
			diag:    Some(&diag),
			notices: smallvec::SmallVec::new(),
			usage:   None,
			status:  CardStatus::Failed,
			output:  None,
			started: None,
		};
		let rendered = rows_join(&view, false);
		assert!(rendered.contains("boom"), "{rendered}");
		assert!(rendered.contains("Exit: 2"), "{rendered}");
		assert!(!rendered.contains("command_failed") && !rendered.contains("{\""), "{rendered}");
	}

	#[test]
	fn output_tail_windows_logical_lines() {
		assert_eq!(output_tail("", false), None);
		assert_eq!(output_tail("  \n\n", false), None);
		assert_eq!(output_tail("a\nb\n", false), Some((None, "a\nb".to_owned())));
		let (marker, lines) = output_tail("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n", false).unwrap();
		assert_eq!(
			marker.as_deref(),
			Some("… (1 earlier lines, showing 10 of 11) (ctrl+o to expand)")
		);
		assert_eq!(lines, "2\n3\n4\n5\n6\n7\n8\n9\n10\n11");
		assert_eq!(
			output_tail("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n", true),
			Some((None, "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11".to_owned()))
		);
	}

	/// CRLF line ends and multi-byte text never shift or split the window.
	#[test]
	fn output_tail_survives_crlf_and_unicode_lines() {
		let output = (1..=12)
			.map(|n| format!("ライン {n} — ✓\r\n"))
			.collect::<String>();
		let (marker, lines) = output_tail(&output, false).unwrap();
		assert_eq!(
			marker.as_deref(),
			Some("… (2 earlier lines, showing 10 of 12) (ctrl+o to expand)")
		);
		assert!(lines.starts_with("ライン 3 — ✓"), "{lines}");
		assert!(lines.ends_with("ライン 12 — ✓"), "{lines}");
		assert_eq!(lines.lines().count(), 10);
	}

	#[test]
	fn reads_partial_streamed_command() {
		assert_eq!(
			super::partial_string(r#"{"command":"git status --short"#, "command").as_deref(),
			Some("git status --short")
		);
	}
}
