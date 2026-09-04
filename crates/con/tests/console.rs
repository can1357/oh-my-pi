//! Contract tests for the console: dispatch, typing, permissions, scripts,
//! binds/actions, persistence, replication, and completion.

use std::sync::{
	Arc,
	atomic::{AtomicI64, Ordering},
};

use omp_con::{
	ConError, Ctx, DumpOptions, DynamicCmdSpec, DynamicVarSpec, Kv, Role, Severity, Span, TypeSpec,
	Value, VarFlags, con_enum,
};
use omp_core::Str;
use parking_lot::Mutex;

#[derive(
	Clone, Copy, Debug, Eq, PartialEq, strum::EnumString, strum::IntoStaticStr, strum::VariantNames,
)]
#[strum(serialize_all = "lowercase")]
enum Difficulty {
	Easy,
	Normal,
	Hard,
}
con_enum!(Difficulty);

/// `(old * 1000 + new)` of the last `test::tracked` change, `-1` when unfired.
static LAST_TRACKED: AtomicI64 = AtomicI64::new(-1);

omp_con::var! {
	/// World gravity (u/s²).
	pub static GRAVITY = test::gravity: i32 {
		default: 800,
		min: 100,
		max: 2000,
		flags: archive,
		meta: {
			"ui.tab": "model",
			"legacy.path": "gravity",
			"legacy.path": "physics.gravity",
		},
	};
	/// Unsafe-gated impulse.
	pub static IMPULSE = test::impulse: i32 {
		default: 0,
		flags: unsafe,
	};
	/// Read-only build identifier.
	pub static BUILD = test::build: Str {
		default: Str::new_static("r100"),
		flags: readonly,
	};
	/// Bot difficulty.
	pub static DIFFICULTY = test::difficulty: Difficulty {
		default: Difficulty::Normal,
		flags: archive,
	};
	/// Replicated message of the day.
	pub static MOTD = test::motd: Str {
		default: Str::new_static("hi"),
		flags: replicated | archive,
	};
	/// Validated non-negative count (not archived).
	pub static COUNT = test::count: i32 {
		default: 1,
		validate: |_ctx, v| if *v < 0 { Err(Str::new_static("negative")) } else { Ok(()) },
	};
	/// Change-tracked value.
	pub static TRACKED = test::tracked: i32 {
		default: 0,
		on_change: |_ctx, old, new| {
			LAST_TRACKED.store(i64::from(*old) * 1000 + i64::from(*new), Ordering::SeqCst);
		},
	};
	/// Server tag list.
	pub static TAGS = test::tags: Vec<Str> {
		default: Vec::new(),
	};
	/// Structured spawn descriptor.
	pub static SPAWN = test::spawn: Kv {
		default: Kv::new(),
	};
	/// Boolean toggle target.
	pub static FLAG = test::flag: bool {
		default: false,
	};
	/// Archived boolean used to exercise aliases, binds, and persistence.
	pub static SHOW_THINKING = test::show_thinking: bool {
		default: true,
		flags: archive | session,
	};
	/// Map name with a custom completion group.
	pub static MAP = test::map: Str {
		default: Str::new_static(""),
		complete: "map::name",
	};
	/// Idle timeout: finite span or never.
	pub static IDLE = test::idle_timeout: Span {
		default: Span::NEVER,
		suggest: ["never", "30s", "5m"],
	};
	/// Finite-only cooldown (rejects `never`).
	pub static COOLDOWN = test::cooldown: omp_core::Duration {
		default: omp_core::Duration::new(500, omp_core::DurationUnit::Milliseconds),
	};
}

omp_con::cmd! {
	/// Adds two integers and reports the sum.
	test::add(a: i32, b: i32) = |ctx, args| {
		let a: i32 = args.get(0)?;
		let b: i32 = args.get(1)?;
		let sum = a + b;
		ctx.reply(Severity::Info, &format!("sum {sum}"));
		Ok(())
	};
}

omp_con::action! {
	/// Held jump intent.
	pub static JUMP = test::jump;
}

type Log = Arc<Mutex<Vec<(Severity, String)>>>;

