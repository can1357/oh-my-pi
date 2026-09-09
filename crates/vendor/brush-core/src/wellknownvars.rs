use std::{collections::BTreeMap, path::PathBuf};

use rand::RngExt as _;

use crate::{
	Shell, ShellValue, ShellVariable, error, extensions, shell::ShellState, sys, variables,
};

const BASH_MAJOR: u32 = 5;
const BASH_MINOR: u32 = 2;
const BASH_PATCH: u32 = 37;
const BASH_BUILD: u32 = 1;
const BASH_RELEASE: &str = "release";
const BASH_MACHINE: &str = "unknown";

const DEFAULT_LINENO: usize = 1;

/// Inherit environment variables from the host process into the shell's
/// environment.
///
/// # Arguments
///
/// * `shell` - The shell instance to inherit environment variables into.
pub(crate) fn inherit_env_vars(
	shell: &mut Shell<impl extensions::ShellExtensions>,
) -> Result<(), error::Error> {
	for (k, v) in sys::env::get_host_env_vars() {
		// See if it's a function exported by an ancestor process.
		if let Some(func_name) = k.strip_prefix("BASH_FUNC_")
			&& let Some(func_name) = func_name.strip_suffix("%%")
		{
			// Intentionally best-effort; don't fail out of the shell if we can't
			// parse an incoming function.
			if shell.define_func_from_str(func_name, v.as_str()).is_ok()
				&& let Some(func) = shell.func_mut(func_name)
			{
				func.export();
			}

			continue;
		}

		// Special case OLDPWD for bash compatibility.
		if k == "OLDPWD" {
			continue;
		}

		let mut var = ShellVariable::new(ShellValue::String(v));
		var.export();
		shell.env_mut().set_global(k, var)?;
	}

	Ok(())
}

