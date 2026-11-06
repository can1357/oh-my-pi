//! Hand-written because this spawn refusal needs a filesystem provider, which
//! the recorded Bash corpus cannot supply. The provider refuses a URL
//! argument's backing path with EACCES; the real shell must name the resolved
//! command even when the host wraps that error without an errno.

#![cfg(unix)]

use std::{
	collections::HashMap,
	io,
	os::unix::fs::PermissionsExt,
	path::{Path, PathBuf},
	sync::Arc,
};

use async_trait::async_trait;
use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};
use pi_vfs::{File, FileSystem, Fs, Metadata, OpenOptions, ReadDir};

#[derive(Debug)]
struct RefusingUrl;

#[async_trait]
impl FileSystem for RefusingUrl {
	fn is_native_local(&self, path: &Path) -> bool {
		!pi_vfs::is_virtual_path(path)
	}

	async fn open(&self, path: &Path, options: &OpenOptions) -> io::Result<File> {
		Fs::native().open_with(path, options).await
	}

	async fn metadata(&self, path: &Path) -> io::Result<Metadata> {
		Fs::native().metadata(path).await
	}

	async fn read_dir(&self, path: &Path) -> io::Result<ReadDir> {
		Fs::native().read_dir(path).await
	}

	async fn backing_path(&self, path: &Path) -> io::Result<Option<PathBuf>> {
		if path
			.to_str()
			.is_some_and(|path| path.starts_with("refusal://"))
		{
			Err(io::Error::from_raw_os_error(libc::EACCES))
		} else {
			Ok(None)
		}
	}
}

#[tokio::test]
async fn non_errno_spawn_refusal_keeps_the_resolved_command_name() {
	let cases = [
		("path", "PATH=bin:/usr/bin:/bin; x refusal://missing/file", "bin/x"),
		("hash", "hash -p bin/x q; q refusal://missing/file", "./bin/x"),
		("exec", "exec ./bin/x refusal://missing/file", "{D}/bin/x"),
		("attached-url", "PATH=bin:/usr/bin:/bin; x --source=refusal://missing/file", "bin/x"),
		("slash-word", "./bin/x refusal://missing/file", "./bin/x"),
		("exec-argv0", "exec -a disguised ./bin/x refusal://missing/file", "{D}/bin/x"),
	];
	let mut differing = Vec::new();
	for (id, script, name) in cases {
		let dir = tempfile::Builder::new()
			.prefix("spawn-refusal")
			.tempdir()
			.expect("case directory");
		let home = dir.path().display().to_string();
		std::fs::create_dir(dir.path().join("bin")).expect("fixture directory");
		let fixture = dir.path().join("bin/x");
		std::fs::copy("/bin/true", &fixture).expect("real native executable");
		std::fs::set_permissions(&fixture, std::fs::Permissions::from_mode(0o755))
			.expect("executable fixture");
		let env: HashMap<String, String> = [
			("PATH", "/usr/bin:/bin"),
			("LC_ALL", "C.UTF-8"),
			("TERM", "dumb"),
			("HOME", home.as_str()),
		]
		.into_iter()
		.map(|(key, value)| (key.to_owned(), value.to_owned()))
		.collect();
		let stdout = dir.path().join("stdout.bin");
		let stderr = dir.path().join("stderr.bin");
		let result = Shell::new(None)
			.run(
				ShellRunOptions {
					command: format!("exec >'{}' 2>'{}'; {script}", stdout.display(), stderr.display()),
					cwd: Some(home.clone()),
					env: Some(env),
					filesystem: Some(Fs::new(Arc::new(RefusingUrl))),
					..Default::default()
				},
				None,
				CancelToken::new(Some(30_000)),
			)
			.await
			.expect("run the shell consumer");
		let out = std::fs::read(stdout).expect("captured stdout");
		let err = std::fs::read(stderr).expect("captured stderr");
		let name = name.replace("{D}", &home);
		let expected = format!(
			"bash: line 1: {name}: cannot execute: cannot resolve refusal://missing/file for an \
			 external command: Permission denied (os error 13)\n",
		);
		if result.exit_code != Some(126) || !out.is_empty() || err != expected.as_bytes() {
			differing.push(format!(
				"{id}: expected status=126 stdout=[] stderr={expected:?}; got status={:?} \
				 stdout={out:?} stderr={:?}",
				result.exit_code,
				String::from_utf8_lossy(&err),
			));
		}
	}
	assert!(differing.is_empty(), "{} rows differ:\n{}", differing.len(), differing.join("\n"));
}
