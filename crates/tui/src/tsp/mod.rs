//! Tern Surface Protocol (TSP) v1: the in-band protocol through which a
//! program in a Tern pane sends semantic node trees that Tern lays out and
//! draws natively (ADR 0041).
//!
//! This module owns the wire: typed messages ([`wire`]), framing and
//! chunking ([`frame`]), a reference document applier used as the test
//! oracle ([`doc`]), the JSONL recorder ([`record`]) and the `edit` event's
//! UTF-16 offsets resolved for an editor ([`edit`]). Detection rides the
//! startup probe: the `hello` query goes out just before the DA1 fence, and
//! a reply that arrives before DA1 means the terminal speaks TSP
//! ([`crate::ProbeResults::tsp`]). Live replies and events reach the host
//! through [`crate::Terminal::take_tsp`].
//!
//! `OMP_TSP=0` turns TSP off: no probe, no surface, cell rendering only.

pub mod doc;
pub mod edit;
pub mod frame;
pub mod record;
pub mod wire;

use std::iter;

use bytes::BytesMut;
use omp_core::Str;

/// Protocol version this build speaks.
pub const VERSION: u32 = 1;
/// Largest body per message before chunking, unless `hello` says otherwise.
pub const DEFAULT_APC_LIMIT: usize = 65_536;
/// Frames the program may have unacknowledged, unless `hello` says otherwise.
pub const DEFAULT_CREDITS: u32 = 2;
/// Largest joined body of a chunked message.
pub const MAX_JOINED_BYTES: usize = 24 * 1024 * 1024;
/// Environment variable that turns TSP off when set to `0`.
pub const ENV: &str = "OMP_TSP";
/// Program features omp announces in `hello`.
///
/// It applies `edit` events, so Tern may keep a native selection in the
/// composer, `undo` events, so Tern may turn ⌃Z in it into one, and `send`
/// events, so Tern may submit a prompt through a composer whose `sendable`
/// prop is true.
pub const PROGRAM_FEATURES: &[&str] = &["edit", "undo", "send"];

/// Whether the environment allows TSP: anything but `OMP_TSP=0`.
#[must_use]
pub fn allowed(var: impl Fn(&str) -> Option<String>) -> bool {
	var(ENV).is_none_or(|value| value.trim() != "0")
}

/// Whether the startup probe should ask for TSP: allowed by the environment
/// and not inside a multiplexer, which swallows APC strings.
#[must_use]
pub fn probe_wanted(inside_multiplexer: bool, var: impl Fn(&str) -> Option<String>) -> bool {
	!inside_multiplexer && allowed(var)
}

/// The complete `hello` query string, sent just before the DA1 request.
#[must_use]
pub fn hello_query() -> BytesMut {
	let query = wire::Query::Hello {
		v:        iter::once(VERSION).collect(),
		app:      Str::new_static("omp"),
		ver:      Some(Str::new_static(env!("CARGO_PKG_VERSION"))),
		features: PROGRAM_FEATURES
			.iter()
			.map(|feature| Str::new_static(feature))
			.collect(),
	};
	let mut out = BytesMut::new();
	frame::Encoder::default()
		.json(wire::Verb::Query, &query, &mut out)
		.expect("a hello query serializes");
	out
}

#[cfg(test)]
mod tests {
	use super::{allowed, frame, hello_query, probe_wanted, wire};

	#[test]
	fn the_hello_query_is_one_apc_string_asking_for_v1() {
		let query = hello_query();
		assert!(query.starts_with(b"\x1b_tsp;q;{\"q\":\"hello\",\"v\":[1],\"app\":\"omp\""));
		assert!(query.ends_with(b"\x1b\\"));
		let payload = &query[2..query.len() - 2];
		let raw = frame::split(payload).expect("tsp");
		let decoded: wire::Query = serde_json::from_slice(raw.body).expect("query");
		let wire::Query::Hello { v, features, .. } = decoded else {
			panic!("a hello query");
		};
		assert_eq!(v.as_slice(), [1]);
		assert_eq!(
			features
				.iter()
				.map(|feature| feature.as_str())
				.collect::<Vec<_>>(),
			["edit", "undo", "send"],
			"omp applies native edits, undo and sends"
		);
	}

	#[test]
	fn only_omp_tsp_0_turns_it_off_and_multiplexers_are_never_probed() {
		assert!(allowed(|_| None));
		assert!(allowed(|_| Some("1".into())));
		assert!(!allowed(|_| Some("0".into())));
		assert!(!probe_wanted(true, |_| None));
		assert!(probe_wanted(false, |_| None));
	}

	#[test]
	fn the_hello_reply_decodes_with_defaults_and_vocabulary_checks() {
		let reply: wire::Reply = serde_json::from_str(
			r#"{"r":"hello","v":1,"term":"tern","ver":"0.4.3","kinds":["col","md","tool","future"],
			"features":["blobs","flow"],"cols":120,"cell":{"w":8,"h":17},"dark":true,"reduceMotion":false}"#,
		)
		.expect("hello");
		let wire::Reply::Hello(hello) = reply else {
			panic!("a hello reply")
		};
		assert!(hello.draws(wire::Kind::Tool));
		assert!(!hello.draws(wire::Kind::Picker));
		assert!(hello.has_feature("flow"));
		assert_eq!(hello.apc_limit(), super::DEFAULT_APC_LIMIT);
		assert_eq!(hello.credit_limit(), super::DEFAULT_CREDITS);
		assert_eq!(hello.reduce_motion, Some(false));
	}
}