#[expect(clippy::too_many_lines)]
pub(crate) fn init_well_known_vars(
	shell: &mut Shell<impl extensions::ShellExtensions>,
) -> Result<(), error::Error> {
	let shell_version = shell.version().map(ToString::to_string);
	shell
		.env_mut()
		.set_global("BRUSH_VERSION", ShellVariable::new(shell_version.unwrap_or_default()))?;

	// BASH
	if let Some(shell_name) = shell.current_shell_name().map(|s| s.to_string()) {
		shell
			.env_mut()
			.set_global("BASH", ShellVariable::new(shell_name.clone()))?;
		// Initialize $_ to the shell name ($0).
		shell.update_last_arg_variable(Some(shell_name));
	}

	// BASHOPTS
	let mut bashopts_var = ShellVariable::new(ShellValue::Dynamic {
		getter: |shell| shell.options().shopt_optstr().into(),
		setter: |_| (),
	});
	bashopts_var.set_readonly();
	shell.env_mut().set_global("BASHOPTS", bashopts_var)?;

	// BASHPID
	#[cfg(not(target_family = "wasm"))]
	{
		let mut bashpid_var = ShellVariable::new(ShellValue::String(std::process::id().to_string()));
		bashpid_var.treat_as_integer();
		shell.env_mut().set_global("BASHPID", bashpid_var)?;
	}

	// BASH_ALIASES
	shell.env_mut().set_global(
		"BASH_ALIASES",
		ShellVariable::new(ShellValue::Dynamic {
			getter: |shell| {
				let values = variables::ArrayLiteral(
					shell
						.aliases()
						.iter()
						.map(|(k, v)| (Some(k.to_owned()), v.to_owned()))
						.collect::<Vec<_>>(),
				);

				ShellValue::associative_array_from_literals(values)
					.unwrap_or_else(|_error| ShellValue::AssociativeArray(BTreeMap::new()))
			},
			setter: |_| (),
		}),
	)?;

	// BASH_ARGC
	shell.env_mut().set_global(
		"BASH_ARGC",
		ShellVariable::new(ShellValue::Dynamic {
			getter: |shell| get_bash_argc_value(shell),
			setter: |_| (),
		}),
	)?;

	// BASH_ARGV
	shell.env_mut().set_global(
		"BASH_ARGV",
		ShellVariable::new(ShellValue::Dynamic {
			getter: |shell| get_bash_argv_value(shell),
			setter: |_| (),
		}),
	)?;

	// BASH_ARGV0
	shell.env_mut().set_global(
		"BASH_ARGV0",
		ShellVariable::new(ShellValue::Dynamic {
			getter: |shell| {
				let argv0 = shell.current_shell_name().unwrap_or_default();
				argv0.to_string().into()
			},
			// TODO(vars): implement updating BASH_ARGV0
			setter: |_| (),
		}),
	)?;

	// TODO(vars): implement mutation of BASH_CMDS
	shell.env_mut().set_global(
		"BASH_CMDS",
		ShellVariable::new(ShellValue::Dynamic {
			getter: |shell| {
				shell
					.program_location_cache()
					.to_value()
					.unwrap_or_else(|_error| ShellValue::AssociativeArray(BTreeMap::new()))
			},
			setter: |_| (),
		}),
	)?;

	// TODO(vars): implement BASH_COMMAND
	// TODO(vars): implement BASH_EXECUTION_STRING

	// BASH_LINENO
	shell.env_mut().set_global(
		"BASH_LINENO",
		ShellVariable::new(ShellValue::Dynamic {
			getter: |shell| get_bash_lineno_value(shell),
			setter: |_| (),
		}),
	)?;

	// BASH_SOURCE
	shell.env_mut().set_global(
		"BASH_SOURCE",
		ShellVariable::new(ShellValue::Dynamic {
			getter: |shell| get_bash_source_value(shell),
			setter: |_| (),
		}),
	)?;

	// BASH_SUBSHELL
	shell.env_mut().set_global(
		"BASH_SUBSHELL",
		ShellVariable::new(ShellValue::Dynamic {
			getter: |shell| shell.depth().to_string().into(),
			setter: |_| (),
		}),
	)?;

	// BASH_VERSINFO
	let mut bash_versinfo_var = ShellVariable::new(ShellValue::indexed_array_from_strs(
		[
			BASH_MAJOR.to_string().as_str(),
			BASH_MINOR.to_string().as_str(),
			BASH_PATCH.to_string().as_str(),
			BASH_BUILD.to_string().as_str(),
			BASH_RELEASE,
			BASH_MACHINE,
		]
		.as_slice(),
	));
	bash_versinfo_var.set_readonly();
	shell
		.env_mut()
		.set_global("BASH_VERSINFO", bash_versinfo_var)?;

	// BASH_VERSION
	// This is the Bash interface version. See BRUSH_VERSION for its implementation
	// version.
	shell.env_mut().set_global(
		"BASH_VERSION",
		ShellVariable::new(std::format!(
			"{BASH_MAJOR}.{BASH_MINOR}.{BASH_PATCH}({BASH_BUILD})-{BASH_RELEASE}"
		)),
	)?;

	// COMP_WORDBREAKS
	let mut default_comp_wordbreaks = String::from(" \t\n\"\'><=;|&(:");
	if shell.options().enable_hostname_completion {
		default_comp_wordbreaks.push('@');
	}

	shell
		.env_mut()
		.set_global("COMP_WORDBREAKS", ShellVariable::new(default_comp_wordbreaks))?;

	// DIRSTACK
	shell.env_mut().set_global(
		"DIRSTACK",
		ShellVariable::new(ShellValue::Dynamic {
			getter: |shell| {
				shell
					.directory_stack()
					.iter()
					.map(|p| p.to_string_lossy().to_string())
					.collect::<Vec<_>>()
					.into()
			},
			setter: |_| (),
		}),
	)?;

	// EPOCHREALTIME
	shell.env_mut().set_global(
		"EPOCHREALTIME",
		ShellVariable::new(ShellValue::Dynamic {
			getter: |_shell| {
				let now = std::time::SystemTime::now();
				let since_epoch = now
					.duration_since(std::time::UNIX_EPOCH)
					.unwrap_or_default();
				since_epoch.as_secs_f64().to_string().into()
			},
			setter: |_| (),
		}),
	)?;

	// EPOCHSECONDS
	shell.env_mut().set_global(
		"EPOCHSECONDS",
		ShellVariable::new(ShellValue::Dynamic {
			getter: |_shell| {
				let now = std::time::SystemTime::now();
				let since_epoch = now
					.duration_since(std::time::UNIX_EPOCH)
					.unwrap_or_default();
				since_epoch.as_secs().to_string().into()
			},
			setter: |_| (),
		}),
	)?;

	// EUID
	if let Ok(euid) = sys::users::get_effective_uid() {
		let mut euid_var = ShellVariable::new(ShellValue::String(format!("{euid}")));
		euid_var.treat_as_integer().set_readonly();
		shell.env_mut().set_global("EUID", euid_var)?;
	}

	// FUNCNAME
	shell.env_mut().set_global(
		"FUNCNAME",
		ShellVariable::new(ShellValue::Dynamic {
			getter: |shell| get_funcname_value(shell),
			setter: |_| (),
		}),
	)?;

	// GROUPS
	// N.B. We could compute this up front, but we choose to make it dynamic so that
	// we don't have to make costly system calls if the user never accesses it.
	shell.env_mut().set_global(
		"GROUPS",
		ShellVariable::new(ShellValue::Dynamic {
			getter: |_shell| {
				let groups = get_current_user_gids();
				ShellValue::indexed_array_from_strings(groups.into_iter().map(|gid| gid.to_string()))
			},
			setter: |_| (),
		}),
	)?;

	// HISTCMD
	let mut histcmd_var = ShellVariable::new(ShellValue::Dynamic {
		getter: |shell| {
			shell
				.history()
				.map_or_else(|| "0".into(), |h| h.count().to_string().into())
		},
		setter: |_| (),
	});
	histcmd_var.treat_as_integer();
	shell.env_mut().set_global("HISTCMD", histcmd_var)?;

	// HISTFILE (if not already set)
	if !shell.env().is_set("HISTFILE")
		&& let Some(home_dir) = shell.home_dir()
	{
		let histfile = home_dir.join(".brush_history");
		shell.env_mut().set_global(
			"HISTFILE",
			ShellVariable::new(ShellValue::String(histfile.to_string_lossy().to_string())),
		)?;
	}

	// HOSTNAME
	shell.env_mut().set_global(
		"HOSTNAME",
		ShellVariable::new(
			sys::network::get_hostname()
				.unwrap_or_default()
				.to_string_lossy()
				.to_string(),
		),
	)?;

	// HOSTTYPE
	shell
		.env_mut()
		.set_global("HOSTTYPE", ShellVariable::new(std::env::consts::ARCH.to_string()))?;

	// IFS
	shell
		.env_mut()
		.set_global("IFS", ShellVariable::new(" \t\n"))?;

	// LINENO
	shell.env_mut().set_global(
		"LINENO",
		ShellVariable::new(ShellValue::Dynamic {
			getter: |shell| get_lineno(shell).to_string().into(),
			setter: |_| (),
		}),
	)?;

	// MACHTYPE
	shell
		.env_mut()
		.set_global("MACHTYPE", ShellVariable::new(BASH_MACHINE))?;

	// OLDPWD (initialization)
	if !shell.env().is_set("OLDPWD") {
		let mut oldpwd_var =
			ShellVariable::new(ShellValue::Unset(variables::ShellValueUnsetType::Untyped));
		oldpwd_var.export();
		shell.env_mut().set_global("OLDPWD", oldpwd_var)?;
	}

	// OPTERR
	shell
		.env_mut()
		.set_global("OPTERR", ShellVariable::new("1"))?;

	// OPTIND
	let mut optind_var = ShellVariable::new("1");
	optind_var.treat_as_integer();
	shell.env_mut().set_global("OPTIND", optind_var)?;

	// OSTYPE
	// Match bash's conventional OSTYPE on each platform so that shell scripts
	// branching on `[[ $OSTYPE == darwin* ]]` / `linux-gnu*` etc. (Homebrew
	// shellenv, nvm, asdf, ...) take the expected path. Real bash includes a
	// kernel-version suffix on macOS/BSDs (e.g. `darwin24`); we omit the
	// suffix for now since the common patterns all use prefix matching.
	let os_type = match std::env::consts::OS {
		"linux" => "linux-gnu",
		"android" => "linux-android",
		"macos" | "ios" | "tvos" | "watchos" | "visionos" => "darwin",
		"freebsd" => "freebsd",
		"netbsd" => "netbsd",
		"openbsd" => "openbsd",
		"dragonfly" => "dragonfly",
		"solaris" | "illumos" => "solaris",
		"windows" => "windows",
		_ => "unknown",
	};
	shell
		.env_mut()
		.set_global("OSTYPE", ShellVariable::new(os_type))?;

	// PATH (if not already set)
	if !shell.env().is_set("PATH") {
		let default_path_str = std::env::join_paths(sys::fs::get_default_executable_search_paths())
			.unwrap_or_else(|_| PathBuf::from("").into());
		shell
			.env_mut()
			.set_global("PATH", ShellVariable::new(default_path_str))?;
	}

	// PIPESTATUS
	// TODO(well-known-vars): Investigate what happens if this gets unset.
	// TODO(well-known-vars): Investigate if this needs to be saved/preserved across
	// prompt display.
	shell.env_mut().set_global(
		"PIPESTATUS",
		ShellVariable::new(ShellValue::Dynamic {
			getter: |shell| {
				ShellValue::indexed_array_from_strings(
					shell.last_pipeline_statuses().iter().map(|s| s.to_string()),
				)
			},
			setter: |_| (),
		}),
	)?;

	// PPID
	if let Some(ppid) = sys::terminal::get_parent_process_id() {
		let mut ppid_var = ShellVariable::new(ppid.to_string());
		ppid_var.treat_as_integer().set_readonly();
		shell.env_mut().set_global("PPID", ppid_var)?;
	}

	// RANDOM
	let mut random_var =
		ShellVariable::new(ShellValue::Dynamic { getter: get_random_value, setter: |_| () });
	random_var.treat_as_integer();
	shell.env_mut().set_global("RANDOM", random_var)?;

	// SECONDS
	shell.env_mut().set_global(
		"SECONDS",
		ShellVariable::new(ShellValue::Dynamic {
			getter: |shell| {
				let now = std::time::SystemTime::now();
				let since_last = now
					.duration_since(shell.last_stopwatch_time())
					.unwrap_or_default();
				let total_seconds = since_last.as_secs() + u64::from(shell.last_stopwatch_offset());
				total_seconds.to_string().into()
			},
			// TODO(vars): implement updating SECONDS
			setter: |_| (),
		}),
	)?;

	// SHELL (if not already set)
	if !shell.env().is_set("SHELL") {
		// Per docs, this should be the user's default login shell -- not the current
		// shell.
		if let Some(default_shell) = sys::users::get_current_user_default_shell() {
			shell
				.env_mut()
				.set_global("SHELL", ShellVariable::new(default_shell.to_string_lossy().to_string()))?;
		}
	}

	// SHELLOPTS
	let mut shellopts_var = ShellVariable::new(ShellValue::Dynamic {
		getter: |shell| shell.options().seto_optstr().into(),
		setter: |_| (),
	});
	shellopts_var.set_readonly();
	shell.env_mut().set_global("SHELLOPTS", shellopts_var)?;

	// SHLVL
	let input_shlvl = shell.env_str("SHLVL").unwrap_or_else(|| "0".into());
	let updated_shlvl = input_shlvl.as_ref().parse::<u32>().unwrap_or(0) + 1;
	let mut shlvl_var = ShellVariable::new(updated_shlvl.to_string());
	shlvl_var.export();
	shell.env_mut().set_global("SHLVL", shlvl_var)?;

	// SRANDOM
	let mut random_var =
		ShellVariable::new(ShellValue::Dynamic { getter: get_srandom_value, setter: |_| () });
	random_var.treat_as_integer();
	shell.env_mut().set_global("SRANDOM", random_var)?;

	// PS1 / PS2
	if shell.options().interactive {
		if !shell.env().is_set("PS1") {
			shell
				.env_mut()
				.set_global("PS1", ShellVariable::new(r"\s-\v\$ "))?;
		}

		if !shell.env().is_set("PS2") {
			shell
				.env_mut()
				.set_global("PS2", ShellVariable::new("> "))?;
		}
	}

	// PS4
	if !shell.env().is_set("PS4") {
		shell
			.env_mut()
			.set_global("PS4", ShellVariable::new("+ "))?;
	}

	//
	// PWD
	//
	// Reflect our actual working directory. There's a chance
	// we inherited an out-of-sync version of the variable. Future updates
	// will be handled by set_working_dir().
	//
	let pwd = shell.working_dir().to_string_lossy().to_string();
	let mut pwd_var = ShellVariable::new(pwd);
	pwd_var.export();
	shell.env_mut().set_global("PWD", pwd_var)?;

	// UID
	if let Ok(uid) = sys::users::get_current_uid() {
		let mut uid_var = ShellVariable::new(ShellValue::String(format!("{uid}")));
		uid_var.treat_as_integer().set_readonly();
		shell.env_mut().set_global("UID", uid_var)?;
	}

	Ok(())
}

