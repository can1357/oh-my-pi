//! `git` with pi's layers ([`crate::git`]): the guard and in-process
//! `git worktree add` run on a worker thread (they read repositories), then
//! the git binary runs in a subshell of the caller by absolute path, so it
//! never resolves back to this tool. Layers are read from the command's own
//! environment; with none on, `git` is the binary.

use std::{
	path::{Path, PathBuf},
	task::Waker,
};

use bstr::{BString, ByteSlice};

use super::{Child, Out, ToolConfig, Turn};
use crate::{
	bash::{CallOutcome, EnvView, ShellApi, ToolCall},
	git::{
		AddRequest, FATAL_EXIT, GitLayers, Outcome, env_redirected,
		guard::{Decision, REFUSED_EXIT, Review},
	},
	sys::pathext::Pathext,
};

/// What the worker decided.
struct Prepared {
	/// Output before git runs (a guard note, the worktree report).
	out:  Vec<(i32, Vec<u8>)>,
	next: Next,
}

enum Next {
	/// Answer with this status.
	Exit(i32),
	/// Run git with these arguments (without `git`), stdout to stderr for
	/// a hook.
	Git { args: Vec<BString>, to_stderr: bool },
}

/// Where a `git` call is.
enum Stage {
	/// The worker runs.
	Preparing(flume::Receiver<Prepared>),
	/// git runs in [`Git::child`].
	Running,
	Exit(i32),
}

/// A `git` call.
pub(super) struct Git {
	pub(super) child: Child,
	call:             ToolCall,
	out:              Out,
	stage:            Option<Stage>,
}

impl Git {
	pub(super) fn new(call: ToolCall) -> Self {
		Self { child: Child::default(), call, out: Out::default(), stage: None }
	}

	pub(super) fn advance(
		&mut self,
		api: &mut ShellApi<'_, '_>,
		turn: &mut Turn<'_>,
	) -> Option<CallOutcome> {
		loop {
			match self.stage.take() {
				None => {
					let rx = prepare(&self.call, turn.config, turn.waker.clone());
					self.stage = Some(Stage::Preparing(rx));
				},
				Some(Stage::Preparing(rx)) => match rx.try_recv() {
					Ok(Prepared { out, next }) => {
						for (fd, bytes) in out {
							self.out.push(fd, bytes);
						}
						self.stage = Some(match next {
							Next::Exit(code) => Stage::Exit(code),
							Next::Git { args, to_stderr } => {
								if let Some(git) = git_path(&self.call) {
									let argv = std::iter::once(git).chain(args).collect();
									let redirect = if to_stderr { " >&2" } else { "" };
									self
										.child
										.start(api, turn, &self.call, argv, false, redirect);
									Stage::Running
								} else {
									self.out.push(2, "git: command not found\n");
									Stage::Exit(127)
								}
							},
						});
					},
					Err(flume::TryRecvError::Empty) => {
						self.stage = Some(Stage::Preparing(rx));
						return None;
					},
					// The worker died (a panic in a layer): run plain git.
					Err(flume::TryRecvError::Disconnected) => {
						self.stage = Some(Stage::Preparing(finished(Prepared {
							out:  Vec::new(),
							next: Next::Git { args: self.call.argv[1..].to_vec(), to_stderr: false },
						})));
					},
				},
				Some(Stage::Running) => {
					self.stage = Some(Stage::Running);
					// git's output goes straight to the fds; what the layers
					// printed before it is written first.
					if !self.out.flush(api) {
						return None;
					}
					return self.child.status.map(CallOutcome::Exit);
				},
				Some(Stage::Exit(code)) => {
					self.stage = Some(Stage::Exit(code));
					return self.out.flush(api).then_some(CallOutcome::Exit(code));
				},
			}
		}
	}
}

/// A receiver already holding `prepared`.
fn finished(prepared: Prepared) -> flume::Receiver<Prepared> {
	let (tx, rx) = flume::bounded(1);
	let _ = tx.send(prepared);
	rx
}

/// Run the layers on a worker thread; it wakes `waker` when done.
fn prepare(call: &ToolCall, config: &ToolConfig, waker: Waker) -> flume::Receiver<Prepared> {
	let env = &call.env;
	let layers = GitLayers::from_env(|name| env.get(name.as_bytes()).and_then(|v| v.to_str().ok()));
	if !layers.any() {
		return finished(Prepared {
			out:  Vec::new(),
			next: Next::Git { args: call.argv[1..].to_vec(), to_stderr: false },
		});
	}
	let args: Vec<String> = call.argv[1..]
		.iter()
		.map(|a| a.to_str_lossy().into_owned())
		.collect();
	let cwd = call.cwd.to_path_lossy().into_owned();
	let env = call.env.clone();
	let config = config.clone();
	let (tx, rx) = flume::bounded(1);
	let job = move || {
		let _ = tx.send(run_layers(layers, &args, &cwd, &env, &config));
		waker.wake();
	};
	if let Err(err) = std::thread::Builder::new().name("pi-git".into()).spawn(job) {
		return finished(Prepared {
			out:  vec![(2, format!("git: {err}\n").into_bytes())],
			next: Next::Exit(1),
		});
	}
	rx
}

