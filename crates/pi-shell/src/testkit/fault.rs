//! The fault injector.
//!
//! At every k-th safepoint it pauses and resumes, or externalizes, drops the
//! shell and restores into a fresh engine and store image; or, at every
//! safepoint, it pauses and resumes with a seeded probability (obash's
//! `--fault-mode=pause`). The oracle is that output, status and
//! events equal those of the unfaulted run.

use std::sync::Arc;

use bstr::BString;
use serde_json::Value;

use crate::{
	bash::{
		Budget, Cx, Engine, EngineConfig, MemStore, RestoreOpts, Script, Shell, ShellInit, Step,
	},
	testkit::{
		host::FakeHost,
		rng::Rng,
		run::{Stop, advance, advance_or_blocked},
	},
};

/// What to do at every k-th safepoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
	/// Nothing.
	None,
	/// `pause()` (one `Paused` step), then `resume()`.
	PauseResume {
		/// k.
		every: u32,
	},
	/// `request_suspend` → `SuspendReady` → `externalize` → drop the shell
	/// → serialize the store → new engine and store from the image →
	/// `restore`, as a new process would.
	Snapshot {
		/// k.
		every: u32,
	},
	/// A seeded coin decides between the two at each point.
	Mixed {
		/// k.
		every: u32,
		/// Seed of the coin.
		seed:  u64,
	},
	/// At every safepoint (one op per step), pause/resume with probability
	/// 1/`one_in`, decided by a coin seeded with `seed`.
	RandomPause {
		/// The inverse probability (50 in the pause/resume gate).
		one_in: u32,
		/// Seed of the coin.
		seed:   u64,
	},
}

impl Fault {
	const fn budget(self) -> Budget {
		let max_ops = match self {
			Self::None => 20_000,
			Self::PauseResume { every } | Self::Snapshot { every } | Self::Mixed { every, .. } => {
				every
			},
			Self::RandomPause { .. } => 1,
		};
		Budget { max_ops: if max_ops == 0 { 1 } else { max_ops }, max_ns: u64::MAX }
	}
}

/// A shell with its host, store and engine, which survives snapshots.
pub struct Rig {
	cfg:           EngineConfig,
	engine:        Arc<Engine>,
	/// The host (output, events, filesystem).
	pub host:      FakeHost,
	/// The store; replaced by its own image on every snapshot.
	pub store:     MemStore,
	shell:         Option<Shell>,
	/// Snapshots taken.
	pub snapshots: u32,
	/// Pauses injected.
	pub pauses:    u32,
	coin:          Rng,
}

impl Rig {
	/// A fresh shell over an empty `MemStore`.
	pub fn new(host: FakeHost, init: ShellInit) -> Self {
		Self::with_config(host, init, EngineConfig::default())
	}

	/// [`Self::new`] on an engine configured with `cfg` (snapshots restore
	/// onto a new engine with the same `cfg`).
	pub fn with_config(mut host: FakeHost, init: ShellInit, cfg: EngineConfig) -> Self {
		let engine = Engine::new(cfg);
		let mut store = MemStore::new();
		let shell = Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, init)
			.expect("create");
		Self {
			cfg,
			engine,
			host,
			store,
			shell: Some(shell),
			snapshots: 0,
			pauses: 0,
			coin: Rng::new(0),
		}
	}

	/// The shell.
	pub const fn shell(&mut self) -> &mut Shell {
		self
			.shell
			.as_mut()
			.expect("rig holds a shell between steps")
	}

	/// The shell, host and store at once (for driving the shell by hand).
	pub const fn parts(&mut self) -> (&mut Shell, &mut FakeHost, &mut MemStore) {
		(
			self
				.shell
				.as_mut()
				.expect("rig holds a shell between steps"),
			&mut self.host,
			&mut self.store,
		)
	}

	/// Run `script` to completion under `fault`; its status.
	pub fn run(&mut self, script: Script, fault: Fault) -> i32 {
		if let Fault::Mixed { seed, .. } | Fault::RandomPause { seed, .. } = fault {
			self.coin = Rng::new(seed);
		}
		let id = self.shell().submit(script);
		let budget = fault.budget();
		// Snapshot at every other `Blocked` too (pending fs ops are dropped
		// and re-issued); alternating guarantees progress.
		let snapshots =
			!matches!(fault, Fault::None | Fault::PauseResume { .. } | Fault::RandomPause { .. });
		let mut snap_blocked = snapshots;
		loop {
			let shell = self
				.shell
				.as_mut()
				.expect("rig holds a shell between steps");
			let stop = if snap_blocked {
				advance_or_blocked(shell, &mut self.host, &mut self.store, id, budget)
			} else {
				advance(shell, &mut self.host, &mut self.store, id, budget)
			};
			snap_blocked = snapshots && !snap_blocked;
			match stop {
				Stop::Done(status) => return status,
				Stop::Blocked => self.snapshot(),
				Stop::Paused => shell.control().resume(),
				Stop::Yield => match fault {
					Fault::None => {},
					Fault::PauseResume { .. } => self.pause_resume(),
					Fault::Snapshot { .. } => self.snapshot(),
					Fault::Mixed { .. } => {
						if self.coin.chance(0.5) {
							self.pause_resume();
						} else {
							self.snapshot();
						}
					},
					Fault::RandomPause { one_in, .. } => {
						if self.coin.chance(1.0 / f64::from(one_in.max(1))) {
							self.pause_resume();
						}
					},
				},
			}
		}
	}

	/// Pause at the next safepoint, observe `Paused`, resume.
	pub fn pause_resume(&mut self) {
		let shell = self
			.shell
			.as_mut()
			.expect("rig holds a shell between steps");
		let ctl = shell.control();
		ctl.pause();
		let step =
			shell.step(&mut Cx { host: &mut self.host, store: &mut self.store }, Budget::default());
		assert!(
			matches!(step, Step::Paused),
			"pause takes effect at the next safepoint, got {step:?}"
		);
		ctl.resume();
		self.pauses += 1;
	}

	/// Externalize, drop the shell, restore from the store image with a new
	/// engine.
	pub fn snapshot(&mut self) {
		let mut shell = self.shell.take().expect("rig holds a shell between steps");
		shell.control().request_suspend();
		{
			let mut cx = Cx { host: &mut self.host, store: &mut self.store };
			let step = shell.step(&mut cx, Budget::default());
			assert!(matches!(step, Step::SuspendReady), "suspend drains to a safepoint, got {step:?}");
			shell.externalize(&mut cx).expect("externalize");
		}
		drop(shell);
		let image = self.store.to_bytes();
		self.store = MemStore::from_bytes(&image).expect("store image decodes");
		self.engine = Engine::new(self.cfg);
		let (shell, _) = Shell::restore(
			&self.engine,
			&mut Cx { host: &mut self.host, store: &mut self.store },
			RestoreOpts::default(),
		)
		.expect("restore");
		self.shell = Some(shell);
		self.snapshots += 1;
	}
}