/// Returns a list of the current user's group IDs, with the effective GID at
/// the front.
fn get_current_user_gids() -> Vec<u32> {
	let mut groups = sys::users::get_user_group_ids().unwrap_or_default();

	// If the effective GID is present but not in the first position in the list,
	// then move it there.
	if let Ok(gid) = sys::users::get_effective_gid() {
		if let Some(index) = groups.iter().position(|&g| g == gid) {
			if index > 0 {
				// Move it to the front.
				groups.remove(index);
				groups.insert(0, gid);
			}
		}
	}

	groups
}

fn get_random_value(_shell: &dyn ShellState) -> ShellValue {
	let mut rng = rand::rng();
	let num = rng.random_range(0..32768);
	let str = num.to_string();
	str.into()
}

fn get_srandom_value(_shell: &dyn ShellState) -> ShellValue {
	let mut rng = rand::rng();
	let num: u32 = rng.random();
	let str = num.to_string();
	str.into()
}

fn get_funcname_value(shell: &dyn ShellState) -> variables::ShellValue {
	let stack = shell.call_stack();

	if stack.iter_function_calls().next().is_none() {
		ShellValue::Unset(variables::ShellValueUnsetType::IndexedArray)
	} else {
		// When in a function, include both functions and sourced scripts in the stack
		stack
			.iter()
			.filter_map(|frame| match &frame.frame_type {
				crate::callstack::FrameType::Function(func) => Some(func.function_name.as_str()),
				crate::callstack::FrameType::Script(script) => {
					// Only include sourced scripts, not run scripts
					if matches!(script.call_type, crate::callstack::ScriptCallType::Source) {
						Some("source")
					} else {
						None
					}
				},
				crate::callstack::FrameType::TrapHandler(_)
				| crate::callstack::FrameType::Eval
				| crate::callstack::FrameType::CommandString
				| crate::callstack::FrameType::InteractiveSession => None,
			})
			.collect::<Vec<_>>()
			.into()
	}
}

