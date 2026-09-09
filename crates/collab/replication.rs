//! Deterministic replication payload reduction before encryption.

use std::borrow::Cow;

use serde_json::Value;
use thiserror::Error;

/// Hard pre-encryption ceiling for one replicated payload.
pub const MAX_REPLICATED_PAYLOAD_BYTES: usize = 1024 * 1024;
/// Number of progressively tighter reduction passes.
pub const SHRINK_PASS_COUNT: usize = 7;

const SHRINK_PASSES: [(usize, usize); SHRINK_PASS_COUNT] =
	[(64 * 1024, 256), (16 * 1024, 128), (4 * 1024, 64), (1024, 32), (256, 16), (256, 4), (64, 1)];
const STRING_ELISION_RESERVE: usize = 80;

/// A bounded payload and the number of reduction passes applied.
#[derive(Debug)]
pub struct ReplicationPayload<'a> {
	value:  Cow<'a, Value>,
	passes: u8,
}

impl ReplicationPayload<'_> {
	/// Returns the original borrowed value or its reduced owned shadow.
	pub fn value(&self) -> &Value {
		&self.value
	}

	/// Returns zero for an unchanged payload, otherwise the successful pass
	/// count.
	pub const fn passes(&self) -> u8 {
		self.passes
	}

	/// Serializes the already-bounded payload for encryption.
	pub fn encode(&self) -> Result<Vec<u8>, ReplicationError> {
		serde_json::to_vec(self.value()).map_err(ReplicationError::Serialize)
	}
}

/// Failure to produce a payload below the mandatory relay ceiling.
#[derive(Debug, Error)]
pub enum ReplicationError {
	/// JSON serialization failed.
	#[error("replication payload serialization failed")]
	Serialize(#[source] serde_json::Error),
	/// Even the final deterministic pass could not reduce non-reducible
	/// structure.
	#[error(
		"replication payload remains {actual} bytes after seven reduction passes; limit is {limit}"
	)]
	Irreducible {
		/// Final encoded size.
		actual: usize,
		/// Hard accepted ceiling.
		limit:  usize,
	},
}

/// Returns a deterministic payload no larger than one MiB.
///
/// Small values remain borrowed. Reduction clones only an ancestor branch that
/// contains a truncated string, clipped array, or another changed descendant.
pub fn shrink_for_replication(value: &Value) -> Result<ReplicationPayload<'_>, ReplicationError> {
	let initial = serde_json::to_vec(value).map_err(ReplicationError::Serialize)?;
	if initial.len() <= MAX_REPLICATED_PAYLOAD_BYTES {
		return Ok(ReplicationPayload { value: Cow::Borrowed(value), passes: 0 });
	}

	let mut final_size = initial.len();
	for (index, &(string_cap, array_limit)) in SHRINK_PASSES.iter().enumerate() {
		let Some(reduced) = shrink_value(value, string_cap, array_limit) else {
			continue;
		};
		let bytes = serde_json::to_vec(&reduced).map_err(ReplicationError::Serialize)?;
		final_size = bytes.len();
		if final_size <= MAX_REPLICATED_PAYLOAD_BYTES {
			return Ok(ReplicationPayload {
				value:  Cow::Owned(reduced),
				passes: u8::try_from(index + 1).expect("seven passes fit in u8"),
			});
		}
	}
	Err(ReplicationError::Irreducible { actual: final_size, limit: MAX_REPLICATED_PAYLOAD_BYTES })
}

fn shrink_value(value: &Value, string_cap: usize, array_limit: usize) -> Option<Value> {
	match value {
		Value::String(text) if text.len() > string_cap => {
			let requested = string_cap.saturating_sub(STRING_ELISION_RESERVE);
			let head_len = floor_char_boundary(text, requested);
			let elided = text.len() - head_len;
			Some(Value::String(format!(
				"{}\n…[{elided} chars elided for collab session]",
				&text[..head_len]
			)))
		},
		Value::Array(items) => {
			let keep = items.len().min(array_limit);
			let clipped = keep < items.len();
			let mut changed = clipped;
			let mut output = Vec::with_capacity(keep + usize::from(clipped));
			for item in &items[..keep] {
				if let Some(reduced) = shrink_value(item, string_cap, array_limit) {
					changed = true;
					output.push(reduced);
				} else {
					output.push(item.clone());
				}
			}
			if clipped {
				let elided = items.len() - keep;
				output.push(Value::String(format!("…[{elided} items elided for collab session]")));
			}
			changed.then_some(Value::Array(output))
		},
		Value::Object(fields) => {
			let mut output: Option<serde_json::Map<String, Value>> = None;
			for (index, (key, child)) in fields.iter().enumerate() {
				let Some(reduced) = shrink_value(child, string_cap, array_limit) else {
					if let Some(output) = output.as_mut() {
						output.insert(key.clone(), child.clone());
					}
					continue;
				};
				let map = output.get_or_insert_with(|| {
					let mut prefix = serde_json::Map::with_capacity(fields.len());
					for (prefix_key, prefix_value) in fields.iter().take(index) {
						prefix.insert(prefix_key.clone(), prefix_value.clone());
					}
					prefix
				});
				map.insert(key.clone(), reduced);
			}
			output.map(Value::Object)
		},
		_ => None,
	}
}

fn floor_char_boundary(text: &str, requested: usize) -> usize {
	let mut boundary = requested.min(text.len());
	while !text.is_char_boundary(boundary) {
		boundary -= 1;
	}
	boundary
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::*;

	#[test]
	fn small_payload_is_borrowed() {
		let value = json!({"kind": "event", "text": "small"});
		let shrunk = shrink_for_replication(&value).unwrap();
		assert_eq!(shrunk.passes(), 0);
		assert!(matches!(shrunk.value, Cow::Borrowed(_)));
	}

	#[test]
	fn seven_pass_schedule_is_deterministic_and_bounded() {
		let block = "x".repeat(80_000);
		let values = (0..300)
			.map(|index| json!({"index": index, "text": block}))
			.collect();
		let value = Value::Array(values);
		let first = shrink_for_replication(&value).unwrap();
		let second = shrink_for_replication(&value).unwrap();
		assert!((1..=SHRINK_PASS_COUNT as u8).contains(&first.passes()));
		assert_eq!(first.passes(), second.passes());
		assert_eq!(first.value(), second.value());
		assert!(first.encode().unwrap().len() <= MAX_REPLICATED_PAYLOAD_BYTES);
	}

	#[test]
	fn array_elision_trailer_is_reserved() {
		let value = Value::Array((0..300_000).map(Value::from).collect());
		let shrunk = shrink_for_replication(&value).unwrap();
		let array = shrunk.value().as_array().unwrap();
		assert!(
			array
				.last()
				.unwrap()
				.as_str()
				.unwrap()
				.contains("items elided for collab session")
		);
	}
	#[test]
	fn irreducible_oversize_is_typed_not_panicked() {
		let mut object = serde_json::Map::new();
		for index in 0..20 {
			object.insert(format!("{index}-{}", "k".repeat(60_000)), Value::from(index));
		}
		assert!(matches!(
			shrink_for_replication(&Value::Object(object)),
			Err(ReplicationError::Irreducible { .. })
		));
	}
}
