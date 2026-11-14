use std::sync::Arc;

use serde_json::Value;

use super::{Options, StoredVisualization, model::View};
use crate::{
	Shell, ShellRunOptions,
	bash::{
		EventSink, Script,
		syntax::tree::{CommandKind, List},
		trace::{RunTrace, history::HistoryData, syntax::Root},
	},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

async fn run(shell: &Shell, script: &str) -> Arc<RunTrace> {
	let trace = Arc::new(RunTrace::new(script));
	let result = shell
		.run(
			ShellRunOptions {
				command: script.into(),
				trace: Some(Arc::clone(&trace)),
				..ShellRunOptions::default()
			},
			None,
			().into(),
		)
		.await
		.unwrap();
	assert_eq!(result.exit_code, Some(0));
	trace
}
// TestKit explicitly resolves bare shell names to SelfShell; PiHost leaves
// OS shells external. Exercise native provenance without changing execution.
fn run_native_shell(script: &str) -> (Arc<RunTrace>, Vec<u8>) {
	let trace = Arc::new(RunTrace::new(script));
	let sink: Arc<dyn EventSink> = trace.clone();
	let mut rig = Rig::new(FakeHost::new().with_event_sink(sink), skeleton_init(&[]));
	rig.shell().set_event_mask(trace.mask());
	assert_eq!(rig.run(Script::command(script.as_bytes()), Fault::None), 0);
	(trace, rig.host.stdout.bytes())
}

fn present(trace: &RunTrace, options: &Options) -> Value {
	serde_json::from_str(&trace.presentation_json(options).unwrap()).unwrap()
}

fn rows(p: &Value) -> Vec<(String, &Value)> {
	p["rows"]
		.as_array()
		.unwrap()
		.iter()
		.map(|row| {
			let text = row["segments"]
				.as_array()
				.unwrap()
				.iter()
				.map(|segment| segment["text"].as_str().unwrap())
				.collect();
			(text, row)
		})
		.collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn uncompiled_script_is_parsed_ahead_without_outcomes_until_it_stops_parsing() {
	// A command still streaming in: nothing has run, its last line is
	// unfinished.
	let trace =
		RunTrace::new("cd /tmp && git add -A\nfor f in *.go; do echo \"$f\"; done\nif true; th");
	let streaming = present(&trace, &Options::default());
	let shown = rows(&streaming);
	let texts: Vec<&str> = shown.iter().map(|(text, _)| text.as_str()).collect();
	assert_eq!(texts, [
		"cwd /tmp",
		"and git add -A",
		"for f in glob(\"*.go\"):",
		"print(f\"{f}\")",
		"if true; th"
	]);
	assert!(shown.iter().all(|(_, row)| row["state"].is_null()), "{streaming}");
	assert_eq!(shown[4].1["role"], "raw", "an unfinished command stays literal");

	// The engine never reaches the last line: it is drawn, but never ran.
	let shell = Shell::new(None);
	let trace = run(&shell, "echo a\nexit 0\necho never").await;
	let ran = present(&trace, &Options::default());
	let shown = rows(&ran);
	let (text, row) = shown.last().unwrap();
	assert_eq!(text, "print(\"never\")");
	assert!(row["state"].is_null(), "{ran}");
}

/// Options for a command whose arguments are still streaming in.
fn streaming() -> Options {
	Options { streaming: true, ..Options::default() }
}

#[test]
fn streamed_tail_is_drawn_as_it_will_continue() {
	// A command still streaming in ends mid-construct. Parsed as is it fails,
	// and the whole command flipped to literal source until the construct
	// closed; each case is one way the tail is cut off.
	for (script, expected) in [
		// Open quote: the word grows in place.
		("cd /tmp && rg -n \"va", &["cwd /tmp", "and rg -n ‹va›"][..]),
		// Pipe awaiting its next stage.
		("cd /tmp && rg -n x a.cpp |", &["cwd /tmp", "and rg -n ‹x› a.cpp"]),
		// Redirection awaiting its target: `2` stays an argument until then.
		("make 2>", &["make 2"]),
		// A command name that is so far a reserved word (`fi` of `find`).
		("ls; fi", &["ls", "fi"]),
		// The start of `done` is not drawn as a command of the loop body.
		("for f in a b; do echo $f; d", &["for f in [\"a\", \"b\"]:", "print(f)"]),
		// Nor is `do`, though it is a reserved word of its own.
		("for f in a b; do echo $f; do", &["for f in [\"a\", \"b\"]:", "print(f)"]),
		// Nor in a body still empty, where the loop stays drawn.
		("while true; do\n  d", &["while true:"]),
		// The start of `esac` is no pattern, wherever a pattern may start.
		("case $x in e", &["match x:"]),
		("case $x in a) b;; e", &["match x:", "case \"a\":", "b"]),
		// A pattern awaiting its `)` grows in place.
		("case $x in fo", &["match x:", "case \"fo\":"]),
		// A pattern alternative awaiting its next pattern.
		("case $x in\n  start) run;;\n  stop|", &[
			"match x:",
			"case \"start\":",
			"run",
			"case \"stop\":",
		]),
		// A pipe dangling inside `$(` reports the unclosed `$(`.
		("x=$(cat a |", &["x = ⟨cat \"a\"⟩"]),
		// A backtick body is parsed only once closed: the dangling pipe in
		// it would empty it.
		("echo `ls |", &["print(⟨ls⟩)"]),
		// Quoted, `|` is text: nothing is dropped.
		("echo \"a | b", &["print(\"a | b\")"]),
		// Arithmetic awaiting an operand: its operator waits with it, and
		// `((` stays arithmetic rather than nested subshells.
		("x=$((a+", &["x = a"]),
		("(( i <", &["i"]),
		// A streamed `\` would escape an appended closer, or draw as a word:
		// it waits for its escapee.
		("echo \"C:\\", &["print(\"C:\")"]),
		("x=$(echo \\", &["x = ⟨print()⟩"]),
		("echo a | \\\n", &["print(\"a\")"]),
		("docker run \\\n  -v a:b \\", &["docker run -v a:b"]),
		("docker run --rm \\\n  ", &["docker run --rm"]),
		// Empty arithmetic draws nothing yet.
		("echo $((", &["print()"]),
		// A heredoc open in `$(` ends before the `$(` closes.
		("git add -A && git commit -m \"$(cat <<'EOF'\nfix: x\n\nBody.", &[
			"git add -A",
			"and git commit -m f\"{⟨cat <<'EOF'",
			"fix: x",
			"",
			"Body.",
			"EOF⟩}\"",
		]),
		// A `<<` quoted or commented is no heredoc to end.
		("echo \"use <<EOF", &["print(\"use <<EOF\")"]),
		// A compound still opening in `$(` is hidden, not the command.
		("x=$(if true; then", &["x = ⟨⟩"]),
		("out=$(for f in *.txt; do\n  if", &["out = ⟨⟩"]),
		("out=$(for", &["out = ⟨⟩"]),
		("out=$(for f i", &["out = ⟨⟩"]),
		("out=$(for f in *.txt; d", &["out = ⟨⟩"]),
		// A lone `&` is so far the start of `&&`.
		("cd /repo &", &["cwd /repo"]),
		// A redirection of the clobber form awaits its target too.
		("echo hi >|", &["print(\"hi\")"]),
		// A body still empty keeps its compound drawn.
		("for f in a; do\n  if grep -q x \"$f\"; then\n    ", &[
			"for f in [\"a\"]:",
			"if grep -q ‹x› f\"{f}\":",
		]),
		// Escape parity: after `\\` a `|` is a pipe awaiting its next stage
		// and a `>` a redirection awaiting its target; after `\` each is text.
		("echo x\\\\|", &["print(\"x\\\\\")"]),
		("echo x\\|", &["print(\"x|\")"]),
		("echo x\\\\>", &["print(\"x\\\\\")"]),
		("echo x\\>", &["print(\"x>\")"]),
		("x=$(echo a\\", &["x = ⟨print(\"a\")⟩"]),
		// An empty body: the placeholder it is closed with draws no row.
		("for f in a b; do", &["for f in [\"a\", \"b\"]:"]),
		("cd /tmp && (", &["cwd /tmp", "and subshell:"]),
		// A header still arriving: the start of `then` is not a command.
		("if true; th", &["if true:"]),
		// Nor are the starts of `in` and `do`.
		("for f i", &["for f in args:"]),
		("for f in a b; d", &["for f in [\"a\", \"b\"]:"]),
		// A compound keyword with no header yet stays the command name it
		// read as a byte earlier (`fo`).
		("cd /tmp && for", &["cwd /tmp", "and for"]),
		("for f in a; do echo $f; for", &["for f in [\"a\"]:", "print(f)", "for"]),
		// A loop opening inside a loop on the same line.
		("for i in 1 2; do for v", &["for i in [\"1\", \"2\"]:", "for v in args:"]),
		// The fd of a redirection still arriving after a compound.
		("(cd /tmp) 2>", &["subshell:", "cwd /tmp"]),
		// A function header: the name stays a command until `()` arrives,
		// then the definition is drawn before its body.
		("x; gen(", &["x", "gen"]),
		("x; gen()", &["x", "def gen():"]),
		("x; function gen", &["x", "def gen():"]),
	] {
		let p = present(&RunTrace::new(script), &streaming());
		let shown = rows(&p);
		let texts: Vec<&str> = shown.iter().map(|(text, _)| text.as_str()).collect();
		assert_eq!(texts, expected, "{script:?}");
		assert!(shown.iter().all(|(_, row)| row["role"] != "raw"), "{script:?}: {p}");
	}

	// A tail no completion closes stays literal, but not the commands
	// before it, nor the compound around it.
	for (script, drawn, literal) in [
		("cd /tmp && for (", &["cwd /tmp"][..], " && for ("),
		("for f in a; do\n  echo $f\n  for (", &["for f in [\"a\"]:", "print(f)"], "  for ("),
		("f() {\n  local x=1\n  for (", &["def f():", "local x=1"], "  for ("),
		("ls\nfi x", &["ls"], "fi x"),
		// An empty brace group has no row of its own to draw it.
		("ls && {", &["ls"], " && {"),
		// The `&` backgrounding the head stays with it.
		("sleep 1 &\nfor (", &["spawn sleep 1"], "for ("),
	] {
		let p = present(&RunTrace::new(script), &streaming());
		let mut shown = rows(&p);
		let (text, row) = shown.pop().unwrap();
		assert_eq!((text.as_str(), &row["role"]), (literal, &Value::from("raw")), "{script:?}");
		let texts: Vec<&str> = shown.iter().map(|(text, _)| text.as_str()).collect();
		assert_eq!(texts, drawn, "{script:?}");
		assert!(shown.iter().all(|(_, row)| row["role"] != "raw"), "{script:?}: {p}");
	}

	// Closers of what is open draw as the command will once they arrive:
	// parentheses open in arithmetic, a heredoc's delimiter line, a loop in
	// `$(`.
	for (prefix, whole) in [
		("(( x > 3 )", "(( x > 3 ))"),
		("echo \"big $(( x - 1 )", "echo \"big $(( x - 1 ))\""),
		(
			"git commit -m \"$(cat <<'EOF'\nfix: x\nEOF",
			"git commit -m \"$(cat <<'EOF'\nfix: x\nEOF\n)\"",
		),
		("x=$(for f in a; do echo", "x=$(for f in a; do echo\ndone)"),
		// A commented `<<` is no heredoc to end.
		("# see <<EOF\nx=\"abc", "# see <<EOF\nx=\"abc\""),
		// The start of a delimiter or awaited keyword is not drawn.
		(
			"git commit -m \"$(cat <<'EOF'\nfix: x\nEO",
			"git commit -m \"$(cat <<'EOF'\nfix: x\nEOF\n)\"",
		),
		("x=$(while read l; do\n  echo $l\n  d", "x=$(while read l; do\n  echo $l\ndone)"),
		(
			"out=$(for f in a; do\n  if x; then y; fi\ndo",
			"out=$(for f in a; do\n  if x; then y; fi\ndone)",
		),
		// A case pattern's `)` closes no `$(`.
		("x=$(case $a in\n  a) echo", "x=$(case $a in\n  a) echo\nesac)"),
		("x=$(case $a in a) echo;; esac; for", "x=$(case $a in a) echo;; esac; )"),
		// Nested `$(` close innermost first; a closed one is no longer open.
		("x=$(echo $(ls", "x=$(echo $(ls))"),
		("echo \"$(basename $(pwd", "echo \"$(basename $(pwd))\""),
		("x=$(for f in a; do echo $(ls)", "x=$(for f in a; do echo $(ls)\ndone)"),
		(
			"out=$(for f in *.txt; do\n  echo \"$f: $(wc -l < \"$f\"",
			"out=$(for f in *.txt; do\n  echo \"$f: $(wc -l < \"$f\")\"\ndone)",
		),
	] {
		let texts = |script: &str, options: &Options| -> Vec<String> {
			rows(&present(&RunTrace::new(script), options))
				.into_iter()
				.map(|(text, _)| text)
				.collect()
		};
		assert_eq!(texts(prefix, &streaming()), texts(whole, &Options::default()), "{prefix:?}");
	}
}

#[test]
fn a_case_pattern_in_substitutions_ends_the_repair() {
	// A case pattern's `)` misleads the search for the `$(` still open: the
	// repair recursed until the stack overflowed and took the process down,
	// then emptied the `$(` nested in the arm. Each draws as it will once
	// closed.
	let texts = |script: &str, options: &Options| -> Vec<String> {
		rows(&present(&RunTrace::new(script), options))
			.into_iter()
			.map(|(text, _)| text)
			.collect()
	};
	for (prefix, whole) in [
		("x=$(case a in a) echo $(", "x=$(case a in a) echo $()\nesac)"),
		("x=$(case a in a) echo $(ls -la", "x=$(case a in a) echo $(ls -la)\nesac)"),
		("y=$(case $1 in\n  a|b) echo \"$(date", "y=$(case $1 in\n  a|b) echo \"$(date)\"\nesac)"),
	] {
		assert_eq!(texts(prefix, &streaming()), texts(whole, &Options::default()), "{prefix:?}");
	}
	// Deeper than the repair may recurse, the draft stays literal, on one row.
	let deep = format!("x=$({}", "echo $(case a in a) ".repeat(20));
	let p = present(&RunTrace::new(deep.as_str()), &streaming());
	let shown = rows(&p);
	assert_eq!(shown.len(), 1, "{p}");
	assert_eq!((shown[0].0.as_str(), &shown[0].1["role"]), (deep.as_str(), &Value::from("raw")));
}

#[tokio::test(flavor = "multi_thread")]
async fn only_a_streaming_draft_is_drawn_as_it_will_continue() {
	// Once its arguments are complete, or a run has started, the script is
	// whole: its unterminated end is not drawn as valid, neither before the
	// run, nor while earlier lines run, nor after the shell rejected it.
	let root = tempfile::tempdir().unwrap();
	let gate = root.path().join("gate");
	let script = format!("while [ ! -e '{}' ]; do sleep 0.01; done\necho \"b", gate.display());
	let trace = Arc::new(RunTrace::new(script.as_str()));
	let last = |trace: &RunTrace, options: &Options| {
		let p = present(trace, options);
		let (text, row) = rows(&p).pop().unwrap();
		(text, row["role"].clone())
	};
	let literal = ("echo \"b".to_owned(), serde_json::Value::from("raw"));
	assert_eq!(last(&trace, &streaming()), ("print(\"b\")".to_owned(), "stmt".into()), "draft");
	assert_eq!(last(&trace, &Options::default()), literal, "complete");
	let shell = Shell::new(None);
	let run = shell.run(
		ShellRunOptions {
			command: script.clone(),
			trace: Some(Arc::clone(&trace)),
			..ShellRunOptions::default()
		},
		None,
		().into(),
	);
	let probe = async {
		while present(&trace, &Options::default())["running"] != true {
			tokio::task::yield_now().await;
		}
		let running = last(&trace, &streaming());
		std::fs::write(&gate, []).unwrap();
		running
	};
	let (result, running) =
		tokio::time::timeout(std::time::Duration::from_secs(10), async { tokio::join!(run, probe) })
			.await
			.unwrap();
	assert_ne!(result.unwrap().exit_code, Some(0));
	assert_eq!(running, literal, "running");
	assert_eq!(last(&trace, &streaming()), literal, "finished");
}

#[test]
fn bare_test_bracket_without_operands_renders_instead_of_panicking() {
	// Regression for #18320: a streamed `[` with no operands sliced
	// `words[1..0]` and aborted the host process.
	for (script, expected) in [
		("[", &[""][..]),
		("a && [", &["a", "and "]),
		("! [", &["not "]),
		("x=$(a); [", &["x = ⟨a⟩", ""]),
		("test", &[""]),
	] {
		let p = present(&RunTrace::new(script), &Options::default());
		let texts: Vec<String> = rows(&p).into_iter().map(|(text, _)| text).collect();
		assert_eq!(texts, expected, "{script:?}");
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn callout_scripts_are_drawn_by_their_command_but_eval_code_gets_a_frame() {
	let frames = |p: &Value| {
		p["rows"]
			.as_array()
			.unwrap()
			.iter()
			.filter(|row| {
				row["id"]
					.as_str()
					.is_some_and(|id| id.starts_with("frame-"))
			})
			.count()
	};
	let shell = Shell::new(None);
	// `timeout` and `xargs` run their operands through scripts of their own;
	// `env -i`'s script forks (`$(declare -F)`) and assigns its loop names.
	let trace = run(&shell, "timeout 5 true; echo a | xargs -n1 true; env -i X=1 true").await;
	let live = present(&trace, &Options::default());
	assert_eq!(frames(&live), 0, "{live}");
	assert_eq!(live["watches"], serde_json::json!([]), "{live}");
	let stored = StoredVisualization::from_snapshot_json(&trace.snapshot_json()).unwrap();
	let restored: Value =
		serde_json::from_str(&stored.presentation_json(&Options::default()).unwrap()).unwrap();
	assert_eq!(frames(&restored), 0, "{restored}");
	assert_eq!(restored["watches"], serde_json::json!([]), "{restored}");

	let trace = run(&shell, "x=true; eval \"$x\"").await;
	assert_eq!(frames(&present(&trace, &Options::default())), 1);
}

#[test]
fn legacy_boundary_includes_heredoc_without_parsing_unannounced_future_syntax() {
	use crate::bash::{
		ids::ModeId,
		ir,
		syntax::{Features, NO_ALIASES, Parser},
	};
	let script = "cat <<'EOF'\npayload\nEOF\nif unannounced";
	let command = Parser::new(script.as_bytes(), Features::NONE, NO_ALIASES)
		.next_command()
		.unwrap()
		.unwrap();
	let unit =
		ir::lower_deferred(&command, script.as_bytes(), ModeId::Bash, Features::NONE).unwrap();
	let nodes: Vec<_> = unit
		.nodes
		.iter()
		.map(|node| serde_json::json!({"k":node.kind,"lo":node.lo,"hi":node.hi,"state":"pending"}))
		.collect();
	let legacy = serde_json::json!({"v":1,"seq":0,"script":script,"units":[{"at":0,"line":1,"nodes":nodes}],"history":[],"t_ns":0});
	let stored = StoredVisualization::from_snapshot_json(&legacy.to_string()).unwrap();
	assert_eq!(
		stored.trace.units[0].source.as_ref().unwrap().as_slice(),
		b"cat <<'EOF'\npayload\nEOF"
	);
	let presentation: Value =
		serde_json::from_str(&stored.presentation_json(&Options::default()).unwrap()).unwrap();
	assert!(
		presentation["rows"]
			.as_array()
			.unwrap()
			.iter()
			.flat_map(|row| row["segments"].as_array().unwrap())
			.any(|segment| segment["text"]
				.as_str()
				.is_some_and(|text| text.contains("if unannounced")))
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn raw_effect_badges_follow_source_order_after_restoration() {
	let shell = Shell::new(None);
	let trace = run(&shell, "uncalled() { rm --help; ln -s --help; }\n:").await;
	let options = Options { view: View::Raw, ..Options::default() };
	let live = present(&trace, &options);
	let kinds: Vec<_> = live["rows"]
		.as_array()
		.unwrap()
		.iter()
		.flat_map(|row| row["effects"].as_array().unwrap())
		.map(|effect| effect["kind"].as_str().unwrap())
		.collect();
	assert_eq!(kinds, ["destructive", "write"]);
	assert_eq!(live["output"], "", "the fixture function is never executed");
	let stored = StoredVisualization::from_snapshot_json(&trace.snapshot_json()).unwrap();
	let restored: Value =
		serde_json::from_str(&stored.presentation_json(&options).unwrap()).unwrap();
	assert_eq!(live["rows"], restored["rows"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn actual_shell_presentation_restores_native_archive_and_rewinds_setters() {
	let shell = Shell::new(None);
	let trace = run(&shell, "x=one; printf '%s\\n' \"$x\"; x=two; printf '%s\\n' \"$x\"").await;
	let snapshot = trace.snapshot();
	assert!(snapshot.units.iter().all(|unit| unit.syntax.is_some()));
	let saved = trace.snapshot_json();
	let encoded: Value = serde_json::from_str(&saved).unwrap();
	assert!(
		encoded["units"]
			.as_array()
			.unwrap()
			.iter()
			.all(|unit| unit["syntax"].is_string())
	);
	let stored = StoredVisualization::from_snapshot_json(&saved).unwrap();
	for view in [View::Raw, View::Pseudo] {
		let options = Options { view, ..Options::default() };
		let live = present(&trace, &options);
		let restored: Value =
			serde_json::from_str(&stored.presentation_json(&options).unwrap()).unwrap();
		assert_eq!(live, restored);
		assert_eq!(live["output"], "one\ntwo\n");
		assert!(
			live["watches"]
				.as_array()
				.unwrap()
				.iter()
				.any(|watch| watch["name"] == "x" && watch["value"] == "two")
		);
		for row in live["rows"].as_array().unwrap() {
			if let Some(seq) = row["executionSeq"].as_u64() {
				let event = snapshot
					.history
					.iter()
					.find(|event| event.seq == seq)
					.unwrap();
				assert!(matches!(event.data, HistoryData::CmdEnd { .. }));
				assert_eq!(row["executedAtNs"].as_u64(), Some(event.t_ns));
			}
		}
	}
	let first=snapshot.history.iter().find(|event|matches!(&event.data,HistoryData::Assign{name,value,..} if name.as_slice()==b"x"&&value.as_slice()==b"one")).unwrap();
	let options = Options {
		cursor: Some(snapshot.history.len()),
		cursor_seq: Some(first.seq),
		..Options::default()
	};
	let replay = present(&trace, &options);
	assert_eq!(replay["output"], "");
	assert!(
		replay["watches"]
			.as_array()
			.unwrap()
			.iter()
			.any(|watch| watch["name"] == "x" && watch["value"] == "one")
	);
	let empty = present(&trace, &Options { cursor: Some(0), ..Options::default() });
	assert_eq!(empty["output"], "");
	assert!(empty["watches"].as_array().unwrap().is_empty());
	assert!(
		empty["rows"]
			.as_array()
			.unwrap()
			.iter()
			.all(|row| row.get("executionSeq").is_none())
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn previously_unobserved_alias_definition_announces_canonical_body_to_each_observer() {
	let shell = Shell::new(None);
	let setup = "shopt -s expand_aliases\nalias native_viz_say='printf retained'\nnative_viz_f() { \
	             native_viz_say; }";
	let outcome = shell
		.run(ShellRunOptions { command: setup.into(), ..ShellRunOptions::default() }, None, ().into())
		.await
		.unwrap();
	assert_eq!(outcome.exit_code, Some(0));
	for _ in 0..2 {
		let trace = run(&shell, "native_viz_f").await;
		let snapshot = trace.snapshot();
		assert!(
			snapshot
				.units
				.iter()
				.any(|unit| unit.at.is_none() && unit.syntax.is_some())
		);
		let model = present(&trace, &Options::default());
		assert_eq!(model["output"], "retained");
		let saved = StoredVisualization::from_snapshot_json(&trace.snapshot_json()).unwrap();
		let restored: Value =
			serde_json::from_str(&saved.presentation_json(&Options::default()).unwrap()).unwrap();
		assert_eq!(model, restored);
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn dynamic_local_setter_does_not_invent_binding_ownership_from_function_entry() {
	let shell = Shell::new(None);
	let script = "native_viz_dynamic_g() { native_viz_dynamic_x=two; }; native_viz_dynamic_f() { \
	              local native_viz_dynamic_x=one; native_viz_dynamic_g; printf '%s' \
	              \"$native_viz_dynamic_x\"; }; native_viz_dynamic_f";
	let trace = run(&shell, script).await;
	let snapshot = trace.snapshot();
	let last=snapshot.history.iter().rev().find(|event|matches!(&event.data,HistoryData::Assign{name,value,..} if name.as_slice()==b"native_viz_dynamic_x"&&value.as_slice()==b"two")).unwrap();
	let live = present(&trace, &Options::default());
	assert_eq!(live["output"], "two");
	let watches: Vec<_> = live["watches"]
		.as_array()
		.unwrap()
		.iter()
		.filter(|watch| watch["name"] == "native_viz_dynamic_x")
		.collect();
	assert_eq!(
		watches.len(),
		1,
		"g updates f's dynamically scoped local, not a new binding owned by g"
	);
	assert_eq!(watches[0]["value"], "two");
	assert_eq!(watches[0]["scope"], "local");
	assert!(
		watches[0]["scopeId"]
			.as_str()
			.unwrap()
			.ends_with(":binding:unknown")
	);
	assert_eq!(watches[0]["setterSeq"].as_u64(), Some(last.seq));
	let annotations: Vec<_> = live["rows"]
		.as_array()
		.unwrap()
		.iter()
		.filter_map(|row| row["annotations"].as_array())
		.flatten()
		.filter(|watch| watch["name"] == "native_viz_dynamic_x")
		.collect();
	assert_eq!(annotations.len(), 1);
	assert_eq!(annotations[0]["setterSeq"].as_u64(), Some(last.seq));
	let first=snapshot.history.iter().find(|event|matches!(&event.data,HistoryData::Assign{name,value,..} if name.as_slice()==b"native_viz_dynamic_x"&&value.as_slice()==b"one")).unwrap();
	let replay = present(&trace, &Options {
		cursor: Some(snapshot.history.len()),
		cursor_seq: Some(first.seq),
		..Options::default()
	});
	let replayed: Vec<_> = replay["watches"]
		.as_array()
		.unwrap()
		.iter()
		.filter(|watch| watch["name"] == "native_viz_dynamic_x")
		.collect();
	assert_eq!(replayed.len(), 1);
	assert_eq!(replayed[0]["value"], "one");
	let stored = StoredVisualization::from_snapshot_json(&trace.snapshot_json()).unwrap();
	let restored: Value =
		serde_json::from_str(&stored.presentation_json(&Options::default()).unwrap()).unwrap();
	assert_eq!(live, restored);
}

#[tokio::test(flavor = "multi_thread")]
async fn local_eval_literal_child_uses_actual_origin_and_native_node_ids() {
	let shell = Shell::new(None);
	let script = "eval 'child=inside; printf \"%s\\n\" \"$child\"'";
	let trace = run(&shell, script).await;
	let snapshot = trace.snapshot();
	let child = snapshot
		.units
		.iter()
		.enumerate()
		.find(|(_, unit)| {
			unit
				.syntax
				.as_ref()
				.is_some_and(|syntax| syntax.parent.is_some())
		})
		.expect("native literal source provenance");
	let parent = child.1.syntax.as_ref().unwrap().parent.unwrap();
	assert_ne!(parent.unit, child.0 as u32);
	let parent_syntax = snapshot.units[parent.unit as usize]
		.syntax
		.as_ref()
		.unwrap();
	let Root::List(parent_list) = parent_syntax.tree.view() else {
		panic!("native parent list");
	};
	fn first(list: List<'_>) -> crate::bash::syntax::tree::Command<'_> {
		list
			.items()
			.first()
			.unwrap()
			.and_or()
			.first()
			.stages()
			.first()
			.unwrap()
	}
	let CommandKind::Simple(parent_command) = first(parent_list).kind() else {
		panic!("native shell invocation");
	};
	let word = parent_command.words().get(1).unwrap();
	assert_eq!(parent.node, word.id().0);
	assert_eq!(
		(parent.lo, parent.hi),
		(word.span().lo - parent_syntax.offset, word.span().hi - parent_syntax.offset)
	);
	assert_eq!(
		&script.as_bytes()[parent.lo as usize..parent.hi as usize],
		b"'child=inside; printf \"%s\\n\" \"$child\"'"
	);
	let child_syntax = child.1.syntax.as_ref().unwrap();
	let Root::List(child_list) = child_syntax.tree.view() else {
		panic!("native child list");
	};
	let CommandKind::Simple(setter) = first(child_list).kind() else {
		panic!("native child assignment");
	};
	let assignment = setter.assigns().first().unwrap();
	let key = format!("{}:0:{}", child.0, assignment.id().0);
	let owner = format!("{}:0:{}", child.0, first(child_list).id().0);
	let range = serde_json::json!([
		parent.lo + 1 + assignment.span().lo,
		parent.lo + 1 + assignment.span().hi,
	]);
	let model = present(&trace, &Options::default());
	assert_eq!(model["output"], "inside\n");
	assert!(
		model["rows"]
			.as_array()
			.unwrap()
			.iter()
			.flat_map(|row| row["segments"].as_array().unwrap())
			.any(|segment| segment["node"] == key && segment["range"] == range)
	);
	assert!(snapshot.history.iter().any(|event| {
		event.u == Some(child.0 as u32)
			&& matches!(&event.data, HistoryData::Assign { name, value, .. }
			if name.as_slice() == b"child" && value.as_slice() == b"inside")
	}));
	let stored = StoredVisualization::from_snapshot_json(&trace.snapshot_json()).unwrap();
	let restored: Value =
		serde_json::from_str(&stored.presentation_json(&Options::default()).unwrap()).unwrap();
	assert_eq!(model, restored);
	let setter = snapshot
		.history
		.iter()
		.find(|event| {
			event.u == Some(child.0 as u32) && matches!(event.data, HistoryData::Assign { .. })
		})
		.unwrap();
	assert!(model["watches"].as_array().unwrap().iter().any(|watch| {
		watch["name"] == "child"
			&& watch["value"] == "inside"
			&& watch["node"] == owner
			&& watch["range"] == range
			&& watch["setterSeq"].as_u64() == Some(setter.seq)
	}));
	let options = Options {
		cursor: Some(snapshot.history.len()),
		cursor_seq: Some(setter.seq),
		..Options::default()
	};
	let replay = present(&trace, &options);
	let restored_replay: Value =
		serde_json::from_str(&stored.presentation_json(&options).unwrap()).unwrap();
	assert_eq!(replay, restored_replay);
	assert_eq!(replay["output"], "");
}

#[test]
fn same_native_child_unit_at_two_real_origins_keeps_distinct_trace_identity() {
	let (trace, stdout) = run_native_shell("bash -c 'printf same' & bash -c 'printf same' & wait");
	assert_eq!(stdout, b"samesame");
	let snapshot = trace.snapshot();
	let children: Vec<_> = snapshot
		.units
		.iter()
		.filter_map(|unit| unit.syntax.as_ref().and_then(|syntax| syntax.parent))
		.collect();
	assert_eq!(children.len(), 2);
	assert_eq!(children[0].unit, children[1].unit);
	assert_ne!(children[0].node, children[1].node);
	let parent_syntax = snapshot.units[children[0].unit as usize]
		.syntax
		.as_ref()
		.unwrap();
	let Root::List(parent_list) = parent_syntax.tree.view() else {
		panic!("native parent list");
	};
	let mut expected = parent_list
		.items()
		.take(2)
		.iter()
		.map(|item| {
			let command = item.and_or().first().stages().first().unwrap();
			let CommandKind::Simple(command) = command.kind() else {
				panic!("native shell invocation");
			};
			command.words().get(2).unwrap().id().0
		})
		.collect::<Vec<_>>();
	let mut actual = children
		.iter()
		.map(|parent| parent.node)
		.collect::<Vec<_>>();
	actual.sort_unstable();
	expected.sort_unstable();
	assert_eq!(actual, expected);
	let live = present(&trace, &Options::default());
	for (index, unit) in snapshot.units.iter().enumerate().filter(|(_, unit)| {
		unit
			.syntax
			.as_ref()
			.is_some_and(|syntax| syntax.parent.is_some())
	}) {
		assert_eq!(unit.source.as_ref().unwrap().as_slice(), b"printf same");
		let syntax = unit.syntax.as_ref().unwrap();
		let parent = syntax.parent.unwrap();
		let Root::List(list) = syntax.tree.view() else {
			panic!("native child list");
		};
		let command = list
			.items()
			.first()
			.unwrap()
			.and_or()
			.first()
			.stages()
			.first()
			.unwrap();
		let key = format!("{index}:0:{}", command.id().0);
		let range = serde_json::json!([parent.lo + 1, parent.hi - 1]);
		let completion = snapshot
			.history
			.iter()
			.find(|event| {
				event.u == Some(index as u32) && matches!(event.data, HistoryData::CmdEnd { .. })
			})
			.unwrap();
		assert!(live["rows"].as_array().unwrap().iter().any(|row| {
			row["node"] == key
				&& row["range"] == range
				&& row["executionSeq"].as_u64() == Some(completion.seq)
		}));
	}
	let stored = StoredVisualization::from_snapshot_json(&trace.snapshot_json()).unwrap();
	let restored: Value =
		serde_json::from_str(&stored.presentation_json(&Options::default()).unwrap()).unwrap();
	assert_eq!(live, restored);
}

#[tokio::test(flavor = "multi_thread")]
async fn expanded_script_equal_to_a_literal_does_not_borrow_its_origin() {
	let shell = Shell::new(None);
	let trace = run(&shell, "script='printf same'; eval \"$script\"; eval 'printf same'").await;
	let snapshot = trace.snapshot();
	let children = snapshot
		.units
		.iter()
		.filter(|unit| unit.at.is_none())
		.collect::<Vec<_>>();
	assert_eq!(children.len(), 2);
	assert!(children[0].syntax.as_ref().unwrap().parent.is_none());
	assert!(children[1].syntax.as_ref().unwrap().parent.is_some());
	assert_eq!(children[0].source, children[1].source);
	let live = present(&trace, &Options::default());
	assert_eq!(live["output"], "samesame");
	let stored = StoredVisualization::from_snapshot_json(&trace.snapshot_json()).unwrap();
	let restored: Value =
		serde_json::from_str(&stored.presentation_json(&Options::default()).unwrap()).unwrap();
	assert_eq!(live, restored);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn external_shell_literal_is_rendered_without_inventing_native_child_outcomes() {
	let shell = Shell::new(None);
	let trace = run(&shell, "bash -c 'native_viz_external=inside; printf outside'").await;
	let snapshot = trace.snapshot();
	assert_eq!(snapshot.units.len(), 1);
	assert!(snapshot.units[0].syntax.as_ref().unwrap().parent.is_none());
	assert!(snapshot.history.iter().all(|event| {
		!matches!(&event.data, HistoryData::Assign { name, .. }
			if name.as_slice() == b"native_viz_external")
	}));
	let live = present(&trace, &Options::default());
	assert_eq!(live["output"], "outside");
	assert!(
		live["watches"]
			.as_array()
			.unwrap()
			.iter()
			.all(|watch| { watch["name"] != "native_viz_external" })
	);
	for row in live["rows"].as_array().unwrap() {
		if row["node"]
			.as_str()
			.is_some_and(|key| key.split(':').nth(1).is_some_and(|source| source != "0"))
		{
			assert!(row.get("executionSeq").is_none());
			assert!(row.get("executedAtNs").is_none());
		}
	}
	assert!(live["rows"].as_array().unwrap().iter().any(|row| {
		row["detail"]
			.as_str()
			.is_some_and(|detail| detail.contains("external/untraced"))
			|| row["segments"].as_array().unwrap().iter().any(|segment| {
				segment["text"]
					.as_str()
					.is_some_and(|text| text.contains("external/untraced"))
			})
	}));
	let stored = StoredVisualization::from_snapshot_json(&trace.snapshot_json()).unwrap();
	let restored: Value =
		serde_json::from_str(&stored.presentation_json(&Options::default()).unwrap()).unwrap();
	assert_eq!(live, restored);
}

#[tokio::test(flavor = "multi_thread")]
async fn pipeline_and_forked_function_body_share_the_original_canonical_occurrence() {
	let shell = Shell::new(None);
	let trace =
		run(&shell, "native_viz_pipe_f() { printf pipeline; }; native_viz_pipe_f | cat").await;
	let snapshot = trace.snapshot();
	assert_eq!(
		snapshot.units.len(),
		1,
		"vproc lookup context must not duplicate a static source occurrence"
	);
	assert!(
		snapshot
			.history
			.iter()
			.filter(|event| event.n.is_some())
			.all(|event| event.u == Some(0))
	);
	let live = present(&trace, &Options::default());
	assert_eq!(live["output"], "pipeline");
	let stored = StoredVisualization::from_snapshot_json(&trace.snapshot_json()).unwrap();
	let restored: Value =
		serde_json::from_str(&stored.presentation_json(&Options::default()).unwrap()).unwrap();
	assert_eq!(live, restored);
}

#[tokio::test(flavor = "multi_thread")]
async fn branch_badges_follow_real_negated_and_elif_decisions() {
	let shell = Shell::new(None);
	let trace = run(
		&shell,
		"if ! false; then printf yes; else printf no; fi; if false; then :; elif ! false; then \
		 printf second; fi",
	)
	.await;
	let presentation = present(&trace, &Options::default());
	assert_eq!(presentation["output"], "yessecond");
	let heads: Vec<_> = presentation["rows"]
		.as_array()
		.unwrap()
		.iter()
		.filter(|row| row["role"] == "head")
		.collect();
	assert!(heads.iter().filter(|row| row["meta"] == "↳").count() >= 2);
	assert!(heads.iter().any(|row| row["meta"] == "↷"));
}

#[test]
fn a_trace_saved_by_another_build_restores_from_its_source() {
	use base64::{Engine as _, engine::general_purpose::STANDARD};
	let (trace, _) = run_native_shell(
		"f() { echo \"$1\"; }\nf one\nread -r d <<E\ndoc $(echo x)\nE\necho \"$d\"\n",
	);
	let saved = trace.snapshot_json();
	// Another build's archives: the same field, a version this build does
	// not read (a session saved before an upgrade).
	let mut other: Value = serde_json::from_str(&saved).unwrap();
	let mut archives = 0;
	for unit in other["units"].as_array_mut().unwrap() {
		if let Some(text) = unit["syntax"].as_str() {
			let mut bytes = STANDARD.decode(text).unwrap();
			bytes[0] = bytes[0].wrapping_add(1);
			unit["syntax"] = STANDARD.encode(bytes).into();
			archives += 1;
		}
	}
	assert!(archives > 0);
	let present = |json: &str| {
		StoredVisualization::from_snapshot_json(json)
			.unwrap()
			.presentation_json(&Options::default())
			.unwrap()
	};
	assert_eq!(present(&other.to_string()), present(&saved));
}

/// A command nested past [`MAX_NESTING`](crate::bash::syntax::MAX_NESTING)
/// is a syntax error rather than a stack overflow that takes the host
/// process down; one at the limit is parsed, lowered, printed, exported,
/// run and drawn within a 2 MiB stack, the default the shells run on.
#[test]
fn nesting_is_a_syntax_error_past_the_limit_and_fits_a_default_stack_at_it() {
	use crate::bash::{
		ids::ModeId,
		ir,
		syntax::{
			Features, JsonDialect, MAX_NESTING, Offsets, PrintStyle, parse_all, print_list, to_json,
		},
	};
	let zsh = Features::ZSH | Features::ZSH_SHORT_LOOPS | Features::ZSH_INTERACTIVE_COMMENTS;
	// (prefix, open, inner, close, suffix, features, levels per repeat,
	// levels of the prefix): `open`/`close` repeat once per level; a bash
	// substitution is two; text re-parsed as a list (a backquote, a `$((`
	// that is not arithmetic) is one more.
	type Shape =
		(&'static str, &'static str, &'static str, &'static str, &'static str, Features, u32, u32);
	let shapes: [Shape; 13] = [
		("", "( ", ":", " )", "", Features::NONE, 1, 0),
		("", "{ ", ":", "; }", "", Features::NONE, 1, 0),
		("", "if :; then ", ":", "; fi", "", Features::NONE, 1, 0),
		("", "echo $(", "echo x", ")", "", Features::NONE, 2, 0),
		("", "echo ${x:-", "y", "}", "", Features::NONE, 1, 0),
		("[[ ", "( ", "a", " )", " ]]", Features::NONE, 1, 0),
		("[[ ", "! ", "a", "", " ]]", Features::NONE, 1, 0),
		("[[ ", "a || ", "a", "", " ]]", Features::NONE, 1, 0),
		("echo `", "( ", ":", " )", "`", Features::NONE, 1, 1),
		("echo $(", "( ", "echo x", " )", " )", Features::NONE, 1, 1),
		("", "( ", ":", " )", "", zsh, 1, 0),
		("", "echo $(", "echo x", ")", "", zsh, 1, 0),
		("[[ ", "( ", "a", " )", " ]]", zsh, 1, 0),
	];
	let check = move || {
		for (pre, open, inner, close, suf, feat, cost, extra) in shapes {
			let n = ((MAX_NESTING - extra) / cost) as usize;
			let src = |k: usize| format!("{pre}{}{inner}{}{suf}\n", open.repeat(k), close.repeat(k));
			let at = src(n);
			let prog = parse_all(at.as_bytes(), feat).unwrap_or_else(|e| {
				panic!("{open:?} nested {n} deep: {}", String::from_utf8_lossy(&e.bash_msg()))
			});
			for dialect in [JsonDialect::Native, JsonDialect::Shfmt] {
				to_json(at.as_bytes(), &prog, dialect, Offsets::Bytes);
			}
			let style = if feat.contains(Features::ZSH) {
				PrintStyle::Zsh
			} else {
				PrintStyle::DeclareF
			};
			for cc in &prog.commands {
				print_list(cc.list(), style);
			}
			let mode = if feat.contains(Features::ZSH) {
				ModeId::Zsh
			} else {
				ModeId::Bash
			};
			ir::compile_all(at.as_bytes(), mode, feat);
			if !feat.contains(Features::ZSH) {
				let (trace, _) = run_native_shell(&at);
				present(&trace, &Options::default());
			}
			let past = parse_all(src(n + 1).as_bytes(), feat)
				.map(|_| ())
				.expect_err(&format!("{pre}{open} {feat:?} nested {} deep parsed", n + 1));
			// zsh's lexer reports a substitution it cannot parse as `parse
			// error near …`, whatever the reason.
			let msg = past.bash_msg();
			assert!(
				msg.ends_with(b"maximum nesting level exceeded")
					|| (feat.contains(Features::ZSH) && open == "echo $("),
				"{pre}{open:?} nested {} deep: {}",
				n + 1,
				String::from_utf8_lossy(&msg)
			);
		}
	};
	std::thread::Builder::new()
		.stack_size(2 << 20)
		.spawn(check)
		.unwrap()
		.join()
		.unwrap();
}

#[cfg(unix)]
/// Text, indentation and role of every statement or literal row: what a
/// phase change must not move.
fn chain_rows(p: &Value) -> Vec<(String, u64, String)> {
	rows(p)
		.into_iter()
		.filter(|(_, row)| row["role"] == "stmt" || row["role"] == "raw")
		.map(|(text, row)| {
			(text, row["depth"].as_u64().unwrap(), row["role"].as_str().unwrap().to_owned())
		})
		.collect()
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn segmented_and_chain_keeps_pseudo_connectors_while_running_and_after() {
	// Regression for #18408: the minimizer runs each `&&` operand as its own
	// unit, and the operators between (and before) them were drawn as raw
	// ` && ` rows instead of Pseudo `and` connectors.
	let root = tempfile::tempdir().unwrap();
	let gate = root.path().join("gate");
	let wait = root.path().join("wait.sh");
	std::fs::write(&wait, format!("while [ ! -e \"{}\" ]; do sleep 0.01; done\n", gate.display()))
		.unwrap();
	let command = format!("echo start && /bin/sh {} && echo middle && echo end", wait.display());
	let pending = chain_rows(&present(&RunTrace::new(command.as_str()), &Options::default()));
	assert_eq!(pending.len(), 4, "{pending:?}");
	assert_eq!(pending[0], ("print(\"start\")".into(), 0, "stmt".into()));
	assert!(
		pending[1..]
			.iter()
			.all(|(text, depth, role)| text.starts_with("and ") && *depth == 1 && role == "stmt"),
		"{pending:?}"
	);

	let trace = Arc::new(RunTrace::new(command.as_str()));
	let shell = Shell::new(Some(crate::ShellOptions {
		minimizer: Some(crate::minimizer::MinimizerOptions {
			enabled: Some(true),
			..Default::default()
		}),
		..Default::default()
	}));
	let run = shell.run(
		ShellRunOptions {
			command: command.clone(),
			trace: Some(Arc::clone(&trace)),
			..Default::default()
		},
		None,
		().into(),
	);
	let probe = async {
		// The gate segment is the second announced unit; the tail is unrun.
		while trace
			.snapshot()
			.units
			.iter()
			.filter(|unit| unit.at.is_some())
			.count()
			< 2
		{
			tokio::task::yield_now().await;
		}
		let running = chain_rows(&present(&trace, &Options::default()));
		std::fs::write(&gate, []).unwrap();
		running
	};
	let (result, running) =
		tokio::time::timeout(std::time::Duration::from_secs(10), async { tokio::join!(run, probe) })
			.await
			.unwrap();
	assert_eq!(result.unwrap().exit_code, Some(0));
	assert_eq!(running, pending, "running");
	assert_eq!(chain_rows(&present(&trace, &Options::default())), pending, "finished");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn running_command_keeps_the_script_it_runs_active() {
	// What a command runs is part of the command: while it runs, its heredoc
	// and its untraced `sh -c` script must not dim like inactive rows.
	let root = tempfile::tempdir().unwrap();
	let gate = root.path().join("gate");
	let wait = format!("while [ ! -e \"{}\" ]; do sleep 0.01; done", gate.display());
	for command in [
		format!("/bin/sh <<'EOF'\n{wait}\necho done\nEOF\necho after"),
		format!("/bin/sh -c '{wait}\necho done'\necho after"),
	] {
		let _ = std::fs::remove_file(&gate);
		let trace = Arc::new(RunTrace::new(command.as_str()));
		let shell = Shell::new(None);
		let run = shell.run(
			ShellRunOptions {
				command: command.clone(),
				trace: Some(Arc::clone(&trace)),
				..Default::default()
			},
			None,
			().into(),
		);
		let probe = async {
			loop {
				let p = present(&trace, &Options::default());
				if p["running"] == true {
					let raw = present(&trace, &Options { view: View::Raw, ..Options::default() });
					std::fs::write(&gate, []).unwrap();
					return (p, raw);
				}
				tokio::task::yield_now().await;
			}
		};
		let (result, (running, raw)) =
			tokio::time::timeout(std::time::Duration::from_secs(10), async {
				tokio::join!(run, probe)
			})
			.await
			.unwrap();
		assert_eq!(result.unwrap().exit_code, Some(0));
		let shown = rows(&running);
		let script: Vec<&(String, &Value)> = shown
			.iter()
			.filter(|(_, row)| row["depth"].as_u64() > Some(0))
			.collect();
		assert!(script.len() >= 3, "{command:?}: {running}");
		assert!(script.iter().all(|(_, row)| row["active"] == true), "{command:?}: {running}");
		let (_, after) = shown.last().unwrap();
		assert_ne!(after["active"], true, "{command:?}: {running}");
		// Raw: every source line of the command, through a heredoc's
		// delimiter, runs; the next command does not.
		let lines = rows(&raw);
		let (after, command_lines) = lines.split_last().unwrap();
		assert!(command_lines.iter().all(|(_, row)| row["active"] == true), "{command:?}: {raw}");
		assert_ne!(after.1["active"], true, "{command:?}: {raw}");
		let finished = present(&trace, &Options::default());
		assert!(
			rows(&finished).iter().all(|(_, row)| row["active"] != true),
			"{command:?}: {finished}"
		);
	}
}