fn get_bash_lineno_value(shell: &dyn ShellState) -> variables::ShellValue {
	let stack = shell.call_stack();

	// BASH_LINENO[$i] contains the line number where FUNCNAME[$i] was called
	// This is extracted from the call_site of each frame
	if stack.iter_function_calls().next().is_none() {
		ShellValue::Unset(variables::ShellValueUnsetType::IndexedArray)
	} else {
		stack
			.iter()
			.enumerate()
			.filter_map(|(frame_idx, frame)| match &frame.frame_type {
				crate::callstack::FrameType::Function(..) | crate::callstack::FrameType::Script(..) => {
					let caller_idx = frame_idx + 1;
					if caller_idx < stack.depth() {
						let caller_frame = &stack[caller_idx];
						Some(
							caller_frame
								.current_line()
								.unwrap_or(DEFAULT_LINENO)
								.to_string(),
						)
					} else {
						None
					}
				},
				crate::callstack::FrameType::TrapHandler(_)
				| crate::callstack::FrameType::Eval
				| crate::callstack::FrameType::CommandString
				| crate::callstack::FrameType::InteractiveSession => None,
			})
			.collect::<Vec<_>>()
			.into()
	}
}

fn get_bash_source_value(shell: &dyn ShellState) -> variables::ShellValue {
	let stack = shell.call_stack();

	if stack.iter_function_calls().next().is_none() {
		let top_frame = stack.iter_script_calls().next();
		top_frame
			.map_or_else(Vec::new, |frame| vec![frame.source_info.source.clone()])
			.into()
	} else {
		// When in a function, include both functions and sourced scripts in the stack
		// This mirrors the FUNCNAME array structure
		stack
			.iter()
			.filter_map(|frame| match &frame.frame_type {
				crate::callstack::FrameType::Function(func) => {
					Some(func.function.source().source.clone())
				},
				crate::callstack::FrameType::Script(script) => {
					// Only include sourced scripts (matching the "source" in FUNCNAME)
					if matches!(script.call_type, crate::callstack::ScriptCallType::Source) {
						Some(script.source_info.source.clone())
					} else {
						None
					}
				},
				crate::callstack::FrameType::TrapHandler(_) | crate::callstack::FrameType::Eval => None,
				crate::callstack::FrameType::CommandString
				| crate::callstack::FrameType::InteractiveSession => None,
			})
			.collect::<Vec<_>>()
			.into()
	}
}

