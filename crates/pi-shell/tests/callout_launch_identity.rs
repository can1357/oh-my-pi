//! Nothing of the command a host callout runs its operand with can be
//! found by name or rebuilt from text.
//!
//! A callout (`timeout`, `nohup`, `xargs`, `env`, `git`, `find -exec`)
//! runs its operand as one command of a script the engine owns. Two
//! properties are pinned here, and both are structural rather than a list
//! of blocked names:
//!
//! 1. **By name.** The launch belongs to the run and is taken by the one
//!    command the engine built for it. A function, an alias or a trap action
//!    named like any word the engine ever used cannot reach it, and naming one
//!    must not change what the shell does.
//! 2. **By text.** No compiled unit, no retained trace and no checkpoint image
//!    holds a word of the engine's own. The rows below search those bytes
//!    mechanically. Each search is validated in the same run by a marker that
//!    *is* in the operand: a search that finds nothing because it is looking in
//!    the wrong place fails here.
//!
//! What the shell reports for such a command is the operand's own text,
//! rendered as `set -x` renders a word list — a zero-length word as `''`.
#![cfg(unix)]

use std::{
	collections::HashMap,
	sync::{Arc, Mutex},
	task::Waker,
};

use pi_shell::{
	Shell, ShellOptions, ShellRunOptions,
	bash::{
		Budget, CallOutcome, Cx, Engine, EngineConfig, Event, EventData, EventMask, EventSink,
		MemStore, Script, Shell as BashShell, Step, trace::RunTrace,
	},
	cancel::CancelToken,
	testkit::{FakeHost, fault::skeleton_init},
	tools::{SpawnLog, ToolCalls, ToolConfig},
};

/// Words the engine has used, or could be tempted to use, for the command
/// it runs an operand with. None of them may appear in anything a user or
/// a tool can read back, and naming one may not change what runs.
const ENGINE_WORDS: &[&str] = &["__pi_callout", "__pi_launch", "__pi_carrier"];

/// Runs `script` in a fresh shell and a fresh directory, returning
/// everything it wrote to the caller's fds.
async fn output(script: &str) -> String {
	let shell = Shell::new(Some(ShellOptions {
		session_env: Some(HashMap::from([
			("PI_DISABLE_NOHUP_BUILTIN".into(), "0".into()),
			("PI_DISABLE_UUTILS_BUILTINS".into(), "0".into()),
		])),
		..Default::default()
	}));
	let dir = tempfile::tempdir().expect("tempdir");
	let (tx, rx) = flume::unbounded::<String>();
	shell
		.run(
			ShellRunOptions {
				command: script.into(),
				cwd: Some(dir.path().to_string_lossy().into_owned()),
				timeout_ms: Some(30_000),
				..Default::default()
			},
			Some(tx),
			CancelToken::new(None),
		)
		.await
		.expect("shell execution");
	rx.drain().collect()
}

