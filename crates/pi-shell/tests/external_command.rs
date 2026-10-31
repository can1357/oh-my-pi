//! What an external command is started with, and what it is refused with, is
//! the operating system's to decide. A length check the shell made ahead of
//! the spawn refused virtual arguments a provider would have shortened, read
//! an exported dynamic value a second time, and answered `E2BIG` where the
//! spawn answers `EACCES` or the shell's own working-directory error. These
//! pin the outcomes against the spawn's own.
#![cfg(unix)]

use std::{
	io::{Read, Seek},
	path::Path,
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
};

use brush_core::{
	ProfileLoadBehavior, RcLoadBehavior, Shell, ShellValue, ShellVariable, SourceInfo,
	openfiles::{OpenFile, OpenFiles},
};
use pi_builtins::{BuiltinSet, default_builtins};

/// One byte more than the longest string Linux starts a process with on
/// 4 KiB pages (`MAX_ARG_STRLEN`, thirty-two pages with its NUL).
#[cfg(target_os = "linux")]
fn over_one_string() -> usize {
	// SAFETY: `sysconf` reads a configuration value and has no preconditions.
	let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
	usize::try_from(page).expect("a page size") * 32
}

async fn shell() -> Shell {
	Shell::builder()
		.do_not_inherit_env(true)
		.profile(ProfileLoadBehavior::Skip)
		.rc(RcLoadBehavior::Skip)
		.builtins(default_builtins(BuiltinSet::BashMode))
		.build()
		.await
		.expect("shell")
}

/// What one run printed and how it ended.
struct Ran {
	succeeded: bool,
	stdout:    String,
	stderr:    String,
}

async fn run(shell: &mut Shell, code: &str) -> Ran {
	let mut stdout = tempfile::tempfile().expect("stdout");
	let mut stderr = tempfile::tempfile().expect("stderr");
	let mut params = shell.default_exec_params();
	params
		.set_fd(OpenFiles::STDOUT_FD, OpenFile::from(stdout.try_clone().expect("stdout descriptor")));
	params
		.set_fd(OpenFiles::STDERR_FD, OpenFile::from(stderr.try_clone().expect("stderr descriptor")));
	let result = shell
		.run_string(code, &SourceInfo::default(), &params)
		.await;
	let succeeded = result.as_ref().is_ok_and(|result| result.is_success());
	let read = |file: &mut std::fs::File| {
		file.rewind().expect("rewind");
		let mut text = String::new();
		file.read_to_string(&mut text).expect("read");
		text
	};
	Ran { succeeded, stdout: read(&mut stdout), stderr: read(&mut stderr) }
}

/// A provider that aliases every URL to `/dev/null`.
#[derive(Debug)]
struct AliasesToDevNull;

#[async_trait::async_trait]
impl pi_vfs::FileSystem for AliasesToDevNull {
	fn is_native_local(&self, path: &Path) -> bool {
		!pi_vfs::is_virtual_path(path)
	}

	async fn open(
		&self,
		_path: &Path,
		_options: &pi_vfs::OpenOptions,
	) -> std::io::Result<pi_vfs::File> {
		Err(std::io::ErrorKind::Unsupported.into())
	}

	async fn metadata(&self, _path: &Path) -> std::io::Result<pi_vfs::Metadata> {
		Ok(std::fs::metadata("/")?.into())
	}

	async fn read_dir(&self, _path: &Path) -> std::io::Result<pi_vfs::ReadDir> {
		Ok(pi_vfs::ReadDir::from_entries(vec![]))
	}

	async fn backing_path(&self, path: &Path) -> std::io::Result<Option<std::path::PathBuf>> {
		Ok(pi_vfs::is_virtual_path(path).then(|| "/dev/null".into()))
	}
}

/// The limit applies to what is sent to the operating system, not to the URL
/// a provider replaces: a URL of any length that aliases `/dev/null` reaches
/// the program as `/dev/null`, bare and as an option's attached value.
#[tokio::test]
async fn a_long_url_argument_is_replaced_before_any_limit_applies() {
	for bytes in [131_071, 131_072, 131_073, 1 << 20] {
		for prefix in ["virtual://root/", "--value=virtual://root/"] {
			let mut shell = shell().await;
			shell.set_filesystem(pi_vfs::Fs::new(Arc::new(AliasesToDevNull)));
			let value = format!("{prefix}{}", "x".repeat(bytes - prefix.len()));
			shell
				.env_mut()
				.set_global("big", ShellVariable::new(value))
				.expect("big");
			let ran = run(&mut shell, "/usr/bin/printf '<%s>\\n' \"$big\"").await;
			let expected = if prefix.starts_with("--") {
				"<--value=/dev/null>\n"
			} else {
				"</dev/null>\n"
			};
			assert!(
				ran.succeeded && ran.stdout == expected,
				"{bytes} bytes as {prefix:?}: stdout {:?}, stderr {:?}",
				ran.stdout,
				ran.stderr
			);
		}
	}
}

static DYNAMIC_READS: AtomicUsize = AtomicUsize::new(0);

/// An exported dynamic value is read once for the child's environment: its
/// getter can change what it returns, so a second read can change the value
/// the child sees, not only what it costs.
#[tokio::test]
async fn an_exported_dynamic_value_is_read_once() {
	let mut shell = shell().await;
	let mut counted = ShellVariable::new(ShellValue::Dynamic {
		getter: |_| ShellValue::String(DYNAMIC_READS.fetch_add(1, Ordering::SeqCst).to_string()),
		setter: |_| (),
	});
	counted.export();
	shell
		.env_mut()
		.set_global("COUNTED", counted)
		.expect("COUNTED");
	DYNAMIC_READS.store(0, Ordering::SeqCst);
	let ran = run(&mut shell, "/usr/bin/printenv COUNTED").await;
	assert!(ran.succeeded, "stderr {:?}", ran.stderr);
	assert_eq!(DYNAMIC_READS.load(Ordering::SeqCst), 1, "reads of the getter");
	assert_eq!(ran.stdout, "0\n");
}

