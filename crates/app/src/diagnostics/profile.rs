//! Native work-profile aggregation and explicit-format attachments.

use std::{collections::BTreeMap, fmt::Write as _};

use serde::Serialize;

use super::ProfilePayload;

/// One runtime-provided native work sample.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkSample {
	/// Semicolon-separated root-to-leaf native task/function stack.
	pub stack:     String,
	/// Time represented by this sample in microseconds.
	pub weight_us: u64,
}

/// Aggregated function row derived from folded native samples.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct FunctionSummary {
	/// Leaf function or task name.
	pub function:      String,
	/// Sampled self time in microseconds.
	pub self_us:       u64,
	/// Fraction of total sampled time.
	pub percent_milli: u64,
}

/// Converts runtime work samples into a folded-stack attachment.
pub fn folded(samples: &[WorkSample]) -> ProfilePayload {
	let mut weights = BTreeMap::<&str, u64>::new();
	for sample in samples {
		let weight = weights.entry(sample.stack.as_str()).or_default();
		*weight = weight.saturating_add(sample.weight_us);
	}
	let mut text = String::new();
	for (stack, weight) in weights {
		let _ = writeln!(text, "{stack} {weight}");
	}
	ProfilePayload {
		path:   "work.folded".to_owned(),
		format: "folded-stacks-microseconds".to_owned(),
		bytes:  text.into_bytes(),
	}
}

/// Builds a bounded top-functions table from native work samples.
pub fn top_functions(samples: &[WorkSample], limit: usize) -> Vec<FunctionSummary> {
	let total = samples
		.iter()
		.fold(0_u64, |sum, sample| sum.saturating_add(sample.weight_us));
	let mut functions = BTreeMap::<&str, u64>::new();
	for sample in samples {
		let leaf = sample
			.stack
			.rsplit(';')
			.next()
			.unwrap_or(sample.stack.as_str());
		let weight = functions.entry(leaf).or_default();
		*weight = weight.saturating_add(sample.weight_us);
	}
	let mut rows = functions
		.into_iter()
		.map(|(function, self_us)| FunctionSummary {
			function: function.to_owned(),
			self_us,
			percent_milli: if total == 0 {
				0
			} else {
				self_us.saturating_mul(100_000) / total
			},
		})
		.collect::<Vec<_>>();
	rows.sort_unstable_by(|left, right| {
		right
			.self_us
			.cmp(&left.self_us)
			.then_with(|| left.function.cmp(&right.function))
	});
	rows.truncate(limit.min(100));
	rows
}

/// Renders an honest native-sample SVG bar flamegraph without browser profiler
/// formats.
pub fn flamegraph_svg(samples: &[WorkSample]) -> ProfilePayload {
	let rows = top_functions(samples, 60);
	let width = 1200_u64;
	let row_height = 22_u64;
	let height = (rows.len() as u64)
		.saturating_mul(row_height)
		.saturating_add(40);
	let max = rows.first().map_or(1, |row| row.self_us.max(1));
	let mut svg = String::new();
	let _ = write!(
		svg,
		"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\" \
		 viewBox=\"0 0 {width} {height}\"><style>text{{font:12px \
		 monospace;fill:#111}}.bar{{fill:#4b8bd8}}</style><rect width=\"100%\" height=\"100%\" \
		 fill=\"#fff\"/><text x=\"8\" y=\"18\">OMP native work profile (sampled self time)</text>"
	);
	for (index, row) in rows.iter().enumerate() {
		let y = 30 + index as u64 * row_height;
		let bar = row.self_us.saturating_mul(width.saturating_sub(330)) / max;
		let label = xml_escape(&row.function);
		let _ = write!(
			svg,
			"<rect class=\"bar\" x=\"300\" y=\"{y}\" width=\"{bar}\" height=\"18\"/><text x=\"8\" \
			 y=\"{}\">{label}</text><text x=\"305\" y=\"{}\">{} µs</text>",
			y + 14,
			y + 14,
			row.self_us
		);
	}
	svg.push_str("</svg>");
	ProfilePayload {
		path:   "work-flamegraph.svg".to_owned(),
		format: "svg-native-sampled-self-time".to_owned(),
		bytes:  svg.into_bytes(),
	}
}

/// Creates a redacted raw-stream attachment with an explicit private format
/// label.
pub fn raw_stream_dump(text: &str) -> ProfilePayload {
	ProfilePayload {
		path:   "raw-stream.txt".to_owned(),
		format: "omp-redacted-provider-stream-v1".to_owned(),
		bytes:  omp_observability::redact::redact_sensitive_credentials(text).into_bytes(),
	}
}

fn xml_escape(text: &str) -> String {
	text
		.replace('&', "&amp;")
		.replace('<', "&lt;")
		.replace('>', "&gt;")
		.replace('"', "&quot;")
}