/// Reports every `(script, expected output)` row that does not match.
async fn assert_rows(rows: &[(&str, &str)]) {
	let mut mismatches = Vec::new();
	for &(script, want) in rows {
		let got = output(script).await;
		if got != want {
			mismatches.push(format!("`{script}`: want {want:?}, got {got:?}"));
		}
	}
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// Runs the same script with each of `names` substituted for `NAME`, and
/// reports the names whose output differs from a plain identifier's.
///
/// A name the engine uses for itself must be as uninteresting to the
/// shell as any other identifier. The chosen name is masked out of both
/// outputs before they are compared, so a diagnostic that quotes it back
/// ("command not found") is not a difference and anything else is. This
/// compares head against head, so no reference output is written down.
async fn assert_name_blind(template: &str, names: &[&str]) {
	let plain = "zz_plain_helper";
	let baseline = output(&template.replace("NAME", plain))
		.await
		.replace(plain, "<NAME>");
	let mut differ = Vec::new();
	for name in names {
		let got = output(&template.replace("NAME", name))
			.await
			.replace(name, "<NAME>");
		if got != baseline {
			differ.push(format!("`{name}`: {got:?} against {baseline:?}"));
		}
	}
	assert!(
		differ.is_empty(),
		"naming an engine word changed what ran (template `{template}`):\n{}",
		differ.join("\n")
	);
}

/// A DEBUG trap whose action calls a function named like the engine's own
/// command must not take the operand's launch: the operand runs once, at
/// its own command, and the trap's function is just a function.
#[tokio::test]
async fn a_debug_trap_named_like_the_engine_cannot_take_the_launch() {
	assert_name_blind(
		"NAME(){ printf 'TRAP\\n'; }\nset -T\ntrap 'NAME' DEBUG\ntimeout 3 printf \
		 'OPERAND\\n'\nprintf 'rc=%s\\n' \"$?\"",
		ENGINE_WORDS,
	)
	.await;
}

/// The same with no such function defined: the trap's command is not
/// found, which must cost the callout neither its operand nor its status.
#[tokio::test]
async fn a_debug_trap_naming_the_engine_does_not_change_the_callouts_status() {
	assert_name_blind(
		"set -T\ntrap 'NAME' DEBUG 2>/dev/null\ntimeout 3 printf 'OPERAND\\n' 2>/dev/null\nprintf \
		 'rc=%s\\n' \"$?\"",
		ENGINE_WORDS,
	)
	.await;
}

/// A function of the name, with no trap at all, is equally uninteresting —
/// at every callout shape, including the one that `exec`s its operand.
#[tokio::test]
async fn a_function_named_like_the_engine_never_runs_in_place_of_an_operand() {
	for template in [
		"NAME(){ printf 'TAKEN\\n'; }\ntimeout 3 printf 'OPERAND\\n'",
		"NAME(){ printf 'TAKEN\\n'; }\nnohup printf 'OPERAND\\n' 2>/dev/null",
		"NAME(){ printf 'TAKEN\\n'; }\nprintf 'A\\n' | xargs printf 'OPERAND:%s\\n'",
		"NAME(){ printf 'TAKEN\\n'; }\nenv FOO=1 printf 'OPERAND\\n'",
		"NAME(){ printf 'TAKEN\\n'; }\nenv -i printf 'OPERAND\\n' 2>/dev/null",
	] {
		assert_name_blind(template, ENGINE_WORDS).await;
	}
}

/// The text the shell reports for a callout's operand is the operand's own
/// word list as `set -x` prints it: a zero-length word is `''`, not
/// nothing at all. Dropping it made `$BASH_COMMAND` name a command the
/// shell never ran.
#[tokio::test]
async fn the_reported_command_keeps_a_zero_length_word() {
	assert_rows(&[
		(
			"set -T\ntrap 'printf \"CMD=<%s>\\n\" \"$BASH_COMMAND\"' DEBUG\ntimeout 3 printf \
			 '[%s]\\n' ''",
			"CMD=<timeout 3 printf '[%s]\\n' ''>\nCMD=<printf '[%s]\\n' ''>\n[]\n",
		),
		(
			"set -T\ntrap 'printf \"CMD=<%s>\\n\" \"$BASH_COMMAND\"' DEBUG\ntimeout 3 printf \
			 '%s|%s|%s\\n' a '' b",
			"CMD=<timeout 3 printf '%s|%s|%s\\n' a '' b>\nCMD=<printf '%s|%s|%s\\n' a '' b>\na||b\n",
		),
	])
	.await;
}

/// `set -x` prints the operand's own words, and nothing else.
#[tokio::test]
async fn xtrace_shows_the_operand_and_no_word_of_the_engines() {
	let got = output("set -x\ntimeout 3 printf 'OPERAND:%s\\n' ''\n").await;
	assert!(got.contains("OPERAND:"), "the operand ran: {got:?}");
	for word in ENGINE_WORDS {
		assert!(!got.contains(word), "`{word}` reached an xtrace line: {got:?}");
	}
	assert!(got.contains("printf 'OPERAND:%s\\n' ''"), "the empty word is shown: {got:?}");
}

/// Everything the retained trace of a matrix of callouts holds, searched
/// for a word of the engine's own.
///
/// The marker assertion is the control: it proves the haystack is the
/// bytes a consumer really reads.
#[tokio::test]
async fn no_retained_trace_of_a_callout_matrix_holds_an_engine_word() {
	let script = "\
__pi_callout(){ printf 'FUNC\\n'; }
shopt -s expand_aliases
alias __pi_callout='printf ALIAS\\n'
set -T
trap '__pi_callout' DEBUG
timeout 3 printf 'OPERAND-MARKER-A\\n'
nohup printf 'OPERAND-MARKER-B\\n' 2>/dev/null
printf 'x\\n' | xargs printf 'OPERAND-MARKER-C:%s\\n'
env FOO=1 printf 'OPERAND-MARKER-D\\n'
env -i printf 'OPERAND-MARKER-E\\n' 2>/dev/null
timeout 3 printf '[%s]OPERAND-MARKER-F\\n' ''
";
	let shell = Shell::new(Some(ShellOptions {
		session_env: Some(HashMap::from([
			("PI_DISABLE_NOHUP_BUILTIN".into(), "0".into()),
			("PI_DISABLE_UUTILS_BUILTINS".into(), "0".into()),
		])),
		..Default::default()
	}));
	let dir = tempfile::tempdir().expect("tempdir");
	let trace = Arc::new(RunTrace::new(script));
	let (tx, rx) = flume::unbounded::<String>();
	shell
		.run(
			ShellRunOptions {
				command: script.into(),
				cwd: Some(dir.path().to_string_lossy().into_owned()),
				timeout_ms: Some(60_000),
				trace: Some(Arc::clone(&trace)),
				..Default::default()
			},
			Some(tx),
			CancelToken::new(None),
		)
		.await
		.expect("shell execution");
	let out: String = rx.drain().collect();
	let json = trace.snapshot_json();
	// Control: the search looks at bytes that really carry the operands.
	for marker in ["A", "B", "C", "D", "E", "F"] {
		assert!(out.contains(&format!("OPERAND-MARKER-{marker}")), "operand {marker} ran: {out:?}");
	}
	assert!(json.contains("OPERAND-MARKER-A"), "the trace carries the operands it is searched for");
	// The user wrote `__pi_callout` here, as an alias and a function, so
	// the source of *their* commands holds it; the engine's own command
	// must hold nothing. Every unit the trace kept is checked by source.
	let snapshot: serde_json::Value = serde_json::from_str(&json).expect("trace snapshot is JSON");
	let units = snapshot["units"].as_array().expect("units");
	let engine_units: Vec<&serde_json::Value> = units
		.iter()
		.filter(|u| {
			let src = u["source"].as_str().unwrap_or_default();
			!script.contains(src) || src.is_empty()
		})
		.collect();
	for unit in engine_units {
		let src = unit["source"].as_str().unwrap_or_default();
		for word in ENGINE_WORDS {
			assert!(!src.contains(word), "a unit the user never wrote holds `{word}`: {unit}");
		}
	}
}

/// What the engine compiled, and what it checkpointed, while a script
/// that uses `helper` as a function name and as a DEBUG trap action ran
/// two callouts.
///
/// Returns every compiled unit's source bytes, the externalized store,
/// and what the operands wrote.
fn engine_view(helper: &str) -> (Vec<Vec<u8>>, Vec<u8>, Vec<u8>) {
	/// Collects the source bytes of every unit the engine compiles.
	struct Sources(Mutex<Vec<Vec<u8>>>);

	impl EventSink for Sources {
		fn mask(&self) -> EventMask {
			EventMask::ALL
		}

		fn event(&self, e: &Event<'_>) {
			if let EventData::UnitCompiled(cu) = &e.data {
				self.0.lock().expect("lock").push(cu.unit.source.to_vec());
			}
		}
	}

	let sources = Arc::new(Sources(Mutex::new(Vec::new())));
	let mut host = FakeHost::new().with_event_sink(Arc::clone(&sources) as Arc<dyn EventSink>);
	// `FakeHost` resolves tool names by table position; `timeout` is 1.
	host.tool("unused", Arc::new(|_, _| CallOutcome::Exit(99)));
	host.tool("timeout", Arc::new(|_, _| CallOutcome::Exit(99)));
	let mut store = MemStore::new();
	let engine = Engine::new(EngineConfig::default());
	let mut shell = BashShell::create(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		skeleton_init(&[]),
	)
	.expect("shell");
	shell.set_event_mask(EventMask::ALL);
	let script = format!(
		"{helper}(){{ printf 'FUNC'; }}; set -T; trap '{helper}' DEBUG; timeout 5 printf \
		 'OPERAND-MARKER'; timeout 5 printf '[%s]' ''"
	);
	let run = shell.submit(Script::command(script.into_bytes()));
	let mut tools =
		ToolCalls::new(ToolConfig::default(), SpawnLog::default(), Waker::noop().clone());
	let mut turns = 0usize;
	loop {
		turns += 1;
		assert!(turns < 5_000_000, "the run makes progress");
		let step = shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget {
			max_ops: 1,
			max_ns:  u64::MAX,
		});
		let done = match step {
			Step::Call { id, call } => {
				tools.on_call(&mut shell, &mut Cx { host: &mut host, store: &mut store }, id, call);
				false
			},
			Step::Done { run: id, status } => {
				tools.on_done(id, status, None);
				id == run
			},
			Step::Idle => panic!("idle before the root finished"),
			_ => false,
		};
		tools.poll(&mut shell, &mut Cx { host: &mut host, store: &mut store });
		host.events.clear();
		if done {
			break;
		}
	}
	let out = host.stdout.bytes().to_vec();
	shell
		.externalize(&mut Cx { host: &mut host, store: &mut store })
		.expect("externalize");
	let compiled = sources.0.lock().expect("lock").clone();
	(compiled, store.to_bytes(), out)
}