fn capture_ctx() -> (Ctx, Log) {
	let log: Log = Arc::default();
	let sink = Arc::clone(&log);
	let ctx = Ctx::builder()
		.sink(move |sev, text| sink.lock().push((sev, text.to_string())))
		.build();
	(ctx, log)
}

fn logged(log: &Log) -> Vec<String> {
	log.lock().iter().map(|(_, text)| text.clone()).collect()
}

#[test]
fn static_metadata_from_var_macro_preserves_declaration_order() {
	let spec = GRAVITY.spec();
	assert_eq!(spec.meta_get("legacy.path"), Some("gravity"));
	assert_eq!(spec.meta_all("legacy.path").collect::<Vec<_>>(), ["gravity", "physics.gravity"]);
	assert_eq!(spec.meta_get("missing"), None);
}

#[test]
fn dynamic_metadata_preserves_declaration_order() {
	let spec = DynamicVarSpec {
		name:    "product::metadata".into(),
		desc:    "metadata contract".into(),
		ty:      TypeSpec::BOOL,
		flags:   VarFlags::NONE,
		default: Value::Bool(false),
		meta:    Arc::from([
			(Str::new_static("legacy.path"), Str::new_static("enabled")),
			(Str::new_static("ui.tab"), Str::new_static("tools")),
			(Str::new_static("legacy.path"), Str::new_static("active")),
		]),
	};
	assert_eq!(spec.meta_get("legacy.path"), Some("enabled"));
	assert_eq!(spec.meta_all("legacy.path").collect::<Vec<_>>(), ["enabled", "active"]);
	assert_eq!(spec.meta_get("missing"), None);
}

#[test]
fn unified_variable_inventory_exposes_declarations_and_completes_dynamic_enums() {
	let ctx = Ctx::builder().isolated().build();
	ctx.register(omp_con::RegItem::Var(GRAVITY.spec())).unwrap();
	ctx.register_dynamic_var(DynamicVarSpec {
		name:    "product::difficulty".into(),
		desc:    "Runtime difficulty".into(),
		ty:      <Difficulty as omp_con::ConType>::SPEC,
		flags:   VarFlags::ARCHIVE,
		default: Value::Enum(Str::new_static("normal")),
		meta:    Arc::from([
			(Str::new_static("ui.tab"), Str::new_static("model")),
			(Str::new_static("legacy.path"), Str::new_static("difficulty")),
		]),
	})
	.unwrap();

	let vars = ctx.vars().collect::<Vec<_>>();
	assert_eq!(vars.iter().map(|var| var.name).collect::<Vec<_>>(), [
		"test::gravity",
		"product::difficulty"
	]);
	assert_eq!(vars[0].meta_get("legacy.path"), Some("gravity"));
	assert_eq!(vars[0].meta_all("legacy.path").collect::<Vec<_>>(), ["gravity", "physics.gravity"]);
	assert_eq!(vars[0].default(), Value::Int(800));
	assert_eq!(vars[1].meta_get("legacy.path"), Some("difficulty"));
	assert_eq!(vars[1].metadata().collect::<Vec<_>>(), [
		("ui.tab", "model"),
		("legacy.path", "difficulty")
	]);
	assert_eq!(vars[1].default(), Value::Enum(Str::new_static("normal")));

	let name = "product::diff";
	assert_eq!(ctx.complete(name, name.len())[0].text.as_str(), "product::difficulty");
	let value = "product::difficulty h";
	assert_eq!(ctx.complete(value, value.len())[0].text.as_str(), "hard");
}

#[allow(
	clippy::unnecessary_wraps,
	reason = "dynamic command handlers must use the fallible DynamicCmdHandler signature"
)]
fn dynamic_record(ctx: &Ctx, name: &str, args: &[omp_con::Arg]) -> Result<(), ConError> {
	let log = ctx.user::<Log>().expect("dynamic command log");
	log.lock()
		.push((Severity::Info, format!("{name}:{}", args[0].to_script())));
	Ok(())
}