impl Drop for Rig {
	/// Dropping the shell releases every task and external it holds
	/// ([`FakeHost::assert_released`]); skipped while a test already panics.
	fn drop(&mut self) {
		drop(self.shell.take());
		if !std::thread::panicking() {
			self.host.assert_released();
		}
	}
}

/// Result of [`run_script`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
	/// Final status.
	pub status:    i32,
	/// Captured stdout.
	pub stdout:    Vec<u8>,
	/// Captured stderr.
	pub stderr:    Vec<u8>,
	/// Events, comparable across fault plans ([`comparable`]).
	pub events:    Vec<Value>,
	/// Snapshots taken.
	pub snapshots: u32,
	/// Pauses injected.
	pub pauses:    u32,
}

/// The shell every skeleton script runs in: `$0` = `bash` (so diagnostics
/// read like `bash -c`), `PATH=/usr/bin:/bin` over an empty `MemFs`.
pub fn skeleton_init(args: &[&str]) -> ShellInit {
	ShellInit {
		argv0: BString::from("bash"),
		args: args.iter().map(|a| BString::from(*a)).collect(),
		env: vec![(BString::from("PATH"), BString::from("/usr/bin:/bin"))],
		..ShellInit::default()
	}
}

/// Run `src` as a `-c` script with `args` under `fault`.
///
/// Panics when the case leaks vprocs, tasks or externals
/// ([`FakeHost::assert_no_leaks`]).
pub fn run_script(host: FakeHost, src: &[u8], args: &[&str], fault: Fault) -> Outcome {
	let mut rig = Rig::new(host, skeleton_init(args));
	let status = rig.run(Script::command(src.to_vec()), fault);
	let outcome = Outcome {
		status,
		stdout: rig.host.stdout.bytes(),
		stderr: rig.host.stderr.bytes(),
		events: comparable(&rig.host.events),
		snapshots: rig.snapshots,
		pauses: rig.pauses,
	};
	// Leak check after every case: leftover vprocs finish or
	// the check fails; an idle shell holds no task or external.
	let (shell, host, store) = rig.parts();
	host.assert_no_leaks(shell, store);
	outcome
}

/// Events with what legitimately differs between fault plans removed.
///
/// That is `seq`, `t_ns`, `dur_ns`, and the events the faults themselves
/// cause: `Suspended`/`Restored`/`Stopped`/`Continued`, and the
/// `UnitCompiled` a restored shell repeats for the units it can still run
/// (a shell announces each unit once).
pub fn comparable(events: &[Value]) -> Vec<Value> {
	let mut announced = std::collections::HashSet::new();
	events
		.iter()
		.filter(|e| match e["kind"].as_str() {
			Some("Suspended" | "Restored" | "Stopped" | "Continued") => false,
			Some("UnitCompiled") => announced.insert(e["data"]["unit"].to_string()),
			_ => true,
		})
		.map(|e| {
			let mut e = e.clone();
			if let Some(o) = e.as_object_mut() {
				o.remove("seq");
				o.remove("t_ns");
				if let Some(d) = o.get_mut("data").and_then(Value::as_object_mut)
					&& d.contains_key("dur_ns")
				{
					d.insert("dur_ns".into(), Value::from(0));
				}
			}
			e
		})
		.collect()
}