/// Every unit the engine compiled while callouts ran, and the checkpoint
/// image written from them, hold a word of the engine's own exactly as
/// often as they hold any other identifier the caller chose: never more.
///
/// The comparison is the search's control. A caller who names a function
/// and a DEBUG trap action `__pi_callout` puts that word into their own
/// function record, their own trap text and their own compiled source, so
/// an absolute count would mean nothing. Running the same script with a
/// plain identifier and comparing leaves exactly what the engine added,
/// which must be nothing. The marker proves the search reads the bytes
/// the run really produced.
#[test]
fn no_compiled_unit_or_checkpoint_image_holds_an_engine_word() {
	let plain = "zz_plain_helper";
	let (plain_units, plain_image, plain_out) = engine_view(plain);
	assert!(
		String::from_utf8_lossy(&plain_out).contains("OPERAND-MARKER"),
		"the operand ran: {:?}",
		String::from_utf8_lossy(&plain_out)
	);
	assert!(
		plain_units
			.iter()
			.any(|s| s.windows(6).any(|w| w == b"printf")),
		"the search sees the units the user wrote"
	);
	let count = |haystack: &[u8], needle: &str| {
		haystack
			.windows(needle.len())
			.filter(|w| *w == needle.as_bytes())
			.count()
	};
	let plain_in_units: usize = plain_units.iter().map(|s| count(s, plain)).sum();
	let plain_in_image = count(&plain_image, plain);
	assert!(plain_in_units > 0 && plain_in_image > 0, "the control name is found at all");
	for word in ENGINE_WORDS {
		let (units, image, out) = engine_view(word);
		assert!(
			String::from_utf8_lossy(&out).contains("OPERAND-MARKER"),
			"the operand ran under `{word}`"
		);
		let in_units: usize = units.iter().map(|s| count(s, word)).sum();
		assert_eq!(
			in_units, plain_in_units,
			"compiled units hold `{word}` {in_units} times against {plain_in_units} for a plain \
			 identifier: the extra ones are the engine's"
		);
		let in_image = count(&image, word);
		assert_eq!(
			in_image, plain_in_image,
			"the checkpoint image holds `{word}` {in_image} times against {plain_in_image} for a \
			 plain identifier: the extra ones are the engine's"
		);
	}
}