#[test]
fn owned_dynamic_command_registers_and_dispatches() {
	let log: Log = Arc::default();
	let ctx = Ctx::builder().user(Arc::clone(&log)).build();
	ctx.register_dynamic_cmd(DynamicCmdSpec {
		name:    "Product::Record".into(),
		desc:    "records one word".into(),
		handler: dynamic_record,
	})
	.unwrap();

	ctx.run("product::record hello").unwrap();
	assert_eq!(logged(&log), ["product::record:hello"]);
}

#[test]
fn set_get_and_clamp() {
	let ctx = Ctx::new();
	ctx.run("test::gravity 600").unwrap();
	assert_eq!(GRAVITY.get(&ctx), 600);
	// Out-of-range values clamp instead of erroring (Source parity).
	ctx.run("test::gravity 99999").unwrap();
	assert_eq!(GRAVITY.get(&ctx), 2000);
	ctx.run("test::gravity -5").unwrap();
	assert_eq!(GRAVITY.get(&ctx), 100);
}

#[test]
fn names_are_case_insensitive() {
	let ctx = Ctx::new();
	ctx.run("TEST::Gravity 500").unwrap();
	assert_eq!(GRAVITY.get(&ctx), 500);
}

#[test]
fn bare_var_prints_value_and_default() {
	let (ctx, log) = capture_ctx();
	ctx.run("test::gravity 700").unwrap();
	ctx.run("test::gravity").unwrap();
	let lines = logged(&log);
	assert!(
		lines
			.iter()
			.any(|l| l.contains("test::gravity = 700") && l.contains("default 800"))
	);
}

#[test]
fn enum_var_accepts_variants_and_rejects_others() {
	let ctx = Ctx::new();
	ctx.run("test::difficulty hard").unwrap();
	assert_eq!(DIFFICULTY.get(&ctx), Difficulty::Hard);
	let err = ctx.run("test::difficulty impossible").unwrap_err();
	assert!(matches!(err, ConError::InvalidVariant { .. }), "{err:?}");
}

#[test]
fn unsafe_gate_blocks_until_enabled() {
	let ctx = Ctx::new();
	let err = ctx.run("test::impulse 5").unwrap_err();
	assert!(matches!(err, ConError::UnsafeGated { .. }), "{err:?}");
	ctx.run("sv_cheats true").unwrap();
	ctx.run("test::impulse 5").unwrap();
	assert_eq!(IMPULSE.get(&ctx), 5);
}
#[test]
fn durations_parse_units_and_never() {
	let ctx = Ctx::new();
	ctx.run("test::idle_timeout 90s").unwrap();
	assert_eq!(IDLE.get(&ctx), Span::secs(90));
	assert_eq!(IDLE.get(&ctx).to_std(), Some(std::time::Duration::from_secs(90)));
	ctx.run("test::idle_timeout 1500ms").unwrap();
	assert_eq!(IDLE.get(&ctx), Span::millis(1500), "elapsed-time equality across units");
	ctx.run("test::idle_timeout never").unwrap();
	assert!(IDLE.get(&ctx).is_never());
	assert_eq!(IDLE.get(&ctx).to_std(), None);

	let err = ctx.run("test::idle_timeout 90").unwrap_err();
	assert!(matches!(err, ConError::TypeMismatch { .. }), "unit is required: {err:?}");

	// Finite-only vars reject `never` at the parse boundary.
	ctx.run("test::cooldown 2s").unwrap();
	assert_eq!(COOLDOWN.get(&ctx), omp_core::Duration::new(2, omp_core::DurationUnit::Seconds));
	let err = ctx.run("test::cooldown never").unwrap_err();
	assert!(matches!(err, ConError::TypeMismatch { .. }), "{err:?}");

	// Dump renders the span as written; the wire form is the parse form.
	ctx.set_typed("test::idle_timeout", Span::secs(30)).unwrap();
	let rendered = format!("{}", Value::Duration(Span::secs(30)));
	assert_eq!(rendered, "30s");
	let wire = serde_json::to_string(&Value::Duration(Span::NEVER)).unwrap();
	let back: Value = serde_json::from_str(&wire).unwrap();
	assert_eq!(back, Value::Duration(Span::NEVER));
}

