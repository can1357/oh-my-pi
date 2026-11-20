mod common;

use common::{DiskWriter, Workspace};
use omp_edit::EditMode;

async fn apply(before: &str, body: &str, expected: Result<&str, &str>) {
	let workspace = Workspace::new(EditMode::Sloppy);
	workspace.write("a.txt", before);
	let writer = DiskWriter::default();
	let result = workspace
		.apply_raw(&format!("*** Edit File: a.txt\n{body}"), &writer)
		.await;
	let after = match expected {
		Ok(after) => {
			result.expect("edit must apply");
			after
		},
		Err(reason) => {
			let error = result.expect_err("edit must fail closed");
			assert!(error.to_string().contains(reason), "{error}");
			assert!(writer.requests.lock().is_empty());
			before
		},
	};
	assert_eq!(workspace.read("a.txt").unwrap(), after);
}

#[tokio::test]
async fn short_ranges_require_a_whole_closing_line_at_the_authored_depth() {
	let body = "*** Find\nif (ready) {\n…\n}\n*** Replace\nchanged\n";
	for before in [
		"if (ready) {\n  work();\n} else {\n",
		"if (ready) {\n  nested {\n  }\n",
		"if (ready) {\n…\n} else {\n",
	] {
		apply(before, body, Err("did not match")).await;
	}
	apply(
		"head\n  label café😀\n    body\n  stop\ntail\n",
		"*** Find\nlabel café😀\n…\nstop\n*** Replace\ndone\n",
		Ok("head\n  done\ntail\n"),
	)
	.await;
}

#[tokio::test]
async fn duplicate_deletion_compares_the_bytes_left_after_line_cleanup() {
	let body = "*** Find\nblock {\n…\n}\n*** Replace\n";
	apply("block {\n  a\n}\nblock {\n  a\n}\n", body, Ok("block {\n  a\n}\n")).await;
	apply("block {\n  a\n}\nblock {\n a\n}\n", body, Err("ambiguous")).await;
	apply("head\n\nblock {\n a\n}\n\nblock {\n a\n}\ntail\n", body, Err("ambiguous")).await;
}

#[tokio::test]
async fn only_a_bare_find_all_identifier_requires_word_boundaries() {
	apply("_id idx $id\n", "*** Find all\nid\n*** Replace\nkey\n", Err("found 0 matches")).await;
	apply("_id idx $id id\n", "*** Find all\nid\n*** Replace\nkey\n", Ok("_id idx $id key\n")).await;
	apply("idx\n", "*** Find\nid\n*** Replace\nkey\n", Ok("keyx\n")).await;
	apply("xa.b a.bc\n", "*** Find all\na.b\n*** Replace\ny\n", Ok("xy yc\n")).await;
}

#[tokio::test]
async fn pasting_on_a_cut_line_or_an_overlapping_anchor_leaves_the_file_alone() {
	// If the cut is allowed to consume the blank line and the paste is
	// framed against its own closing brace, the blank line is lost.
	apply(
		"} // done\n\nthree\n",
		"*** Find\n} // done\n*** Cut\n*** Find\n} // done\n*** Paste Before\n",
		Err("lies inside the block"),
	)
	.await;
	for (anchor, placement) in [("one", "Before"), ("one\ntwo\nthree", "After")] {
		let body =
			format!("*** Find\none\ntwo\n*** Cut\n*** Find\n{anchor}\n*** Paste {placement}\n");
		apply("one\ntwo\n\nthree\n", &body, Err("lies inside the block")).await;
	}
	apply(
		"one\ntwo\nthree\n",
		"*** Find\none\ntwo\n*** Cut\n*** Find\nthree\n*** Paste After\n",
		Ok("three\none\ntwo\n"),
	)
	.await;
}