/// The guard, then in-process `worktree add`. Blocks on repository I/O.
fn run_layers(
	layers: GitLayers,
	args: &[String],
	cwd: &Path,
	env: &EnvView,
	config: &ToolConfig,
) -> Prepared {
	let names: Vec<&str> = env
		.iter()
		.filter_map(|(name, _)| name.to_str().ok())
		.collect();
	let exported = names.iter().copied();
	let mut out = Vec::new();
	if layers.guard {
		let ovnfs = env
			.get(b"PI_GIT_GUARD_OVNFS".as_slice())
			.and_then(|value| value.to_str().ok());
		match Review::of(cwd, exported.clone(), args).decide(ovnfs) {
			Decision::Run => {},
			Decision::RunNoted(note) => out.push((2, note.into_bytes())),
			Decision::Refuse(refusal) => {
				out.push((2, refusal.into_bytes()));
				return Prepared { out, next: Next::Exit(i32::from(REFUSED_EXIT)) };
			},
		}
	}
	let plain = |out| Prepared { out, next: Next::Git { args: args_of(args), to_stderr: false } };
	if !layers.smart_worktree || env_redirected(exported) {
		return plain(out);
	}
	let Some(request) = AddRequest::parse(args) else {
		return plain(out);
	};
	match request.create(cwd, &|path| config.native(path)) {
		Outcome::External => plain(out),
		Outcome::Failed(message) => {
			out.push((2, format!("fatal: {message}\n").into_bytes()));
			Prepared { out, next: Next::Exit(i32::from(FATAL_EXIT)) }
		},
		Outcome::Created(created) => {
			let report = created.report();
			out.push((2, report.stderr.into_bytes()));
			out.push((1, report.stdout.into_bytes()));
			let next = match created.hook_args() {
				Some(hook) => Next::Git { args: args_of(&hook), to_stderr: true },
				None => Next::Exit(0),
			};
			Prepared { out, next }
		},
	}
}

fn args_of(args: &[String]) -> Vec<BString> {
	args.iter().map(|a| BString::from(a.as_str())).collect()
}

/// The git binary on the command's `PATH` (as an absolute path, so running
/// it never resolves to the tool again).
fn git_path(call: &ToolCall) -> Option<BString> {
	let path = call.env.get(b"PATH")?;
	let cwd = call.cwd.to_path_lossy();
	let rules = if cfg!(windows) {
		let pathext = call.env.get(b"PATHEXT").map(|v| v.to_os_str_lossy());
		PathRules::Windows(Pathext::parse(pathext.as_deref()))
	} else {
		PathRules::Unix
	};
	let git = find_git(path, &cwd, &rules)?;
	Some(BString::from(git.to_string_lossy().as_bytes()))
}

/// How a `PATH` value names executables.
enum PathRules {
	/// `:`-separated; a file with an execute bit.
	Unix,
	/// `;`-separated; `git` spelled with a `PATHEXT` suffix (`git.exe`), the
	/// name Windows can launch.
	Windows(Pathext),
}

/// The first `git` in `path`, entries relative to `cwd` (an empty one is
/// `cwd`), as the file to launch.
fn find_git(path: &[u8], cwd: &Path, rules: &PathRules) -> Option<PathBuf> {
	let separator = match rules {
		PathRules::Unix => ":",
		PathRules::Windows(_) => ";",
	};
	path.split_str(separator).find_map(|dir| {
		let git = cwd.join(dir.to_path_lossy()).join("git");
		match rules {
			PathRules::Unix => executable(&git).then_some(git),
			PathRules::Windows(pathext) => pathext.resolve(git),
		}
	})
}

#[cfg(unix)]
fn executable(path: &Path) -> bool {
	use std::os::unix::fs::PermissionsExt as _;
	std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn executable(path: &Path) -> bool {
	path.is_file()
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Windows launches `git.exe`, never the bare `git` it was found as
	/// (issue #18722); entries without one are skipped.
	#[test]
	fn windows_lookup_returns_the_pathext_spelling() {
		let temp = tempfile::tempdir().expect("tempdir");
		std::fs::create_dir(temp.path().join("cmd")).expect("create cmd");
		std::fs::write(temp.path().join("cmd/git.exe"), b"").expect("write git.exe");
		let rules = PathRules::Windows(Pathext::parse(None));
		assert_eq!(
			find_git(b"missing;cmd", temp.path(), &rules),
			Some(temp.path().join("cmd").join("git.exe"))
		);
		assert_eq!(find_git(b"missing", temp.path(), &rules), None);
	}
}