#[test]
fn readonly_blocks_scripts_but_not_host_code() {
	let ctx = Ctx::new();
	let err = ctx.run("test::build r200").unwrap_err();
	assert!(matches!(err, ConError::ReadOnly { .. }), "{err:?}");
	BUILD.set(&ctx, Str::new_static("r300")).unwrap();
	assert_eq!(BUILD.get(&ctx).as_str(), "r300");
}

#[test]
fn validate_hook_vetoes() {
	let ctx = Ctx::new();
	let err = ctx.run("test::count -3").unwrap_err();
	assert!(matches!(&err, ConError::Invalid { .. }), "{err:?}");
	assert_eq!(COUNT.get(&ctx), 1);
}

#[test]
fn on_change_fires_with_old_and_new_but_not_on_noop() {
	let ctx = Ctx::new();
	LAST_TRACKED.store(-1, Ordering::SeqCst);
	ctx.run("test::tracked 7").unwrap();
	assert_eq!(LAST_TRACKED.load(Ordering::SeqCst), 7);
	LAST_TRACKED.store(-1, Ordering::SeqCst);
	ctx.run("test::tracked 7").unwrap();
	assert_eq!(LAST_TRACKED.load(Ordering::SeqCst), -1, "same-value set must not fire on_change");
	ctx.run("test::tracked 9").unwrap();
	assert_eq!(LAST_TRACKED.load(Ordering::SeqCst), 7009);
}

#[test]
fn script_language_quotes_comments_separators() {
	let (ctx, log) = capture_ctx();
	ctx.run(
		"echo \"hello world\"; test::gravity 400 // trailing comment\necho \"line\\nbreak\"\necho \
		 wss://relay.example/room",
	)
	.unwrap();
	assert_eq!(GRAVITY.get(&ctx), 400);
	let lines = logged(&log);
	assert!(lines.contains(&"hello world".to_string()));
	assert!(lines.contains(&"line\nbreak".to_string()));
	assert!(lines.contains(&"wss://relay.example/room".to_string()));
}

#[test]
fn list_var_absorbs_trailing_args_and_literals() {
	let ctx = Ctx::new();
	ctx.run("test::tags pvp coop hardcore").unwrap();
	let tags: Vec<Str> = TAGS.get(&ctx);
	assert_eq!(tags.len(), 3);
	assert_eq!(tags[1].as_str(), "coop");
	ctx.run("test::tags [solo duo]").unwrap();
	assert_eq!(TAGS.get(&ctx).len(), 2);
}

#[test]
fn kv_block_parses_across_lines_with_inference() {
	let ctx = Ctx::new();
	ctx.run(
		"test::spawn {\n\torigin [1 2 3]\n\tname \"the \\\"boss\\\"\"\n\thp 100\n\tboss true\n}",
	)
	.unwrap();
	let spawn = SPAWN.get(&ctx);
	assert_eq!(spawn.get("hp"), Some(&Value::Int(100)));
	assert_eq!(spawn.get("boss"), Some(&Value::Bool(true)));
	assert_eq!(spawn.get("name"), Some(&Value::Str(Str::new_static("the \"boss\""))));
	let Some(Value::List(origin)) = spawn.get("origin") else {
		panic!("origin must parse as a list");
	};
	assert_eq!(origin.as_slice(), &[Value::Int(1), Value::Int(2), Value::Int(3)]);
}

#[test]
fn command_args_typed_and_required() {
	let (ctx, log) = capture_ctx();
	ctx.run("test::add 2 40").unwrap();
	assert!(logged(&log).contains(&"sum 42".to_string()));
	let err = ctx.run("test::add 2").unwrap_err();
	assert!(matches!(&err, ConError::MissingArg { arg, .. } if arg.as_str() == "b"), "{err:?}");
	let err = ctx.run("test::add 2 x").unwrap_err();
	assert!(matches!(err, ConError::TypeMismatch { .. }), "{err:?}");
}

