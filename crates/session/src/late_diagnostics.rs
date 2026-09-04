//! Durable late language-server diagnostics shared by runtime producers and
//! transcript actors.

use core::fmt::Write as _;

use omp_core::{Str, StrMut};
use omp_dom::{KnownTag, Node, NodeSpec, PropId, Value};
use serde::{Deserialize, Serialize};

/// Stable notice kind used for late diagnostics.
pub const KIND: &str = "diagnostics";

/// One file's diagnostics, retained in producer order.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LateDiagnosticsFile {
	/// Canonical or workspace-relative source path.
	pub path:     Str,
	/// One-line severity summary, such as `2 error(s), 1 warning(s)`.
	pub summary:  Str,
	/// Whether this file contains an error-severity finding.
	pub errored:  bool,
	/// Formatted `path:line:column [severity] [source] message (code)` rows.
	pub messages: Vec<Str>,
}

impl LateDiagnosticsFile {
	/// Recomputes summary and error state after runtime batches are merged.
	pub fn recount(&mut self) {
		let mut counts = [0usize; 4];
		for message in &self.messages {
			if message.contains("[error]") {
				counts[0] += 1;
			} else if message.contains("[warning]") {
				counts[1] += 1;
			} else if message.contains("[info]") {
				counts[2] += 1;
			} else if message.contains("[hint]") {
				counts[3] += 1;
			}
		}
		let labels = ["error(s)", "warning(s)", "info(s)", "hint(s)"];
		let mut summary = StrMut::new("");
		for (count, label) in counts.into_iter().zip(labels) {
			if count == 0 {
				continue;
			}
			if !summary.is_empty() {
				summary.push_str(", ");
			}
			let _ = write!(summary, "{count} {label}");
		}
		if summary.is_empty() {
			summary.push_str("no issues");
		}
		self.summary = summary.freeze();
		self.errored = counts[0] > 0;
	}
}

/// One durable batch of diagnostics that settled after a mutation tool.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct LateDiagnostics {
	/// Files in the runtime producer's stable delivery order.
	pub files: Vec<LateDiagnosticsFile>,
}

impl LateDiagnostics {
	/// Returns `None` when no finding can be presented.
	#[must_use]
	pub fn non_empty(self) -> Option<Self> {
		if self.files.iter().any(|file| !file.messages.is_empty()) {
			Some(self)
		} else {
			None
		}
	}

	/// Model- and copy-visible text preserving file grouping and order.
	#[must_use]
	pub fn body(&self) -> Str {
		let visible = self
			.files
			.iter()
			.filter(|file| !file.messages.is_empty())
			.count();
		let mut body = StrMut::new("<system-notice>\n");
		if visible == 1 {
			body.push_str("Late LSP diagnostics arrived after the edit returned:\n");
		} else {
			let _ = writeln!(
				body,
				"Late LSP diagnostics arrived for {visible} files after their edits returned:"
			);
		}
		for (index, file) in self
			.files
			.iter()
			.filter(|file| !file.messages.is_empty())
			.enumerate()
		{
			if index > 0 {
				body.push('\n');
			}
			let _ = write!(body, "{} — {}", file.path, file.summary);
			for message in &file.messages {
				body.push('\n');
				body.push_str(message);
			}
		}
		body.push_str("\n</system-notice>");
		body.freeze()
	}

	/// Materializes one replay-stable, model-visible diagnostics message.
	pub fn into_node(self) -> Result<NodeSpec, serde_json::Error> {
		let body = self.body();
		let data = serde_json::value::to_raw_value(&self)?;
		Ok(NodeSpec::new(KnownTag::Developer)
			.with_prop(PropId::Kind, Value::Str(Str::new_static(KIND)))
			.with_prop(PropId::Data, Value::Json(data))
			.with_content(body))
	}

	/// Decodes a durable diagnostics notice.
	#[must_use]
	pub fn from_node(node: &Node) -> Option<Self> {
		if node.prop(&PropId::Kind.into()).and_then(Value::as_str) != Some(KIND) {
			return None;
		}
		let Value::Json(data) = node.prop(&PropId::Data.into())? else {
			return None;
		};
		serde_json::from_str(data.get()).ok()
	}
}

#[cfg(test)]
mod tests {
	use omp_dom::{Node, Tag};

	use super::*;

	#[test]
	fn typed_files_round_trip_without_losing_grouping_or_order() {
		let diagnostics = LateDiagnostics {
			files: vec![
				LateDiagnosticsFile {
					path:     Str::new_static("src/a.rs"),
					summary:  Str::new_static("1 error(s)"),
					errored:  true,
					messages: vec![Str::new_static("src/a.rs:2:3 [error] [rustc] broken (E1)")],
				},
				LateDiagnosticsFile {
					path:     Str::new_static("src/b.rs"),
					summary:  Str::new_static("1 warning(s)"),
					errored:  false,
					messages: vec![Str::new_static("src/b.rs:7:1 [warning] [rustc] unused")],
				},
			],
		};
		let spec = diagnostics.clone().into_node().expect("serializes");
		let node = Node {
			tag:     Tag::Known(KnownTag::Developer),
			props:   spec.props,
			kids:    Vec::new(),
			content: spec.content,
		};
		assert_eq!(LateDiagnostics::from_node(&node), Some(diagnostics));
	}
}
