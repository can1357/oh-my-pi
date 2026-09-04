//! Behavioral coverage for the growing-document cursor.

use std::{pin, task};

use futures::{FutureExt, executor::block_on};
use omp_core::{
	sf,
	slopjson::{
		IncomingDoc, IncomingError, PullIssueKind, PullMode, PullPathSegment, PulledKind, RepairKind,
		Str, Value, json, parse,
	},
};
use smallvec::SmallVec;

#[test]
fn key_string_is_available_before_object_finishes() {
	let (mut feed, mut args) = IncomingDoc::channel();
	feed.push(r#"{"meta":{"name":"hel"#).unwrap();

	let mut args_object = args.json().object();
	let mut meta_object = args_object.key("meta").object();
	let mut name = meta_object.key("name").string();
	assert_eq!(block_on(name.next_chunk()).unwrap().as_deref(), Some("hel"));
	assert!(name.next_chunk().now_or_never().is_none());

	feed.push(r#"lo"},"later":[1,2]}"#).unwrap();
	assert_eq!(block_on(name.next_chunk()).unwrap().as_deref(), Some("lo"));
	assert_eq!(block_on(name.next_chunk()).unwrap(), None);
	feed.finish();
}

#[test]
fn split_escapes_emit_only_stable_decoded_chunks() {
	let (mut feed, mut args) = IncomingDoc::channel();
	feed.push("{text:\"a\\").unwrap();
	let mut object = args.json().object();
	let mut text = object.key("text").string();
	assert_eq!(block_on(text.next_chunk()).unwrap().as_deref(), Some("a"));

	feed.push("n\\uD83").unwrap();
	assert_eq!(block_on(text.next_chunk()).unwrap().as_deref(), Some("\n"));
	assert!(text.next_chunk().now_or_never().is_none());
	feed.push("D\\uDE00z\"}").unwrap();
	assert_eq!(block_on(text.next_chunk()).unwrap().as_deref(), Some("😀z"));
	assert_eq!(block_on(text.next_chunk()).unwrap(), None);
	feed.finish();
}

#[test]
fn nested_array_elements_arrive_as_they_begin_and_collect() {
	let (mut feed, mut args) = IncomingDoc::channel();
	feed.push("{items:[{x:1},[").unwrap();
	let mut object = args.json().object();
	let mut items = object.key("items").array();

	let mut first = block_on(items.next()).unwrap().unwrap();
	assert_eq!(block_on(first.value()).unwrap(), json!({"x": 1}));
	let mut second = block_on(items.next()).unwrap().unwrap();
	assert!(second.value().now_or_never().is_none());

	feed.push("True,None]]}").unwrap();
	assert_eq!(block_on(second.value()).unwrap(), json!([true, null]));
	assert!(block_on(items.next()).unwrap().is_none());
	feed.finish();
}

#[test]
fn whole_array_and_scalar_awaiters_use_tolerant_parser() {
	let (mut feed, mut args) = IncomingDoc::channel();
	feed
		.push("{n:12.5, yes:True, nil:None, values:[1,'two',False]}")
		.unwrap();
	feed.finish();

	assert_eq!(
		block_on(args.json().object().key("n").number())
			.unwrap()
			.as_f64(),
		12.5
	);
	assert!(block_on(args.json().object().key("yes").boolean()).unwrap());
	block_on(args.json().object().key("nil").null()).unwrap();
	assert_eq!(block_on(args.json().object().key("values").array().collect()).unwrap(), vec![
		json!(1),
		json!("two"),
		json!(false)
	]);
}

#[test]
fn comments_and_radix_literals_match_the_final_parser() {
	let text = "{\"a\"/*c*/: 0x1F, // note\n 'b': 0b101}";
	let (mut feed, mut args) = IncomingDoc::channel();
	feed.push(text).unwrap();
	feed.finish();

	assert_eq!(block_on(args.json().value()).unwrap(), parse(text).unwrap());
	assert_eq!(
		block_on(args.json().object().key("a").number())
			.unwrap()
			.as_f64(),
		31.0
	);
	assert_eq!(
		block_on(args.json().object().key("b").number())
			.unwrap()
			.as_f64(),
		5.0
	);
}

#[test]
fn edge_quote_does_not_commit_string_end_while_feed_is_open() {
	let (mut feed, mut args) = IncomingDoc::channel();
	feed.push("{text:'a'").unwrap();

	// The closing quote sits at the buffer edge: more text may still reopen
	// it via inner-quote recovery, so the string must not end yet.
	let mut object = args.json().object();
	let mut text = object.key("text").string();
	assert_eq!(block_on(text.next_chunk()).unwrap().as_deref(), Some("a"));
	assert!(text.next_chunk().now_or_never().is_none());

	feed.push("b'}").unwrap();
	assert_eq!(block_on(text.next_chunk()).unwrap().as_deref(), Some("'b"));
	assert_eq!(block_on(text.next_chunk()).unwrap(), None);
	feed.finish();
	assert_eq!(block_on(args.json().value()).unwrap(), parse("{text:'a'b'}").unwrap());
}

#[test]
fn lone_slash_at_edge_defers_chunks_until_comment_or_content_resolves() {
	// Double quotes close strictly (the '/' is an undecided follower);
	// single quotes defer via the lookahead's Undecided state. Either way
	// no chunk beyond "a" may be emitted until the '/' resolves.
	for (head, tail, full) in
		[("{text:\"a\"/", "*c*/}", "{text:\"a\"/*c*/}"), ("{text:'a'/", "*c*/}", "{text:'a'/*c*/}")]
	{
		let (mut feed, mut args) = IncomingDoc::channel();
		feed.push(head).unwrap();

		let mut object = args.json().object();
		let mut text = object.key("text").string();
		assert_eq!(block_on(text.next_chunk()).unwrap().as_deref(), Some("a"), "for {full}");
		assert!(text.next_chunk().now_or_never().is_none(), "for {full}");

		feed.push(tail).unwrap();
		assert_eq!(block_on(text.next_chunk()).unwrap(), None, "for {full}");
		feed.finish();
		assert_eq!(block_on(args.json().value()).unwrap(), parse(full).unwrap(), "for {full}");
	}
}

#[test]
fn unterminated_comment_after_edge_close_only_appends_to_chunks() {
	// `/*…` without `*/` closes the quote at the edge; a later flip to
	// inner-quote recovery may only extend the value, so already-emitted
	// chunks stay prefixes of the final string. Single quotes recover
	// identically in the final parser, so the completed pull stays valid
	// (the double-quoted variant is rejected by both as Malformed).
	let (mut feed, mut args) = IncomingDoc::channel();
	feed.push("{text:'a'/*c").unwrap();

	let mut object = args.json().object();
	let mut text = object.key("text").string();
	assert_eq!(block_on(text.next_chunk()).unwrap().as_deref(), Some("a"));
	assert!(text.next_chunk().now_or_never().is_none());

	feed.push("*/x'}").unwrap();
	assert_eq!(block_on(text.next_chunk()).unwrap().as_deref(), Some("'/*c*/x"));
	assert_eq!(block_on(text.next_chunk()).unwrap(), None);
	feed.finish();
	assert_eq!(block_on(args.json().value()).unwrap(), parse("{text:'a'/*c*/x'}").unwrap());
}

/// Poll `future` once with a no-op waker.
fn poll_once<T>(future: pin::Pin<&mut impl Future<Output = T>>) -> task::Poll<T> {
	future.poll(&mut task::Context::from_waker(task::Waker::noop()))
}

#[test]
fn finish_alone_completes_an_edge_closed_string_pending_mid_poll() {
	let (mut feed, mut args) = IncomingDoc::channel();
	feed.push("{text:'a'").unwrap();

	let mut object = args.json().object();
	let mut text = object.key("text").string();
	assert_eq!(block_on(text.next_chunk()).unwrap().as_deref(), Some("a"));

	// Hold a pending pull across finish(): the wake carries no new text, only
	// the Open→Finished transition, which must re-evaluate the edge-closed
	// quote as final instead of reporting Incomplete.
	let mut pending = pin::pin!(text.next_chunk());
	assert!(poll_once(pending.as_mut()).is_pending());
	feed.finish();
	let task::Poll::Ready(result) = poll_once(pending.as_mut()) else {
		panic!("finish must settle the pending chunk pull")
	};
	assert_eq!(result.unwrap(), None);
}

#[test]
fn finish_alone_still_reports_truly_unterminated_string_incomplete() {
	let (mut feed, mut args) = IncomingDoc::channel();
	feed.push("{text:'a").unwrap();

	let mut object = args.json().object();
	let mut text = object.key("text").string();
	assert_eq!(block_on(text.next_chunk()).unwrap().as_deref(), Some("a"));

	let mut pending = pin::pin!(text.next_chunk());
	assert!(poll_once(pending.as_mut()).is_pending());
	feed.finish();
	let task::Poll::Ready(result) = poll_once(pending.as_mut()) else {
		panic!("finish must settle the pending chunk pull")
	};
	let IncomingError::Pull(issue) = result.unwrap_err() else {
		panic!("expected structured pull issue")
	};
	assert_eq!(issue.kind, PullIssueKind::Incomplete);
}

#[test]
fn pending_chunk_poll_becomes_ready_from_a_single_push() {
	let (mut feed, mut args) = IncomingDoc::channel();
	feed.push("{text:'hel").unwrap();

	let mut object = args.json().object();
	let mut text = object.key("text").string();
	assert_eq!(block_on(text.next_chunk()).unwrap().as_deref(), Some("hel"));

	// Waker registration and chunk readiness are decided under one lock, so
	// one push must make the held pull ready on its next evaluation.
	let mut pending = pin::pin!(text.next_chunk());
	assert!(poll_once(pending.as_mut()).is_pending());
	feed.push("lo").unwrap();
	let task::Poll::Ready(result) = poll_once(pending.as_mut()) else {
		panic!("push must make the chunk pull ready")
	};
	assert_eq!(result.unwrap().as_deref(), Some("lo"));
}

#[test]
fn chunk_pull_surfaces_type_mismatch_for_non_string_values() {
	let (mut feed, mut args) = IncomingDoc::channel();
	feed.push("{text: 42}").unwrap();
	feed.finish();

	let mut object = args.json().object();
	let mut text = object.key("text").string();
	let IncomingError::Pull(issue) = block_on(text.next_chunk()).unwrap_err() else {
		panic!("expected structured pull issue")
	};
	assert_eq!(issue.kind, PullIssueKind::TypeMismatch { found: "number" });
}

#[test]
fn pulled_string_does_not_swallow_a_sibling_through_quote_recovery() {
	// The final parser rejects all four documents. Double quotes close
	// strictly in incoming, and a pulled scalar completes only once a value
	// terminator follows, so each rejected pull reports Incomplete instead
	// of silently returning swallowed text (or a mislocated member).
	for (text, key) in [
		(r#"{"a":"x" "b":1}"#, "a"), // dq value would swallow the next key's quote
		("{'a':'x' 'b':1}", "a"),    // sq recovery: completed value is followed by ':'
		(r#"{"a":"x" "y"}"#, "a"),   // dq value–value; follower '}' alone is legal
		(r#"{"a" "b":1}"#, "a"),     // dq key would swallow the next key's quote
	] {
		assert!(parse(text).is_err(), "parse must reject {text}");
		let (mut feed, mut args) = IncomingDoc::channel();
		feed.push(text).unwrap();
		feed.finish();
		let error = block_on(args.json().object().key(key).value()).unwrap_err();
		let IncomingError::Pull(issue) = error else {
			panic!("expected structured pull issue for {text}")
		};
		assert_eq!(issue.kind, PullIssueKind::Incomplete, "for {text}");
	}

	// The recovered key spelling must not match either: the key token itself
	// never swallows.
	let (mut feed, mut args) = IncomingDoc::channel();
	feed.push(r#"{"a" "b":1}"#).unwrap();
	feed.finish();
	let error = block_on(args.json().object().key(r#"a" "b"#).number()).unwrap_err();
	let IncomingError::Pull(issue) = error else {
		panic!("expected structured pull issue")
	};
	assert_eq!(issue.kind, PullIssueKind::Incomplete);

	// Single-quoted value–value recovery is identical in the final parser:
	// both sides accept it, so the pull stays lenient.
	let text = "{'a':'x' 'y'}";
	assert_eq!(parse(text).unwrap(), json!({ "a": "x' 'y" }));
	let (mut feed, mut args) = IncomingDoc::channel();
	feed.push(text).unwrap();
	feed.finish();
	assert_eq!(block_on(args.json().object().key("a").string().finish()).unwrap(), sf!("x' 'y"));
}

#[test]
fn truncated_string_has_distinct_incomplete_end() {
	let (mut feed, mut args) = IncomingDoc::channel();
	feed.push("{message:\"not done").unwrap();
	let mut object = args.json().object();
	let message = object.key("message").string();
	feed.finish();

	let error = block_on(message.finish()).unwrap_err();
	let IncomingError::Pull(issue) = error else {
		panic!("expected structured pull issue")
	};
	assert_eq!(issue.path, vec![PullPathSegment::Key(sf!("message"))]);
	assert_eq!(issue.expected, "string");
	assert_eq!(issue.kind, PullIssueKind::Incomplete);
}

#[test]
fn duplicate_key_cursor_is_first_wins_but_collection_is_last_wins() {
	let (mut feed, mut args) = IncomingDoc::channel();
	feed.push("{dup:1, dup:2}").unwrap();
	feed.finish();

	assert_eq!(block_on(args.json().object().key("dup").value()).unwrap(), json!(1));
	let object = block_on(args.json().object().collect()).unwrap();
	assert_eq!(object.get("dup"), Some(&Value::from(2)));
}

#[test]
fn pulling_defines_required_keys_and_unpulled_members_are_ignored() {
	let (mut feed, mut params) = IncomingDoc::channel();
	feed.push("{path:'ok', unknown:[unfinished").unwrap();
	feed.finish();
	let path = block_on(params.json().object().key("path").string().finish()).unwrap();
	assert_eq!(path, sf!("ok"));
	assert!(matches!(block_on(params.whole::<Value>()), Err(IncomingError::Parse(_))));

	let (mut feed, mut params) = IncomingDoc::channel();
	feed.push("{path:'ok'}").unwrap();
	feed.finish();
	let missing = block_on(params.json().object().key("missing").value()).unwrap_err();
	let IncomingError::Pull(missing) = missing else {
		panic!("expected structured pull issue")
	};
	assert_eq!(missing.path, vec![PullPathSegment::Key(sf!("missing"))]);
	assert_eq!(missing.expected, "value");
	assert_eq!(missing.kind, PullIssueKind::Missing);

	let mistyped = block_on(params.json().object().key("path").number()).unwrap_err();
	let IncomingError::Pull(mistyped) = mistyped else {
		panic!("expected structured pull issue")
	};
	assert_eq!(mistyped.path, vec![PullPathSegment::Key(sf!("path"))]);
	assert_eq!(mistyped.expected, "number");
	assert_eq!(mistyped.kind, PullIssueKind::TypeMismatch { found: "string" });

	let (mut feed, mut params) = IncomingDoc::channel();
	feed.push("{meta:{count:'many'}}").unwrap();
	feed.finish();
	let mistyped = block_on(
		params
			.json()
			.object()
			.key("meta")
			.object()
			.key("count")
			.number(),
	)
	.unwrap_err();
	let IncomingError::Pull(mistyped) = mistyped else {
		panic!("expected structured pull issue")
	};
	assert_eq!(mistyped.path, vec![
		PullPathSegment::Key(sf!("meta")),
		PullPathSegment::Key(sf!("count")),
	]);
	assert_eq!(mistyped.expected, "number");
	assert_eq!(mistyped.kind, PullIssueKind::TypeMismatch { found: "string" });
}

#[test]
fn whole_document_validation_is_an_explicit_pull() {
	#[derive(Debug, PartialEq, serde::Deserialize)]
	struct AllParams {
		path:    String,
		enabled: bool,
	}

	let (mut feed, mut params) = IncomingDoc::channel();
	feed.push("{path: packages/foo/*, enabled: True}").unwrap();
	feed.finish();
	assert_eq!(block_on(params.whole::<AllParams>()).unwrap(), AllParams {
		path:    "packages/foo/*".into(),
		enabled: true,
	});

	let (mut feed, mut params) = IncomingDoc::channel();
	feed.push("{path: packages/foo/*, ignored: 1}").unwrap();
	feed.finish();
	assert_eq!(
		block_on(params.json().object().key("path").value()).unwrap(),
		Value::from("packages/foo/*")
	);
}

#[test]
fn typed_subtree_pull_is_path_scoped() {
	#[derive(Debug, PartialEq, serde::Deserialize)]
	struct Payload {
		count: u64,
	}

	let (mut feed, mut params) = IncomingDoc::channel();
	feed
		.push("{payload:{count:'many'}, ignored:[unfinished")
		.unwrap();
	feed.finish();

	let error = block_on(params.json().object().key("payload").whole::<Payload>()).unwrap_err();
	let IncomingError::Pull(issue) = error else {
		panic!("expected structured pull issue")
	};
	assert_eq!(issue.path, vec![PullPathSegment::Key(sf!("payload"))]);
	assert_eq!(issue.expected, std::any::type_name::<Payload>());
	assert_eq!(issue.kind, PullIssueKind::Malformed);
}

#[test]
fn cancelled_pull_releases_the_linear_cursor() {
	let (mut feed, mut doc) = IncomingDoc::channel();
	feed.push("{a:").unwrap();

	{
		let mut object = doc.json().object();
		let mut a = object.key("a");
		let mut pending = pin::pin!(a.number());
		assert!(poll_once(pending.as_mut()).is_pending());
		// Cancelling a plain pull future releases the exclusive reborrow. It
		// leaves no subscription, snapshot, or field event to drain.
	}

	feed.push("1,b:2}").unwrap();
	feed.finish();
	let mut object = doc.json().object();
	assert_eq!(block_on(object.key("a").number()).unwrap().as_u64(), Some(1));
	assert_eq!(block_on(object.key("b").number()).unwrap().as_u64(), Some(2));
}

#[test]
fn finished_and_aborted_are_distinct_terminal_states() {
	let (feed, doc) = IncomingDoc::channel();
	feed.finish();
	block_on(doc.finished()).unwrap();

	let (feed, doc) = IncomingDoc::channel();
	feed.abort();
	assert!(matches!(block_on(doc.finished()), Err(IncomingError::Aborted)));

	let (feed, mut doc) = IncomingDoc::channel();
	let mut object = doc.json().object();
	let mut pending = object.key("missing");
	drop(feed);
	let error = block_on(pending.value()).unwrap_err();
	let IncomingError::Pull(issue) = error else {
		panic!("expected structured pull issue")
	};
	assert_eq!(issue.path, vec![PullPathSegment::Key(sf!("missing"))]);
	assert_eq!(issue.expected, "value");
	assert_eq!(issue.kind, PullIssueKind::Aborted);
	assert!(matches!(block_on(doc.whole::<Value>()), Err(IncomingError::Aborted)));
}

#[test]
fn path_cursor_rounds_lines_and_reports_the_alias_that_matched() {
	let (mut feed, doc) = IncomingDoc::channel();
	let cursor = doc.cursor();
	let mut names = SmallVec::<Str, 4>::new();
	names.push(sf!("message"));
	names.push(sf!("text"));
	let path = [PullPathSegment::Keys(names)];

	feed.push("{\"text\":\"a\\nb").unwrap();
	let first = block_on(cursor.pull_at(&path, PullMode::Line(0), "string")).unwrap();
	assert_eq!(first.matched_key.as_deref(), Some("text"));
	assert!(matches!(
		first.kind,
		PulledKind::Chunk { ref value, complete: false } if value.as_str() == "a\n"
	));

	feed.push("\\n").unwrap();
	let second = block_on(cursor.pull_at(&path, PullMode::Line(2), "string")).unwrap();
	assert!(matches!(
		second.kind,
		PulledKind::Chunk { ref value, complete: false } if value.as_str() == "b\n"
	));

	feed.push("c\"}").unwrap();
	let final_line = block_on(cursor.pull_at(&path, PullMode::Line(4), "string")).unwrap();
	assert!(matches!(
		final_line.kind,
		PulledKind::Chunk { ref value, complete: true } if value.as_str() == "c"
	));
	feed.finish();
}

#[test]
fn finished_object_key_scan_preserves_alias_collisions_and_duplicates() {
	let (mut feed, doc) = IncomingDoc::channel();
	let cursor = doc.cursor();
	feed.push("{\"path\":1,\"file\":2,\"path\":3}").unwrap();
	feed.finish();

	let mut names = SmallVec::<Str, 4>::new();
	names.push(sf!("path"));
	names.push(sf!("file"));
	let pulled =
		block_on(cursor.pull_at(&[PullPathSegment::Keys(names)], PullMode::Complete, "number"))
			.unwrap();
	assert_eq!(pulled.matched_key.as_deref(), Some("path"));
	assert!(matches!(
		pulled.kind,
		PulledKind::Complete(Value::Number(number)) if number.as_u64() == Some(1)
	));

	let keys = block_on(cursor.object_keys(&[])).unwrap();
	assert_eq!(keys.as_slice(), [sf!("path"), sf!("file"), sf!("path")]);
}

#[test]
fn parser_repairs_are_lossless_and_strict_json_stays_empty() {
	let input = "{,// note\nunquoted:'x\\q\u{1}', flag: True, hex: 0x10, relaxed: +.5, bare: foo,,}";
	let (mut feed, mut doc) = IncomingDoc::channel();
	feed.push(input).unwrap();
	feed.finish();
	block_on(doc.whole::<Value>()).unwrap();

	let repairs = doc.repairs();
	for kind in [
		RepairKind::Comment,
		RepairKind::SingleQuotedString,
		RepairKind::UnquotedKey,
		RepairKind::PythonLiteral,
		RepairKind::StrayComma,
		RepairKind::TrailingComma,
		RepairKind::InvalidEscape,
		RepairKind::RawControlCharacter,
		RepairKind::RadixNumber,
		RepairKind::RelaxedNumber,
		RepairKind::BarewordValue,
	] {
		assert!(repairs.iter().any(|repair| repair.kind == kind), "missing {kind:?}");
	}
	for repair in repairs.iter() {
		assert_eq!(repair.before.as_str(), &input[repair.span.clone()]);
	}
	assert!(repairs.iter().any(|repair| {
		repair.kind == RepairKind::SingleQuotedString
			&& repair.path.as_slice() == [omp_core::slopjson::RepairPathSegment::Key(sf!("unquoted"))]
	}));
	drop(repairs);

	let strict = "{\"ok\":true,\"items\":[1,2]}";
	let (mut feed, mut doc) = IncomingDoc::channel();
	feed.push(strict).unwrap();
	feed.finish();
	block_on(doc.whole::<Value>()).unwrap();
	assert!(doc.repairs().is_empty());
}