#[test]
fn alias_defines_expands_and_caps_recursion() {
	let (ctx, log) = capture_ctx();
	ctx.run("alias greet \"echo hello; echo again\"").unwrap();
	ctx.run("greet").unwrap();
	let lines = logged(&log);
	assert!(lines.contains(&"hello".to_string()));
	assert!(lines.contains(&"again".to_string()));

	ctx.set_alias("ouroboros", "ouroboros").unwrap();
	let err = ctx.run("ouroboros").unwrap_err();
	assert!(matches!(err, ConError::Recursion { .. }), "{err:?}");

	// Aliases cannot shadow registered items.
	let err = ctx.set_alias("echo", "echo no").unwrap_err();
	assert!(matches!(err, ConError::Duplicate { .. }), "{err:?}");
}

#[test]
fn binds_drive_actions_with_press_release_inversion() {
	let ctx = Ctx::new();
	ctx.run("bind space \"+test::jump; test::gravity 300\"")
		.unwrap();
	ctx.run("bind w +test::jump").unwrap();

	ctx.key("space", true).unwrap();
	assert!(JUMP.is_active(&ctx));
	assert_eq!(GRAVITY.get(&ctx), 300, "non-action statements run on press");
	ctx.key("space", true).unwrap();
	assert_eq!(JUMP.presses(&ctx), 1, "terminal repeats are not fresh press edges");

	ctx.key("w", true).unwrap();
	assert_eq!(JUMP.presses(&ctx), 2, "two keys can hold one action");
	ctx.key("space", false).unwrap();
	assert!(JUMP.is_active(&ctx), "still held by the other key");
	ctx.key("w", false).unwrap();
	assert!(!JUMP.is_active(&ctx));

	ctx.run(
		"test::show_thinking 0; alias +peek \"test::show_thinking 1\"; alias -peek \
		 \"test::show_thinking 0\"; bind h +peek",
	)
	.unwrap();
	ctx.key("h", true).unwrap();
	assert!(SHOW_THINKING.get(&ctx));
	ctx.key("h", false).unwrap();
	assert!(!SHOW_THINKING.get(&ctx));
}

#[test]
fn ordinary_bind_remaps_apply_without_a_release_capable_terminal() {
	let ctx = Ctx::new();
	ctx.run("bind g \"test::gravity 200\"").unwrap();
	ctx.key("g", true).unwrap();
	assert_eq!(GRAVITY.get(&ctx), 200);
	ctx.run("bind g \"test::gravity 350\"").unwrap();
	ctx.key("g", true).unwrap();
	assert_eq!(
		GRAVITY.get(&ctx),
		350,
		"ordinary bind presses are not latched when terminals cannot report releases"
	);
}

#[test]
fn held_action_release_survives_live_remap_and_removal() {
	let ctx = Ctx::new();
	ctx.run("bind h +test::jump").unwrap();
	ctx.key("h", true).unwrap();
	assert!(JUMP.is_active(&ctx));

	ctx.run("bind h \"test::gravity 450\"").unwrap();
	ctx.key("h", false).unwrap();
	assert!(!JUMP.is_active(&ctx), "release belongs to the program latched at press");
	assert_eq!(GRAVITY.get(&ctx), 800, "the replacement waits for the next press");

	ctx.key("h", true).unwrap();
	assert_eq!(GRAVITY.get(&ctx), 450);
	ctx.run("unbind h").unwrap();
	ctx.key("h", false).unwrap();
	assert_eq!(JUMP.presses(&ctx), 0);
}

#[test]
fn dump_is_a_replayable_diff_including_aliases_and_binds() {
	let ctx = Ctx::new();
	ctx.run("test::gravity 600").unwrap();
	ctx.run("test::difficulty hard").unwrap();
	ctx.set_typed("test::count", 5).unwrap(); // not archived → must not persist
	ctx.run("alias greet \"echo hi\"").unwrap();
	ctx.run("bind f +test::jump").unwrap();

	let script = ctx.dump_with_options(DumpOptions::default());
	assert!(!script.as_str().contains("test::count"), "non-archive vars stay out of the dump");
	assert!(!script.as_str().contains("test::motd"), "vars at default stay out of the dump");

	let fresh = Ctx::new();
	let outcome = fresh.exec_lenient(script);
	assert_eq!(outcome.failed, 0);
	assert_eq!(GRAVITY.get(&fresh), 600);
	assert_eq!(DIFFICULTY.get(&fresh), Difficulty::Hard);
	assert_eq!(COUNT.get(&fresh), 1);
	assert!(
		fresh
			.aliases()
			.iter()
			.any(|(n, b)| n.as_str() == "greet" && b.as_str() == "echo hi")
	);
	assert!(
		fresh
			.binds()
			.iter()
			.any(|(k, s)| k.as_str() == "f" && s.as_str() == "+test::jump")
	);
}