fn get_bash_argc_value(shell: &dyn ShellState) -> variables::ShellValue {
	if !shell.options().enable_debugger {
		return ShellValue::indexed_array_from_strs(&[]);
	}

	let stack = shell.call_stack();
	stack
		.iter()
		.filter_map(|frame| match &frame.frame_type {
			crate::callstack::FrameType::Function(..)
			| crate::callstack::FrameType::Script(..)
			| crate::callstack::FrameType::CommandString
			| crate::callstack::FrameType::InteractiveSession => Some(frame.args.len().to_string()),
			crate::callstack::FrameType::TrapHandler(_) | crate::callstack::FrameType::Eval => None,
		})
		.collect::<Vec<_>>()
		.into()
}

fn get_bash_argv_value(shell: &dyn ShellState) -> variables::ShellValue {
	if !shell.options().enable_debugger {
		return ShellValue::indexed_array_from_strs(&[]);
	}

	let stack = shell.call_stack();
	let mut argv = Vec::new();

	for frame in stack.iter() {
		let include = match &frame.frame_type {
			crate::callstack::FrameType::Function(..)
			| crate::callstack::FrameType::Script(..)
			| crate::callstack::FrameType::CommandString
			| crate::callstack::FrameType::InteractiveSession => true,
			crate::callstack::FrameType::TrapHandler(_) | crate::callstack::FrameType::Eval => false,
		};

		if include {
			// Push args in reverse order per frame (last arg at lowest index = top of
			// stack)
			for arg in frame.args.iter().rev() {
				argv.push(arg.clone());
			}
		}
	}

	argv.into()
}

fn get_lineno(shell: &dyn ShellState) -> usize {
	shell
		.call_stack()
		.current_frame()
		.and_then(|frame| frame.current_line())
		.unwrap_or(DEFAULT_LINENO)
}
