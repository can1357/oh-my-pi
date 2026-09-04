//! Config-order and session-tree integration contracts.

use omp_con::{Ctx, Origin, Source, Value};
use omp_core::Str;
use omp_session::{
	ComponentRegistry, Session,
	components::con::{ConWrite, con_write_txn, con_writes},
};

omp_con::var! {
	/// Session-persisted boolean used by cfg layering tests.
	pub static CFG_FASTMODE = test_cfg_fastmode: bool {
		default: false,
		flags: archive | session,
	};
	/// Session-persisted string used by profile cfg tests.
	pub static CFG_THINKING = test_cfg_thinking: Str {
		default: Str::new_static("high"),
		flags: archive | session,
	};
	/// Archived presentation-like value used by dump tests.
	pub static CFG_THEME = test_cfg_theme: Str {
		default: Str::new_static("default"),
		flags: archive | session,
	};
	/// Archived toggle named by a persisted bind.
	pub static CFG_SHOW_THINKING = test_cfg_show_thinking: bool {
		default: true,
		flags: archive | session,
	};
}

struct Loader;

impl omp_con::CfgLoader for Loader {
	fn load(&self, name: &str) -> omp_con::ConResult<Option<Str>> {
		Ok(match name {
			"config.cfg" => Some(Str::new_static("test_cfg_fastmode 1")),
			"subagent.cfg" => Some(Str::new_static("test_cfg_fastmode 0")),
			"sonic.cfg" => Some(Str::new_static("test_cfg_thinking low")),
			_ => None,
		})
	}
}

#[test]
fn session_var_round_trips_through_journal() {
	let directory = tempfile::tempdir().unwrap();
	let path = directory.path().join("session.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).unwrap();
	let ctx = Ctx::new();
	ctx.run("test_cfg_fastmode 1").unwrap();
	for (name, value) in ctx.session_writes() {
		let write =
			ConWrite { name, value: value.to_string().into(), origin: Str::new_static("session") };
		let txn = con_write_txn(session.dom(), session.head().unwrap(), &write).unwrap();
		session.patch(txn).unwrap();
	}
	drop(session);

	let restored_session = Session::open(&path, ComponentRegistry::standard()).unwrap();
	let restored = Ctx::new();
	for write in con_writes(restored_session.dom()) {
		restored
			.restore_session_write(write.name.as_str(), write.value.as_str())
			.unwrap();
	}
	assert_eq!(restored.get("test_cfg_fastmode"), Some(Value::Bool(true)));
}

#[test]
fn subagent_cfg_seeds_child_without_touching_parent() {
	let parent = Ctx::new();
	parent.run("test_cfg_fastmode 1").unwrap();
	let child = Ctx::new();
	for (name, value) in parent.seed_child().into_values() {
		child.set(name.as_str(), value, Origin::Session).unwrap();
	}
	let outcome = child.exec_configs(&Loader, Some("sonic")).unwrap();
	assert_eq!(outcome.failed, 0);
	assert_eq!(child.get("test_cfg_fastmode"), Some(Value::Bool(false)));
	assert_eq!(child.get("test_cfg_thinking"), Some(Value::Str(Str::new_static("low"))));
	assert_eq!(parent.get("test_cfg_fastmode"), Some(Value::Bool(true)));
}

#[test]
fn config_cfg_dump_reloads_identically() {
	let original = Ctx::new();
	original
		.exec(
			"test_cfg_fastmode 1; test_cfg_theme cyanotype",
			Source::Config(Str::new_static("config.cfg")),
		)
		.unwrap();
	original
		.run("alias fast \"test_cfg_fastmode 1\"; bind ctrl+t \"toggle test_cfg_show_thinking\"")
		.unwrap();
	let dump = original.dump();
	let restored = Ctx::new();
	restored
		.exec(dump.as_str(), Source::Config(Str::new_static("config.cfg")))
		.unwrap();
	assert_eq!(restored.get("test_cfg_fastmode"), original.get("test_cfg_fastmode"));
	assert_eq!(restored.get("test_cfg_theme"), original.get("test_cfg_theme"));
	assert_eq!(restored.aliases(), original.aliases());
	assert_eq!(restored.binds(), original.binds());
}

/// A cfg written by an older build may name variables this build no longer
/// declares; startup must keep the rest of the file and report the skip.
struct StaleLoader;

impl omp_con::CfgLoader for StaleLoader {
	fn load(&self, name: &str) -> omp_con::ConResult<Option<Str>> {
		Ok((name == "config.cfg").then(|| {
			Str::new_static(
				"test_cfg_fastmode 1\ntest_cfg_retired_from_an_older_build medium\ntest_cfg_theme \
				 cyanotype",
			)
		}))
	}
}

#[test]
fn stale_config_cfg_lines_are_skipped_not_fatal() {
	let ctx = Ctx::new();
	let outcome = ctx.exec_configs(&StaleLoader, None).unwrap();
	assert_eq!(outcome.failed, 1);
	assert_eq!(outcome.ran, 2);
	assert_eq!(ctx.get("test_cfg_fastmode"), Some(Value::Bool(true)));
	assert_eq!(ctx.get("test_cfg_theme"), Some(Value::Str(Str::new_static("cyanotype"))));
}