#[test]
fn dynamic_registration_uses_explicit_default_for_diff_dump() {
	let ctx = Ctx::new();
	ctx.register_dynamic_var(DynamicVarSpec {
		name:    "product::unchanged".into(),
		desc:    "unchanged".into(),
		ty:      TypeSpec::INT,
		flags:   VarFlags::ARCHIVE,
		meta:    Arc::from([]),
		default: Value::Int(7),
	})
	.unwrap();
	ctx.register_dynamic_var(DynamicVarSpec {
		name:    "product::changed".into(),
		desc:    "changed".into(),
		ty:      TypeSpec::INT,
		flags:   VarFlags::ARCHIVE,
		meta:    Arc::from([]),
		default: Value::Int(9),
	})
	.unwrap();
	ctx.set_value("product::changed", Value::Int(10), omp_con::SetSource::Code)
		.unwrap();

	let dump = ctx.dump_with_options(DumpOptions::default());
	assert!(!dump.as_str().contains("product::unchanged"));
	assert!(dump.as_str().contains("product::changed 10"));
	ctx.reset("product::changed").unwrap();
	assert_eq!(ctx.value("product::changed").unwrap(), Value::Int(9));
}

#[test]
fn replication_drains_applies_and_locks_replicas() {
	let authority = Ctx::builder().role(Role::Authority).build();
	authority
		.set_typed("test::motd", Str::new_static("welcome"))
		.unwrap();

	let patches = authority.drain_replication();
	assert!(
		patches
			.iter()
			.any(|p| p.name.as_str() == "test::motd"
				&& p.value == Value::Str(Str::new_static("welcome"))),
		"{patches:?}"
	);
	assert!(authority.drain_replication().is_empty(), "drain consumes dirty bits");

	// Wire contract: patches serialize/deserialize losslessly.
	let wire = serde_json::to_string(&patches).unwrap();
	let patches: Vec<omp_con::Patch> = serde_json::from_str(&wire).unwrap();

	let replica = omp_con::Replica::new();
	let err = replica.run("test::motd hacked").unwrap_err();
	assert!(matches!(err, ConError::ReplicatedWrite { .. }), "{err:?}");
	replica.apply(patches).unwrap();
	assert_eq!(MOTD.get(replica.context()).as_str(), "welcome");

	let err = authority.apply_replication(Vec::new()).unwrap_err();
	assert!(matches!(err, ConError::RoleMismatch { .. }), "{err:?}");
}

#[test]
fn toggle_flips_bools_and_cycles_enums() {
	let ctx = Ctx::new();
	ctx.run("toggle test::flag").unwrap();
	assert!(FLAG.get(&ctx));
	ctx.run("toggle test::flag").unwrap();
	assert!(!FLAG.get(&ctx));

	assert_eq!(DIFFICULTY.get(&ctx), Difficulty::Normal);
	ctx.run("toggle test::difficulty").unwrap();
	assert_eq!(DIFFICULTY.get(&ctx), Difficulty::Hard);
	ctx.run("toggle test::difficulty").unwrap();
	assert_eq!(DIFFICULTY.get(&ctx), Difficulty::Easy, "cycles wrap");

	ctx.run("toggle test::gravity 400 800").unwrap();
	assert_eq!(GRAVITY.get(&ctx), 400);
	ctx.run("toggle test::gravity 400 800").unwrap();
	assert_eq!(GRAVITY.get(&ctx), 800);
}

