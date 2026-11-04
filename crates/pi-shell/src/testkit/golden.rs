//! The golden event checker: JSON-lines event streams compared after
//! normalizing what varies between runs and builds.
//!
//! Normalization: `t_ns` is dropped, every `dur_ns` becomes 0, and unit ids
//! (64-hex content addresses, which change with the IR version) become
//! `U0`, `U1`, … in order of first appearance. Everything else — kinds,
//! order, sequence numbers, nodes, spans, payloads — must match.

use std::collections::HashMap;

use serde_json::Value;

/// Normalize an event stream for golden comparison.
pub fn normalize(events: &[Value]) -> Vec<Value> {
	let mut units = HashMap::new();
	events
		.iter()
		.map(|e| {
			let mut e = e.clone();
			if let Some(o) = e.as_object_mut() {
				o.remove("t_ns");
			}
			walk(&mut e, &mut units);
			e
		})
		.collect()
}

fn walk(v: &mut Value, units: &mut HashMap<String, usize>) {
	match v {
		Value::Object(o) => {
			for (k, child) in o.iter_mut() {
				match (k.as_str(), &*child) {
					("unit", Value::String(id)) if id.len() == 64 => {
						let n = units.len();
						let n = *units.entry(id.clone()).or_insert(n);
						*child = Value::String(format!("U{n}"));
					},
					("dur_ns", _) => *child = Value::from(0),
					_ => walk(child, units),
				}
			}
		},
		Value::Array(items) => items.iter_mut().for_each(|c| walk(c, units)),
		_ => {},
	}
}

/// Parse a JSON-lines document (blank lines ignored).
pub fn parse_jsonl(text: &str) -> Result<Vec<Value>, serde_json::Error> {
	text
		.lines()
		.filter(|l| !l.trim().is_empty())
		.map(serde_json::from_str)
		.collect()
}

/// The node events naming a unit not announced before them, and the number
/// of node events checked.
///
/// A `Restored` event starts over: the host of a restored shell may be a
/// new process that saw nothing before it. Hosts rely on every node
/// event naming an announced unit.
pub fn unannounced(events: &[Value]) -> (Vec<&Value>, usize) {
	let mut announced = std::collections::HashSet::new();
	let mut missing = Vec::new();
	let mut nodes = 0;
	for e in events {
		match e["kind"].as_str() {
			Some("Restored") => announced.clear(),
			Some("UnitCompiled") => {
				announced.insert(e["data"]["unit"].to_string());
			},
			_ => {},
		}
		if let Value::Object(node) = &e["node"] {
			nodes += 1;
			if !announced.contains(&node["unit"].to_string()) {
				missing.push(e);
			}
		}
	}
	(missing, nodes)
}

/// Compare a normalized stream with a golden one; the first difference, if any.
pub fn diff(actual: &[Value], golden: &[Value]) -> Option<String> {
	for (i, (a, g)) in actual.iter().zip(golden).enumerate() {
		if a != g {
			return Some(format!("event {i} differs:\n  actual: {a}\n  golden: {g}"));
		}
	}
	match actual.len().cmp(&golden.len()) {
		std::cmp::Ordering::Equal => None,
		std::cmp::Ordering::Greater => {
			Some(format!("extra events from {}: {}", golden.len(), actual[golden.len()]))
		},
		std::cmp::Ordering::Less => {
			Some(format!("missing events from {}: {}", actual.len(), golden[actual.len()]))
		},
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::*;

	#[test]
	fn unit_ids_number_by_first_appearance_and_timing_vanishes() {
		let a = "a".repeat(64);
		let b = "b".repeat(64);
		let ev = vec![
			json!({"seq": 0, "t_ns": 5, "node": {"unit": b, "node": 1}}),
			json!({"seq": 1, "t_ns": 9, "data": {"unit": a, "dur_ns": 77}}),
			json!({"seq": 2, "span": {"unit": b}}),
		];
		let n = normalize(&ev);
		assert_eq!(n[0], json!({"seq": 0, "node": {"unit": "U0", "node": 1}}));
		assert_eq!(n[1], json!({"seq": 1, "data": {"unit": "U1", "dur_ns": 0}}));
		assert_eq!(n[2], json!({"seq": 2, "span": {"unit": "U0"}}));
	}

	#[test]
	fn diff_reports_first_mismatch_and_length_changes() {
		let g = vec![json!({"kind": "RunStart"}), json!({"kind": "RunEnd"})];
		assert_eq!(diff(&g, &g), None);
		assert!(
			diff(&g[..1], &g)
				.unwrap()
				.starts_with("missing events from 1")
		);
		assert!(
			diff(&[json!({"kind": "X"})], &g[..1])
				.unwrap()
				.starts_with("event 0 differs")
		);
	}
}