/// A command that fails for a reason of its own fails for that reason
/// whatever the length of its arguments: the outcome with an argument longer
/// than the operating system takes is the outcome with an empty one, where
/// the spawn checks the program before the arguments, and where the shell's
/// own working-directory refusal comes before both.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_long_argument_does_not_change_why_a_command_fails() {
	use std::os::unix::fs::PermissionsExt;

	let root = tempfile::tempdir().expect("scratch directory");
	let not_executable = root.path().join("not-executable");
	std::fs::write(&not_executable, "#!/bin/sh\nexit 0\n").expect("script");
	std::fs::set_permissions(&not_executable, std::fs::Permissions::from_mode(0o644)).expect("mode");
	let long = "x".repeat(over_one_string());

	for program in [not_executable.as_path(), root.path()] {
		let mut outcomes = vec![];
		for argument in ["", long.as_str()] {
			let mut shell = shell().await;
			shell
				.env_mut()
				.set_global("arg", ShellVariable::new(argument.to_owned()))
				.expect("arg");
			let ran =
				run(&mut shell, &format!("{} \"$arg\"; echo \"status=$?\"", program.display())).await;
			outcomes.push((ran.stdout, ran.stderr));
		}
		assert_eq!(
			outcomes[0],
			outcomes[1],
			"{}: empty argument, then a long one",
			program.display()
		);
		assert!(!outcomes[1].1.contains("os error 7"), "{}: {:?}", program.display(), outcomes[1]);
	}
	{
		let mut shell = shell().await;
		shell
			.env_mut()
			.set_global("arg", ShellVariable::new(long.clone()))
			.expect("arg");
		let ran = run(&mut shell, &format!("{} \"$arg\"", not_executable.display())).await;
		assert!(ran.stderr.contains("os error 13"), "not executable: {:?}", ran.stderr);
	}

	let mut outcomes = vec![];
	for argument in ["", long.as_str()] {
		let mut shell = shell().await;
		shell.set_filesystem(pi_vfs::Fs::new(Arc::new(NoBackingDirectories)));
		shell
			.set_working_dir("virtual://root/short")
			.await
			.expect("virtual directory");
		shell
			.env_mut()
			.set_global("arg", ShellVariable::new(argument.to_owned()))
			.expect("arg");
		let ran = run(&mut shell, "/usr/bin/true \"$arg\"; echo \"status=$?\"").await;
		outcomes.push((ran.stdout, ran.stderr));
	}
	assert_eq!(
		outcomes[0], outcomes[1],
		"a virtual working directory: empty argument, then a long one"
	);
	assert!(!outcomes[1].1.contains("os error 7"), "{:?}", outcomes[1]);
}

/// A provider whose directories alias nothing on the host.
#[cfg(target_os = "linux")]
#[derive(Debug)]
struct NoBackingDirectories;

#[cfg(target_os = "linux")]
#[async_trait::async_trait]
impl pi_vfs::FileSystem for NoBackingDirectories {
	fn is_native_local(&self, path: &Path) -> bool {
		!pi_vfs::is_virtual_path(path)
	}

	async fn open(
		&self,
		_path: &Path,
		_options: &pi_vfs::OpenOptions,
	) -> std::io::Result<pi_vfs::File> {
		Err(std::io::ErrorKind::Unsupported.into())
	}

	async fn metadata(&self, _path: &Path) -> std::io::Result<pi_vfs::Metadata> {
		Ok(std::fs::metadata("/")?.into())
	}

	async fn read_dir(&self, _path: &Path) -> std::io::Result<pi_vfs::ReadDir> {
		Ok(pi_vfs::ReadDir::from_entries(vec![]))
	}
}

/// Linux takes one string of 131,071 bytes and refuses 131,072 with `E2BIG`
/// (on 4 KiB pages), and the refusal is the spawn's: status 126 and its
/// error. An `exec -c` drops the environment, so an exported value too long
/// for the spawn does not stop it.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn the_spawn_decides_what_is_too_long() {
	let over = over_one_string();
	for (bytes, starts) in [(over - 1, true), (over, false)] {
		let mut shell = shell().await;
		shell
			.env_mut()
			.set_global("arg", ShellVariable::new("h".repeat(bytes)))
			.expect("arg");
		let ran = run(&mut shell, "/usr/bin/true \"$arg\"; echo \"status=$?\"").await;
		if starts {
			assert_eq!(ran.stdout, "status=0\n", "{bytes} bytes: stderr {:?}", ran.stderr);
		} else {
			assert_eq!(ran.stdout, "status=126\n", "{bytes} bytes: stderr {:?}", ran.stderr);
			assert!(ran.stderr.contains("os error 7"), "{bytes} bytes: stderr {:?}", ran.stderr);
		}
	}

	let mut shell = shell().await;
	let mut big = ShellVariable::new("h".repeat(over));
	big.export();
	shell.env_mut().set_global("BIG", big).expect("BIG");
	let ran = run(
		&mut shell,
		"/usr/bin/true; echo \"status=$?\"; ( exec -c /usr/bin/true ); echo \"status=$?\"",
	)
	.await;
	assert_eq!(ran.stdout, "status=126\nstatus=0\n", "stderr {:?}", ran.stderr);
}