#[test]
fn exec_uses_loader_and_writecfg_uses_saver() {
	let saved: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
	let saved_in = Arc::clone(&saved);
	let ctx = Ctx::builder()
		.loader(|name| Ok((name == "autoexec").then(|| Str::new_static("test::gravity 300"))))
		.saver(move |name, contents| {
			saved_in
				.lock()
				.push((name.to_string(), contents.to_string()));
			Ok(())
		})
		.build();

	ctx.run("exec autoexec").unwrap();
	assert_eq!(GRAVITY.get(&ctx), 300);
	let err = ctx.run("exec nonexistent").unwrap_err();
	assert!(matches!(err, ConError::MissingCfg { .. }), "{err:?}");

	ctx.run("test::show_thinking true").unwrap();
	ctx.run("writecfg backup").unwrap();
	let saved = saved.lock();
	assert_eq!(saved.len(), 1);
	assert_eq!(saved[0].0, "backup");
	assert!(saved[0].1.contains("test::gravity 300"));
	assert!(
		saved[0].1.contains("test::show_thinking true"),
		"explicit defaults survive future schema-default changes"
	);

	let bare = Ctx::new();
	let err = bare.run("writecfg").unwrap_err();
	assert!(matches!(err, ConError::NoSaver), "{err:?}");
}
#[test]
fn settings_selected_scripts_apply_in_declared_order() {
	let ctx = Ctx::builder()
		.loader(|name| {
			Ok(match name {
				"base" => Some(Str::new_static("test::gravity 400")),
				"project" => Some(Str::new_static("unknown::setting 1; test::gravity 650")),
				"runtime" => Some(Str::new_static("test::gravity 900")),
				_ => None,
			})
		})
		.build();

	let outcome = ctx.exec_named_configs(["base", "project", "runtime"]);
	assert_eq!((outcome.ran, outcome.failed), (3, 1));
	assert_eq!(GRAVITY.get(&ctx), 900);
}

#[test]
fn lenient_exec_reports_and_continues() {
	let (ctx, log) = capture_ctx();
	let outcome = ctx.exec_lenient("bogus::name 1; test::gravity 500");
	assert_eq!((outcome.ran, outcome.failed), (1, 1));
	assert_eq!(GRAVITY.get(&ctx), 500);
	assert!(
		log.lock()
			.iter()
			.any(|(sev, text)| *sev == Severity::Error && text.contains("bogus"))
	);
}

#[test]
fn completion_names_values_and_providers() {
	let ctx = Ctx::new();

	let names: Vec<_> = ctx
		.complete("test::gr", 8)
		.into_iter()
		.map(|s| s.text.to_string())
		.collect();
	assert!(names.contains(&"test::gravity".to_string()), "{names:?}");

	let variants: Vec<_> = ctx
		.complete("test::difficulty ", 17)
		.into_iter()
		.map(|s| s.text.to_string())
		.collect();
	assert_eq!(variants, ["easy", "hard", "normal"], "enum variants auto-complete");
	let filtered = ctx.complete("test::difficulty h", 18);
	assert_eq!(filtered.len(), 1);
	assert_eq!(filtered[0].text.as_str(), "hard");

	let bools: Vec<_> = ctx
		.complete("sv_cheats t", 11)
		.into_iter()
		.map(|s| s.text.to_string())
		.collect();
	assert_eq!(bools, ["true"]);

	ctx.register_completer("map::name", |_, prefix| {
		["de_dust", "de_nuke", "cs_office"]
			.into_iter()
			.filter(|m| m.starts_with(prefix))
			.map(|m| omp_con::Suggestion::bare(Str::new_static(m)))
			.collect()
	});
	let maps: Vec<_> = ctx
		.complete("test::map de_", 13)
		.into_iter()
		.map(|s| s.text.to_string())
		.collect();
	assert_eq!(maps, ["de_dust", "de_nuke"], "custom provider group drives string completion");

	// Signed action completion.
	let actions: Vec<_> = ctx
		.complete("+test::j", 8)
		.into_iter()
		.map(|s| s.text.to_string())
		.collect();
	assert!(actions.contains(&"+test::jump".to_string()), "{actions:?}");

	// bind's script argument recursively completes names.
	let bound: Vec<_> = ctx
		.complete("bind f test::gra", 16)
		.into_iter()
		.map(|s| s.text.to_string())
		.collect();
	assert!(bound.contains(&"test::gravity".to_string()), "{bound:?}");
}
