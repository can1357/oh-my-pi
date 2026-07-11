// Copyright 2017 Google Inc.
//
// Use of this source code is governed by a MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

use std::{cell::RefCell, error::Error, ffi::OsString, io::Write, path::Path, process::Command};

use pi_uutils_ctx::stderr;

use super::{Matcher, MatcherIO, WalkEntry};

enum Arg {
	FileArg(Vec<OsString>),
	LiteralArg(OsString),
}

pub struct SingleExecMatcher {
	executable:         String,
	args:               Vec<Arg>,
	exec_in_parent_dir: bool,
}

impl SingleExecMatcher {
	pub fn new(
		executable: &str,
		args: &[&str],
		exec_in_parent_dir: bool,
	) -> Result<Self, Box<dyn Error>> {
		let transformed_args = args
			.iter()
			.map(|&a| {
				let parts = a.split("{}").collect::<Vec<_>>();
				if parts.len() == 1 {
					// No {} present
					Arg::LiteralArg(OsString::from(a))
				} else {
					Arg::FileArg(parts.iter().map(OsString::from).collect())
				}
			})
			.collect();

		Ok(Self { executable: executable.to_string(), args: transformed_args, exec_in_parent_dir })
	}
}

impl Matcher for SingleExecMatcher {
	fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		let mut command = Command::new(&self.executable);
		let path_to_file = if self.exec_in_parent_dir {
			if let Some(f) = file_info.path().file_name() {
				Path::new(".").join(f)
			} else {
				Path::new(".").join(file_info.path())
			}
		} else {
			file_info.display_path().to_path_buf()
		};

		for arg in &self.args {
			match *arg {
				Arg::LiteralArg(ref a) => command.arg(a.as_os_str()),
				Arg::FileArg(ref parts) => command.arg(parts.join(path_to_file.as_os_str())),
			};
		}
		if self.exec_in_parent_dir {
			match file_info.path().parent() {
				None => {
					// Root paths like "/" have no parent.  Run them from the root to match GNU
					// find.
					command.current_dir(file_info.path());
				},
				Some(parent) if parent == Path::new("") => {
					// Paths like "foo" have a parent of "".  Avoid chdir("").
				},
				Some(parent) => {
					command.current_dir(parent);
				},
			}
		} else {
			// GNU runs `-exec` in find's working directory; resolve the
			// operand-relative `{}` against the shell cwd, not the host cwd.
			command.current_dir(pi_uutils_ctx::cwd());
		}
		match command.status() {
			Ok(status) => status.success(),
			Err(e) => {
				writeln!(&mut stderr(), "Failed to run {}: {}", self.executable, e).unwrap();
				false
			},
		}
	}

	fn has_side_effects(&self) -> bool {
		true
	}
}

pub struct MultiExecMatcher {
	executable:         String,
	args:               Vec<OsString>,
	exec_in_parent_dir: bool,
	/// Command to build while matching.
	command:            RefCell<Option<argmax::Command>>,
}

impl MultiExecMatcher {
	pub fn new(
		executable: &str,
		args: &[&str],
		exec_in_parent_dir: bool,
	) -> Result<Self, Box<dyn Error>> {
		let transformed_args = args.iter().map(OsString::from).collect();

		Ok(Self {
			executable: executable.to_string(),
			args: transformed_args,
			exec_in_parent_dir,
			command: RefCell::new(None),
		})
	}

	fn new_command(&self) -> argmax::Command {
		let mut command = argmax::Command::new(&self.executable);
		command.try_args(&self.args).unwrap();
		if !self.exec_in_parent_dir {
			// `-exec ... +` (non-execdir) dispatches in find's working dir;
			// resolve the operand-relative paths against the shell cwd.
			command.current_dir(pi_uutils_ctx::cwd());
		}
		command
	}

	fn run_command(&self, command: &mut argmax::Command, matcher_io: &mut MatcherIO) {
		match command.status() {
			Ok(status) => {
				if !status.success() {
					matcher_io.set_exit_code(1);
				}
			},
			Err(e) => {
				writeln!(&mut stderr(), "Failed to run {}: {}", self.executable, e).unwrap();
				matcher_io.set_exit_code(1);
			},
		}
	}
}

impl Matcher for MultiExecMatcher {
	fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
		let path_to_file = if self.exec_in_parent_dir {
			if let Some(f) = file_info.path().file_name() {
				Path::new(".").join(f)
			} else {
				Path::new(".").join(file_info.path())
			}
		} else {
			file_info.display_path().to_path_buf()
		};
		let mut command = self.command.borrow_mut();
		let command = command.get_or_insert_with(|| self.new_command());

		// Build command, or dispatch it before when it is long enough.
		if command.try_arg(&path_to_file).is_err() {
			if self.exec_in_parent_dir {
				match file_info.path().parent() {
					None => {
						// Root paths like "/" have no parent.  Run them from the root to match GNU
						// find.
						command.current_dir(file_info.path());
					},
					Some(parent) if parent == Path::new("") => {
						// Paths like "foo" have a parent of "".  Avoid chdir("").
					},
					Some(parent) => {
						command.current_dir(parent);
					},
				}
			}
			self.run_command(command, matcher_io);

			// Reset command status.
			*command = self.new_command();
			if let Err(e) = command.try_arg(&path_to_file) {
				writeln!(
					&mut stderr(),
					"Cannot fit a single argument {}: {}",
					&path_to_file.to_string_lossy(),
					e
				)
				.unwrap();
				matcher_io.set_exit_code(1);
			}
		}
		true
	}

	fn finished_dir(&self, dir: &Path, matcher_io: &mut MatcherIO) {
		// Dispatch command for -execdir.
		if self.exec_in_parent_dir {
			let mut command = self.command.borrow_mut();
			if let Some(mut command) = command.take() {
				command.current_dir(Path::new(".").join(dir));
				self.run_command(&mut command, matcher_io);
			}
		}
	}

	fn finished(&self, matcher_io: &mut MatcherIO) {
		// Dispatch command for -exec.
		if !self.exec_in_parent_dir {
			let mut command = self.command.borrow_mut();
			if let Some(mut command) = command.take() {
				self.run_command(&mut command, matcher_io);
			}
		}
	}

	fn has_side_effects(&self) -> bool {
		true
	}
}

#[cfg(test)]
/// No tests here, because we need to call out to an external executable. See
/// `tests/exec_unit_tests.rs` instead.
mod tests {}
