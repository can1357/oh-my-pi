//! Shell operations must await provider I/O even on a current-thread runtime.

#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::{
	fs,
	io::{self, SeekFrom},
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use async_trait::async_trait;
use bytes::Bytes;
use omp_shell::{
	ShellExecuteOptions, StreamSinks,
	cancel::{AbortReason, CancelToken},
	execute_shell_streams,
};
use omp_vfs::{
	DirEntry, File, FileHandle, FileSystem, FileTime, Fs, Metadata, OpenOptions, Permissions,
	ReadDir, join_path,
};

#[derive(Debug)]
struct DelayedFilesystem {
	root:     PathBuf,
	seekable: bool,
}

impl DelayedFilesystem {
	fn path(&self, path: &Path) -> io::Result<PathBuf> {
		let relative = path
			.to_str()
			.and_then(|path| path.strip_prefix("virtual://"))
			.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "unmounted path"))?;
		if relative.split('/').any(|component| component == "..") {
			return Err(io::Error::new(io::ErrorKind::PermissionDenied, "outside mount"));
		}
		Ok(self.root.join(relative))
	}
}

async fn delay() {
	tokio::time::sleep(Duration::from_millis(1)).await;
}

#[async_trait]
impl FileSystem for DelayedFilesystem {
	fn is_native_local(&self, path: &Path) -> bool {
		!omp_vfs::is_virtual_path(path)
	}

	async fn backing_path(&self, path: &Path) -> io::Result<Option<PathBuf>> {
		delay().await;
		let Some(spelled) = path.to_str().filter(|path| path.starts_with("virtual://")) else {
			// A scheme this provider does not serve aliases nothing.
			return Ok(None);
		};
		// `virtual://rendered/…` stands in for a scheme that aliases no file
		// (`omp://`, `history://`): the provider serves it, but there is
		// nothing for the operating system to open.
		if spelled.starts_with("virtual://rendered") {
			return Ok(None);
		}
		self.path(path).map(Some)
	}

	/// `virtual://frozen/…` stands in for an immutable file-backed scheme
	/// (`skill://`): readable, but refusing every mutation.
	async fn access(&self, path: &Path, read: bool, write: bool, execute: bool) -> io::Result<()> {
		delay().await;
		if write
			&& path
				.to_str()
				.is_some_and(|path| path.starts_with("virtual://frozen"))
		{
			return Err(omp_vfs::read_only_filesystem());
		}
		Fs::native()
			.access(self.path(path)?, read, write, execute)
			.await
	}

	/// Opening `virtual://stalled` stands in for a stalled provider: the file
	/// it returns never completes a read.
	async fn open(&self, path: &Path, options: &OpenOptions) -> io::Result<File> {
		delay().await;
		if path.to_str() == Some("virtual://stalled") {
			return Ok(File::from_handle(StalledFile));
		}
		let file = Fs::native().open_with(self.path(path)?, options).await?;
		Ok(File::from_handle(DelayedFile { file, seekable: self.seekable }))
	}

	async fn metadata(&self, path: &Path) -> io::Result<Metadata> {
		delay().await;
		Fs::native().metadata(self.path(path)?).await
	}

	async fn symlink_metadata(&self, path: &Path) -> io::Result<Metadata> {
		delay().await;
		Fs::native().symlink_metadata(self.path(path)?).await
	}

	/// Listing `virtual://vanishing…` stands in for a directory another
	/// process deletes while it is refused to us: it is removed, then the
	/// listing fails with `PermissionDenied`.
	async fn read_dir(&self, path: &Path) -> io::Result<ReadDir> {
		delay().await;
		if path
			.to_str()
			.is_some_and(|path| path.starts_with("virtual://vanishing"))
		{
			Fs::native().remove_dir_all(self.path(path)?).await?;
			return Err(io::Error::from(io::ErrorKind::PermissionDenied));
		}
		let mut entries = Vec::new();
		for entry in Fs::native().read_dir(self.path(path)?).await? {
			let entry = entry?;
			let name = entry.file_name();
			let metadata = entry.metadata()?;
			entries.push(Ok(DirEntry::new(
				join_path(path, Path::new(&name)),
				name,
				Some(metadata.file_type()),
			)
			.with_metadata(metadata)));
		}
		Ok(ReadDir::from_entries(entries))
	}

	async fn create_dir(&self, path: &Path, mode: Option<u32>) -> io::Result<()> {
		delay().await;
		let mut options = omp_vfs::DirOptions::new();
		if let Some(mode) = mode {
			options = options.mode(mode);
		}
		Fs::native()
			.create_dir_with(self.path(path)?, &options)
			.await
	}

	/// Like any provider, this one cannot move entries to or from the host:
	/// `mv` between the two must fall back to copying.
	async fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
		delay().await;
		if !omp_vfs::is_virtual_path(from) || !omp_vfs::is_virtual_path(to) {
			return Err(omp_vfs::crosses_devices());
		}
		Fs::native().rename(self.path(from)?, self.path(to)?).await
	}

	// Symbolic links and special files keep the trait's `Unsupported`
	// default, as on vfat.
	async fn hard_link(&self, original: &Path, link: &Path) -> io::Result<()> {
		delay().await;
		Fs::native()
			.hard_link(self.path(original)?, self.path(link)?)
			.await
	}

	async fn remove_file(&self, path: &Path) -> io::Result<()> {
		delay().await;
		Fs::native().remove_file(self.path(path)?).await
	}

	async fn remove_dir(&self, path: &Path) -> io::Result<()> {
		delay().await;
		Fs::native().remove_dir(self.path(path)?).await
	}

	/// Changing `virtual://unsettable…` stands in for a directory another
	/// process deletes first: it is removed, then the change fails `NotFound`.
	async fn set_permissions(&self, path: &Path, permissions: Permissions) -> io::Result<()> {
		delay().await;
		let target = self.path(path)?;
		if path
			.to_str()
			.is_some_and(|path| path.starts_with("virtual://unsettable"))
		{
			let mut writable = Fs::native().metadata(&target).await?.permissions();
			writable.set_readonly(false);
			Fs::native().set_permissions(&target, writable).await?;
			Fs::native().remove_dir(&target).await?;
			return Err(io::Error::from(io::ErrorKind::NotFound));
		}
		Fs::native().set_permissions(target, permissions).await
	}

	async fn set_times(
		&self,
		path: &Path,
		accessed: FileTime,
		modified: FileTime,
		follow: bool,
	) -> io::Result<()> {
		delay().await;
		Fs::native()
			.set_times(self.path(path)?, accessed, modified, follow)
			.await
	}

	async fn chown(
		&self,
		path: &Path,
		uid: Option<u32>,
		gid: Option<u32>,
		follow: bool,
	) -> io::Result<()> {
		delay().await;
		Fs::native().chown(self.path(path)?, uid, gid, follow).await
	}
}

#[derive(Debug)]
struct DelayedFile {
	file:     File,
	seekable: bool,
}

#[async_trait]
impl FileHandle for DelayedFile {
	async fn read(&self, buffer: &mut [u8]) -> io::Result<usize> {
		delay().await;
		self.file.read_async(buffer).await
	}

	async fn write(&self, buffer: &[u8]) -> io::Result<usize> {
		delay().await;
		self.file.write_async(buffer).await
	}

	async fn seek(&self, position: SeekFrom) -> io::Result<u64> {
		if !self.seekable {
			return Err(omp_vfs::unsupported("seeking"));
		}
		delay().await;
		self.file.seek_async(position).await
	}

	async fn metadata(&self) -> io::Result<Metadata> {
		delay().await;
		self.file.metadata_async().await
	}

	async fn flush(&self) -> io::Result<()> {
		delay().await;
		self.file.flush_async().await
	}

	async fn set_len(&self, length: u64) -> io::Result<()> {
		delay().await;
		self.file.set_len_async(length).await
	}
}

/// `virtual://` served from `root` by a [`DelayedFilesystem`].
fn provider(root: &Path, seekable: bool) -> Fs {
	Fs::new(Arc::new(DelayedFilesystem { root: root.to_path_buf(), seekable }))
}

/// Options running `script` over `filesystem`, from the host directory `cwd`
/// when given.
fn script_options(filesystem: Fs, cwd: Option<&Path>, script: &str) -> ShellExecuteOptions {
	ShellExecuteOptions {
		command: script.to_owned(),
		cwd: cwd.map(|cwd| cwd.to_str().expect("UTF-8 working directory").to_owned()),
		filesystem,
		..Default::default()
	}
}

/// Raw stdout and stderr sinks, with the receivers that collect them.
fn stream_sinks() -> (StreamSinks, flume::Receiver<Bytes>, flume::Receiver<Bytes>) {
	let (stdout, stdout_chunks) = flume::unbounded();
	let (stderr, stderr_chunks) = flume::unbounded();
	(StreamSinks { stdout: Some(stdout), stderr: Some(stderr) }, stdout_chunks, stderr_chunks)
}

/// The text of every chunk received so far.
fn received_text(chunks: &flume::Receiver<Bytes>) -> String {
	let mut bytes = Vec::new();
	for chunk in chunks.try_iter() {
		bytes.extend_from_slice(&chunk);
	}
	String::from_utf8_lossy(&bytes).into_owned()
}

/// A finished run: its exit status and what it wrote to each stream.
#[derive(Debug)]
struct Captured {
	status: Option<i32>,
	stdout: String,
	stderr: String,
}

/// Runs `script` in a fresh session over `filesystem`, from the host
/// directory `cwd` when given.
async fn run_script(filesystem: Fs, cwd: Option<&Path>, script: &str) -> Captured {
	let (sinks, stdout, stderr) = stream_sinks();
	let result =
		execute_shell_streams(script_options(filesystem, cwd, script), sinks, CancelToken::default())
			.await
			.expect("filesystem-backed shell execution");
	Captured {
		status: result.exit_code,
		stdout: received_text(&stdout),
		stderr: received_text(&stderr),
	}
}

/// Runs `script` with `virtual://` backed by `root` from the shell's default
/// working directory.
async fn run_virtual(root: &Path, script: &str) -> Captured {
	run_script(provider(root, true), None, script).await
}

#[tokio::test]
async fn expanded_urls_redirect_and_edit_without_blocking_the_provider_runtime() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	let run = run_virtual(
		directory.path(),
		r#"scheme=virtual
p="${scheme}://input"
printf 'b\na\n' > "$p" &&
printf 'a\n' >> "$p" &&
sort "$p" | uniq > virtual://sorted &&
sed -i 's/a/A/' virtual://sorted &&
mkdir virtual://dir &&
mv virtual://sorted virtual://dir/result.txt &&
test -f virtual://dir/result.txt &&
cd virtual://dir &&
cat ./*.txt"#,
	)
	.await;
	assert_eq!(run.status, Some(0), "{}", run.stderr);
	assert_eq!(run.stdout, "A\nb\n");
	assert_eq!(fs::read(directory.path().join("input")).expect("appended source"), b"b\na\na\n");
	assert!(!directory.path().join("sorted").exists());
}

/// `xargs`, `ifne`, and `find -exec`/`-execdir` must dispatch their command
/// through the shell: only in-process builtins can open provider URLs, whereas
/// an external program is limited to the files those URLs alias.
#[tokio::test]
async fn command_running_utilities_dispatch_builtins_that_open_urls() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	fs::create_dir(directory.path().join("docs")).expect("provider directory");
	fs::write(directory.path().join("docs/a.txt"), b"alpha\n").expect("first document");
	fs::write(directory.path().join("docs/b.txt"), b"beta\n").expect("second document");
	let run = run_virtual(
		directory.path(),
		"printf 'virtual://docs/a.txt\\n' | xargs cat && echo go | ifne cat virtual://docs/b.txt && \
		 find virtual://docs -name b.txt -exec cat {} ';' && find virtual://docs -name a.txt \
		 -execdir cat {} ';'",
	)
	.await;
	assert_eq!(run.status, Some(0), "{}", run.stderr);
	assert_eq!(run.stdout, "alpha\nbeta\nbeta\nalpha\n");
}

/// `file` runs in process, so it identifies what a provider URL names by
/// reading it through the provider: a file by its contents, a directory by
/// its type, and a URL that names nothing as unopenable.
#[tokio::test]
async fn file_identifies_what_provider_urls_name() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	fs::create_dir(directory.path().join("docs")).expect("provider directory");
	fs::write(directory.path().join("docs/a.txt"), b"alpha\n").expect("text document");
	fs::write(directory.path().join("docs/i.gif"), b"GIF89a\x40\x01\xc8\x00\x80\0\0;")
		.expect("image");
	let run = run_virtual(
		directory.path(),
		"file -b virtual://docs/a.txt virtual://docs/i.gif virtual://docs virtual://docs/absent && \
		 file --mime-type virtual://docs/a.txt",
	)
	.await;
	assert_eq!(run.status, Some(0), "{}", run.stderr);
	assert_eq!(
		run.stdout,
		"ASCII text\nGIF image data, version 89a, 320 x 200\ndirectory\ncannot open \
		 `virtual://docs/absent' (No such file or directory)\nvirtual://docs/a.txt: text/plain\n"
	);
}

/// An external program cannot open a provider URL, so one it is handed must
/// name the file that URL aliases, in the bare spelling and in the
/// attached-value spelling a tool's own flags use. A scheme the filesystem
/// does not route is not a path and must reach the child as written, as must a
/// bare scheme root or one followed by words, which are far likelier a search
/// pattern than a directory.
#[tokio::test]
async fn external_commands_receive_host_paths_for_backed_url_arguments() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	fs::create_dir(directory.path().join("docs")).expect("provider directory");
	fs::write(directory.path().join("docs/a.txt"), b"alpha\n").expect("document");
	#[cfg(unix)]
	let script = r#"/bin/sh -c 'printf "%s\n" "$0" "$1" "$2" "$3" "$4" "$5" "$6" "$7"' virtual://docs/a.txt --data-dir=virtual://docs https://example.com/a.txt 'https://example.com/?next=virtual://docs' virtual:// --root=virtual:// 'virtual:// external command' '--search=virtual:// words'"#;
	#[cfg(windows)]
	let script = "cmd.exe /c echo virtual://docs/a.txt && cmd.exe /c echo \
	              --data-dir=virtual://docs && cmd.exe /c echo https://example.com/a.txt && \
	              cmd.exe /c echo 'https://example.com/?next=virtual://docs' && cmd.exe /c \
	              echo virtual:// && cmd.exe /c echo --root=virtual:// && cmd.exe /c echo \
	              'virtual:// external command' && cmd.exe /c echo '--search=virtual:// words'";
	let run = run_virtual(directory.path(), script).await;
	let stdout = run.stdout;
	assert_eq!(run.status, Some(0), "{}", run.stderr);
	// The provider aliases `virtual://x` to `root/x`, keeping the URL's own
	// separators, so the expectation is built the same way.
	let docs = directory.path().join("docs");
	assert!(
		stdout.contains(&directory.path().join("docs/a.txt").display().to_string()),
		"bare url reached the child unresolved: {stdout}"
	);
	assert!(
		stdout.contains(&format!("--data-dir={}", docs.display())),
		"attached value reached the child unresolved: {stdout}"
	);
	assert!(
		stdout.contains("https://example.com/a.txt"),
		"an unrouted scheme was rewritten: {stdout}"
	);
	assert!(
		stdout.contains("https://example.com/?next=virtual://docs"),
		"a url embedded in a query string was rewritten: {stdout}"
	);
	let lines: Vec<&str> = stdout.lines().map(str::trim).collect();
	assert!(
		lines.contains(&"virtual://") && lines.contains(&"--root=virtual://"),
		"a bare scheme root was rewritten: {stdout}"
	);
	assert!(
		stdout.contains("virtual:// external command")
			&& stdout.contains("--search=virtual:// words"),
		"a scheme root followed by words was rewritten: {stdout}"
	);
}

/// A URL the provider cannot resolve is as likely an identifier or message
/// text the program wants as written (`bm read memory://notes/x`), so the
/// child runs and receives it untouched. A program the provider rejects
/// cannot run at all.
#[tokio::test]
async fn external_commands_keep_url_arguments_the_provider_rejects() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	#[cfg(unix)]
	let script = "/bin/sh -c 'printf \"ran %s\" \"$1\"' sh virtual://../escape";
	#[cfg(windows)]
	let script = "cmd.exe /c echo ran virtual://../escape";
	let run = run_virtual(directory.path(), script).await;
	assert_eq!(run.status, Some(0), "{}", run.stderr);
	assert!(
		run.stdout.contains("ran virtual://../escape"),
		"a rejected url did not reach the child as written: {}",
		run.stdout
	);

	let run = run_virtual(directory.path(), "virtual://../escape").await;
	assert_ne!(run.status, Some(0), "a rejected program ran: {}", run.stdout);
}

/// Prints each of its arguments on a line of its own, prefixed with `$0`.
#[cfg(unix)]
const PROBE: &str = r#"/bin/sh -c 'for arg; do printf "%s:%s\n" "$0" "$arg"; done'"#;

/// The spellings that attach a path to an option reach the child with the
/// path resolved and the rest of the argument intact: a short option letter,
/// curl's and gh's `@file`, and both after a name. Message text that merely
/// starts with a URL is not a path unless a file has exactly that name.
#[cfg(unix)]
#[tokio::test]
async fn external_commands_receive_host_paths_for_attached_url_spellings() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	let docs = directory.path().join("docs");
	fs::create_dir(&docs).expect("provider directory");
	fs::write(docs.join("a.txt"), b"alpha\n").expect("document");
	fs::write(docs.join("my notes.txt"), b"spaced\n").expect("document with a space");
	let script = format!(
		"{PROBE} arg -ovirtual://docs/a.txt @virtual://docs/a.txt body=@virtual://docs/a.txt \
		 -d@virtual://docs/a.txt --data-binary=@virtual://docs/a.txt 'virtual://docs/my notes.txt' \
		 'virtual://docs/a.txt shows the failure' 'evidence=virtual://docs/a.txt; more' \
		 -xvirtual://rendered/page"
	);
	let run = run_virtual(directory.path(), &script).await;
	assert_eq!(run.status, Some(0), "{}", run.stderr);
	let file = docs.join("a.txt").display().to_string();
	let expected = [
		format!("arg:-o{file}"),
		format!("arg:@{file}"),
		format!("arg:body=@{file}"),
		format!("arg:-d@{file}"),
		format!("arg:--data-binary=@{file}"),
		format!("arg:{}", docs.join("my notes.txt").display()),
		"arg:virtual://docs/a.txt shows the failure".to_owned(),
		"arg:evidence=virtual://docs/a.txt; more".to_owned(),
		"arg:-xvirtual://rendered/page".to_owned(),
	];
	assert_eq!(run.stdout.lines().collect::<Vec<_>>(), expected);
}

/// A variable handed to a child (assigned on its command, by `env`, or
/// exported earlier) names the file its URL aliases, while the shell's own
/// copy keeps the URL. A web address and a URL the provider rejects are the
/// child's as written.
#[cfg(unix)]
#[tokio::test]
async fn external_commands_receive_host_paths_for_url_environment_values() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	let docs = directory.path().join("docs");
	fs::create_dir(&docs).expect("provider directory");
	fs::write(docs.join("a.txt"), b"alpha\n").expect("document");
	let script = "LEAF=virtual://docs/a.txt WEB=https://example.com/x GONE=virtual://../escape \
	              /bin/sh -c 'printf \"%s\\n\" \"$LEAF\" \"$WEB\" \"$GONE\"'; env \
	              VIA_ENV=virtual://docs /usr/bin/printenv VIA_ENV; export \
	              KEPT=virtual://docs/a.txt; /usr/bin/printenv KEPT; printf 'shell:%s\\n' \"$KEPT\"";
	let run = run_virtual(directory.path(), script).await;
	assert_eq!(run.status, Some(0), "{}", run.stderr);
	let file = docs.join("a.txt").display().to_string();
	let expected = [
		file.clone(),
		"https://example.com/x".to_owned(),
		"virtual://../escape".to_owned(),
		docs.display().to_string(),
		file,
		"shell:virtual://docs/a.txt".to_owned(),
	];
	assert_eq!(run.stdout.lines().collect::<Vec<_>>(), expected);
}

/// A command that runs another one hands it the same resolved paths as the
/// shell would: the utilities that run their operands (`env`, `xargs`,
/// `find -exec`, `timeout`, `nohup`), the shell's own prefixes (`time`,
/// `command`, `exec`), and a program that execs its arguments (`nice`).
#[cfg(unix)]
#[tokio::test]
async fn commands_run_through_a_wrapper_receive_host_paths_for_url_arguments() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	let docs = directory.path().join("docs");
	fs::create_dir(&docs).expect("provider directory");
	fs::write(docs.join("a.txt"), b"alpha\n").expect("document");
	let probe = |name: &str| format!("{PROBE} {name}");
	let script = format!(
		"env {env} virtual://docs/a.txt\nprintf 'virtual://docs/a.txt\\n' | xargs {xargs}\nfind \
		 virtual://docs -name a.txt -exec {find} {{}} \\;\ntimeout 30 {timeout} \
		 virtual://docs/a.txt\nnohup {nohup} virtual://docs/a.txt\ntime {time} \
		 virtual://docs/a.txt\ncommand {command} virtual://docs/a.txt\n(exec {exec} \
		 virtual://docs/a.txt)\nnice {nice} virtual://docs/a.txt\n",
		env = probe("env"),
		xargs = probe("xargs"),
		find = probe("find"),
		timeout = probe("timeout"),
		nohup = probe("nohup"),
		time = probe("time"),
		command = probe("command"),
		exec = probe("exec"),
		nice = probe("nice"),
	);
	let run = run_virtual(directory.path(), &script).await;
	assert_eq!(run.status, Some(0), "{}", run.stderr);
	let file = docs.join("a.txt").display().to_string();
	let expected: Vec<String> =
		["env", "xargs", "find", "timeout", "nohup", "time", "command", "exec", "nice"]
			.iter()
			.map(|name| format!("{name}:{file}"))
			.collect();
	assert_eq!(run.stdout.lines().collect::<Vec<_>>(), expected);
}

/// `omp` resolves the URLs it is given itself, selectors included, so its
/// arguments and environment reach it as written: run by name, by path, or
/// through a program that execs it.
#[cfg(unix)]
#[tokio::test]
async fn omp_receives_its_url_arguments_as_written() {
	use std::os::unix::fs::PermissionsExt;

	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	let docs = directory.path().join("docs");
	fs::create_dir(&docs).expect("provider directory");
	fs::write(docs.join("a.txt"), b"alpha\n").expect("document");
	let bin = tempfile::tempdir().expect("program directory");
	let omp = bin.path().join("omp");
	fs::write(&omp, b"#!/bin/sh\nprintf '%s\\n' \"$@\" \"ref=$REF\"\n").expect("stand-in omp");
	fs::set_permissions(&omp, fs::Permissions::from_mode(0o755)).expect("executable stand-in");
	let script = format!(
		"PATH='{bin}':$PATH; REF=virtual://docs/a.txt omp read virtual://docs/a.txt:1-2 \
		 --from=virtual://docs/a.txt; nice omp read virtual://docs; '{omp}' read \
		 @virtual://docs/a.txt",
		bin = bin.path().display(),
		omp = omp.display(),
	);
	let run = run_virtual(directory.path(), &script).await;
	assert_eq!(run.status, Some(0), "{}", run.stderr);
	let expected = [
		"read",
		"virtual://docs/a.txt:1-2",
		"--from=virtual://docs/a.txt",
		"ref=virtual://docs/a.txt",
		"read",
		"virtual://docs",
		"ref=",
		"read",
		"@virtual://docs/a.txt",
		"ref=",
	];
	assert_eq!(run.stdout.lines().collect::<Vec<_>>(), expected);
}

/// A provider directory that aliases a real one is a usable working directory
/// for a child process, and the `PWD` the child inherits names that same host
/// directory rather than the URL it cannot open; one that aliases nothing is
/// still no working directory at all.
#[tokio::test]
async fn external_commands_start_in_backed_working_directories_only() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	fs::create_dir(directory.path().join("docs")).expect("provider directory");
	fs::create_dir(directory.path().join("rendered")).expect("unbacked directory");
	fs::create_dir(directory.path().join("frozen")).expect("read-only directory");
	// `printenv` and `cmd /c echo` report the inherited variable; a shell would
	// re-derive `PWD` from `getcwd()` and hide a wrong value.
	#[cfg(unix)]
	let script = "cd virtual://docs && /bin/sh -c 'printf %s \"$PWD\"' && /usr/bin/printenv PWD";
	#[cfg(windows)]
	let script = "cd virtual://docs && cmd.exe /c cd && cmd.exe /c echo %PWD%";
	let run = run_virtual(directory.path(), script).await;
	assert_eq!(run.status, Some(0), "{}", run.stderr);
	let docs = directory.path().join("docs").display().to_string();
	assert!(
		run.stdout.matches(docs.as_str()).count() >= 2,
		"child saw the wrong working directory or inherited PWD: {}",
		run.stdout
	);

	#[cfg(unix)]
	let unbacked = "cd virtual://rendered && /bin/sh -c 'exit 0'";
	#[cfg(windows)]
	let unbacked = "cd virtual://rendered && cmd.exe /c exit 0";
	let run = run_virtual(directory.path(), unbacked).await;
	assert_ne!(run.status, Some(0), "an unbacked directory hosted a child process");
	assert!(run.stderr.contains("virtual working directory"), "unexpected failure: {}", run.stderr);

	// A child may write anywhere under its working directory, so a directory
	// the shell refuses to mutate is no working directory for one either.
	#[cfg(unix)]
	let frozen = "cd virtual://frozen && /bin/sh -c 'exit 0'";
	#[cfg(windows)]
	let frozen = "cd virtual://frozen && cmd.exe /c exit 0";
	let run = run_virtual(directory.path(), frozen).await;
	assert_ne!(run.status, Some(0), "a read-only directory hosted a child process");
	assert!(
		run.stderr.contains("read-only working directory"),
		"unexpected failure: {}",
		run.stderr
	);
}

/// A script the provider aliases is executable as itself: the child runs the
/// file behind the URL rather than failing on a path the kernel cannot see.
#[cfg(unix)]
#[tokio::test]
async fn an_executable_url_runs_as_the_file_it_aliases() {
	use std::os::unix::fs::PermissionsExt;

	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	let tool = directory.path().join("tool");
	fs::write(&tool, b"#!/bin/sh\nprintf tool-ran\n").expect("provider script");
	fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).expect("executable script");
	let run = run_virtual(directory.path(), "virtual://tool").await;
	assert_eq!(run.status, Some(0), "{}", run.stderr);
	assert_eq!(run.stdout, "tool-ran");
}

/// The same contract on Windows, where an executable is recognized by its
/// extension rather than by its mode bits.
#[cfg(windows)]
#[tokio::test]
async fn an_executable_url_runs_as_the_file_it_aliases() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	fs::write(directory.path().join("tool.cmd"), b"@echo tool-ran\r\n").expect("provider script");
	let run = run_virtual(directory.path(), "virtual://tool.cmd").await;
	assert_eq!(run.status, Some(0), "{}", run.stderr);
	assert!(run.stdout.contains("tool-ran"), "{}", run.stdout);
}

/// Appends streamed stdout `chunks` to `output` until it ends with `suffix`.
async fn wait_for_output(
	chunks: &flume::Receiver<Bytes>,
	output: &mut Vec<u8>,
	suffix: &str,
) -> io::Result<()> {
	tokio::time::timeout(Duration::from_secs(5), async {
		while !output.ends_with(suffix.as_bytes()) {
			let chunk = chunks
				.recv_async()
				.await
				.map_err(|error| io::Error::new(io::ErrorKind::UnexpectedEof, error))?;
			output.extend_from_slice(&chunk);
		}
		Ok(())
	})
	.await
	.map_err(|error| io::Error::new(io::ErrorKind::TimedOut, error))?
}

#[tokio::test]
async fn virtual_follow_observes_append_same_size_rotation_and_truncation() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	let file = directory.path().join("follow");
	fs::write(&file, b"initial\n").expect("initial content");
	let (sinks, stdout, stderr) = stream_sinks();
	let mut cancel = CancelToken::default();
	let abort = cancel.emplace_abort_token();
	let runner = tokio::spawn(execute_shell_streams(
		script_options(
			provider(directory.path(), true),
			None,
			"tail -n 1 --sleep-interval=.01 --max-unchanged-stats=0 -F virtual://follow",
		),
		sinks,
		cancel,
	));
	let mut output = Vec::new();
	let updates: io::Result<()> = async {
		wait_for_output(&stdout, &mut output, "initial\n").await?;
		let mut append = fs::OpenOptions::new().append(true).open(&file)?;
		io::Write::write_all(&mut append, b"appended\n")?;
		wait_for_output(&stdout, &mut output, "appended\n").await?;
		let replacement = directory.path().join("replacement");
		fs::write(&replacement, b"rotation-content\n")?;
		fs::rename(&replacement, &file)?;
		wait_for_output(&stdout, &mut output, "rotation-content\n").await?;
		fs::write(&file, b"x\n")?;
		wait_for_output(&stdout, &mut output, "x\n").await
	}
	.await;
	abort.abort(AbortReason::Signal);
	tokio::time::timeout(Duration::from_secs(5), runner)
		.await
		.expect("cancelled tail exits")
		.expect("tail worker")
		.expect("tail command");
	updates.expect("each provider transition reaches stdout");
	let diagnostics = received_text(&stderr);
	assert!(diagnostics.contains("has been replaced"), "{diagnostics}");
	assert!(diagnostics.contains("file truncated"), "{diagnostics}");
	for chunk in stdout.try_iter() {
		output.extend_from_slice(&chunk);
	}
	assert_eq!(String::from_utf8_lossy(&output), "initial\nappended\nrotation-content\nx\n");
}

/// A provider path has no kernel watcher, so `tail -f` polls it; that idle
/// loop must still stop once the reader of its stdout pipe exits, as in
/// `tail -f virtual://log | grep -m1 line`.
#[cfg(unix)]
#[tokio::test]
async fn virtual_follow_stops_once_stdout_reader_is_gone() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	fs::write(directory.path().join("log"), b"line\n").expect("followed log");
	let (sinks, stdout, stderr) = stream_sinks();
	let mut cancel = CancelToken::default();
	let abort = cancel.emplace_abort_token();
	// `grep -m1` consumes the first line, then exits and closes the read end;
	// the pipeline ends only once `tail -f` stops too.
	let runner = tokio::spawn(execute_shell_streams(
		script_options(
			provider(directory.path(), true),
			None,
			"tail -f --sleep-interval=.01 virtual://log | grep -m1 line",
		),
		sinks,
		cancel,
	));
	let stopped = tokio::time::timeout(Duration::from_secs(5), runner).await;
	abort.abort(AbortReason::Signal);
	let result = stopped
		.expect("tail -f kept following after its reader exited")
		.expect("tail worker")
		.expect("tail command");
	assert_eq!(received_text(&stdout), "line\n");
	assert_eq!(result.exit_code, Some(0), "{}", received_text(&stderr));
}

#[cfg(unix)]
#[tokio::test]
async fn backed_urls_expose_physical_paths_without_changing_native_readlink() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	fs::write(directory.path().join("target"), b"content").expect("backing file");
	symlink("target", directory.path().join("alias")).expect("native relative link");
	let run = run_script(
		provider(directory.path(), true),
		Some(directory.path()),
		"realpath virtual://alias && readlink virtual://alias && readlink alias && realpath -m \
		 virtual://missing/leaf && realpath --relative-to=virtual:// virtual://alias",
	)
	.await;
	assert_eq!(run.status, Some(0), "{}", run.stderr);
	let root = fs::canonicalize(directory.path()).expect("physical backing root");
	let target = root.join("target");
	assert_eq!(
		run.stdout,
		format!(
			"{}\n{}\ntarget\n{}\ntarget\n",
			target.display(),
			target.display(),
			root.join("missing/leaf").display(),
		)
	);
	assert!(!directory.path().join("missing").exists());
}

/// The operating system resolves a host symlink and cannot read a URL, so
/// `ln -s` to a host path stores the file a backed URL aliases; a URL that
/// aliases nothing keeps its spelling.
#[cfg(unix)]
#[tokio::test]
async fn host_symlinks_to_backed_urls_store_the_backing_path() {
	let provider = tempfile::tempdir().expect("isolated provider filesystem");
	let host = tempfile::tempdir().expect("host working directory");
	fs::write(provider.path().join("target"), b"content").expect("backing file");

	let (code, error) = run_from_host_dir(
		provider.path(),
		host.path(),
		"mkdir sub && ln -s virtual://target link && ln -s virtual://missing dangling && ln -sr \
		 virtual://target sub/relative && ln -s virtual://rendered/x rendered",
	)
	.await;
	assert_eq!(code, 0, "{error}");

	assert_eq!(fs::read_link(host.path().join("link")).unwrap(), provider.path().join("target"));
	assert_eq!(fs::read(host.path().join("link")).unwrap(), b"content");
	assert_eq!(
		fs::read_link(host.path().join("dangling")).unwrap(),
		provider.path().join("missing")
	);
	let relative = fs::read_link(host.path().join("sub/relative")).unwrap();
	assert!(relative.is_relative(), "{}", relative.display());
	assert_eq!(fs::read(host.path().join("sub/relative")).unwrap(), b"content");
	assert_eq!(
		fs::read_link(host.path().join("rendered")).unwrap(),
		Path::new("virtual://rendered/x")
	);
}

#[tokio::test]
async fn cmp_compares_nonseekable_files_and_discards_requested_prefixes() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	fs::write(directory.path().join("left"), b"aa-shared\n").expect("left stream");
	fs::write(directory.path().join("right"), b"bb-shared\n").expect("right stream");
	let run = run_script(
		provider(directory.path(), false),
		None,
		"cmp -s virtual://left virtual://left && { cmp -s virtual://left virtual://right; test \
		 \"$?\" -eq 1; } && cmp -i 2 virtual://left virtual://right",
	)
	.await;
	assert_eq!(run.status, Some(0), "{}", run.stderr);
}

/// Runs `script` from the host directory `cwd` with `virtual://` backed by
/// `provider_root`, returning the exit status and stderr.
#[cfg(any(unix, windows))]
async fn run_from_host_dir(provider_root: &Path, cwd: &Path, script: &str) -> (i32, String) {
	let run = run_script(provider(provider_root, true), Some(cwd), script).await;
	(run.status.expect("exit status"), run.stderr)
}

/// A directory `rm` cannot list may still be removable; if another process
/// deleted it meanwhile, `-f` counts it as removed instead of reporting the
/// listing's `Permission denied`.
#[cfg(unix)]
#[tokio::test]
async fn forced_rm_of_a_directory_gone_while_refused_succeeds() {
	let provider = tempfile::tempdir().expect("isolated provider filesystem");
	let host = tempfile::tempdir().expect("host working directory");
	let run = async |script: &str| {
		fs::create_dir_all(provider.path().join("vanishing/child")).expect("doomed tree");
		run_from_host_dir(provider.path(), host.path(), script).await
	};

	assert_eq!(run("rm -rf virtual://vanishing").await, (0, String::new()));
	assert!(!provider.path().join("vanishing").exists());
	let (code, error) = run("rm -r virtual://vanishing").await;
	assert_eq!(code, 1);
	assert!(error.contains("Permission denied"), "{error}");
}

/// On Windows `rm` clears a directory's read-only attribute to remove it;
/// if another process deleted it meanwhile, `-f` counts it as removed
/// instead of reporting the first attempt's `Permission denied`.
#[cfg(windows)]
#[tokio::test]
async fn forced_rm_of_a_read_only_directory_gone_mid_retry_succeeds() {
	let provider = tempfile::tempdir().expect("isolated provider filesystem");
	let host = tempfile::tempdir().expect("host working directory");
	let dir = provider.path().join("unsettable");
	fs::create_dir(&dir).expect("read-only directory");
	let mut permissions = fs::metadata(&dir).expect("metadata").permissions();
	permissions.set_readonly(true);
	fs::set_permissions(&dir, permissions).expect("read-only attribute");

	assert_eq!(
		run_from_host_dir(provider.path(), host.path(), "rm -rf virtual://unsettable").await,
		(0, String::new())
	);
	assert!(!dir.exists());
}

/// A rename from the host into a provider is `EXDEV`, so `mv` copies and
/// removes: the copy must keep modes and modification times, and names of
/// one file given as separate operands must stay one file.
#[cfg(unix)]
#[tokio::test]
async fn cross_device_mv_keeps_modes_times_and_hard_links() {
	use std::os::unix::fs::{MetadataExt, PermissionsExt};

	let provider = tempfile::tempdir().expect("isolated provider filesystem");
	let host = tempfile::tempdir().expect("host directory");
	let tree = host.path().join("tree");
	fs::create_dir_all(tree.join("sub")).expect("source tree");
	fs::write(tree.join("sub/tool"), b"#!/bin/sh\n").expect("source file");
	let modified = std::time::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
	fs::File::options()
		.write(true)
		.open(tree.join("sub/tool"))
		.and_then(|file| file.set_modified(modified))
		.expect("old modification time");
	fs::set_permissions(tree.join("sub/tool"), fs::Permissions::from_mode(0o751))
		.expect("file mode");
	fs::set_permissions(tree.join("sub"), fs::Permissions::from_mode(0o750)).expect("dir mode");
	fs::write(host.path().join("a"), b"shared").expect("linked file");
	fs::hard_link(host.path().join("a"), host.path().join("b")).expect("second name");

	let (status, stderr) = run_from_host_dir(
		provider.path(),
		host.path(),
		"mv tree virtual://tree && mkdir virtual://dest && mv a b virtual://dest",
	)
	.await;
	assert_eq!(status, 0, "{stderr}");
	assert!(!tree.exists() && !host.path().join("a").exists() && !host.path().join("b").exists());

	let moved = provider.path().join("tree/sub/tool");
	let metadata = fs::metadata(&moved).expect("moved file");
	assert_eq!(metadata.mode() & 0o7777, 0o751);
	assert_eq!(metadata.modified().expect("moved mtime"), modified);
	let dir_mode = fs::metadata(provider.path().join("tree/sub"))
		.expect("moved dir")
		.mode();
	assert_eq!(dir_mode & 0o7777, 0o750);
	let a = fs::metadata(provider.path().join("dest/a")).expect("first name");
	let b = fs::metadata(provider.path().join("dest/b")).expect("second name");
	assert_eq!((a.dev(), a.ino()), (b.dev(), b.ino()));
	assert_eq!(a.nlink(), 2);
}

/// An entry inside a tree that cannot be copied fails the move: `mv` reports
/// it, exits 1, and keeps the whole source tree.
#[cfg(unix)]
#[tokio::test]
async fn cross_device_mv_keeps_a_tree_with_an_entry_it_could_not_copy() {
	let provider = tempfile::tempdir().expect("isolated provider filesystem");
	let host = tempfile::tempdir().expect("host directory");
	let tree = host.path().join("tree");
	fs::create_dir(&tree).expect("source tree");
	fs::write(tree.join("file"), b"data").expect("source file");
	// The provider supports no special files.
	drop(std::os::unix::net::UnixListener::bind(tree.join("socket")).expect("source socket"));

	let (status, stderr) =
		run_from_host_dir(provider.path(), host.path(), "mv tree virtual://tree").await;
	assert_eq!(status, 1, "{stderr}");
	assert!(stderr.contains("cannot create special file"), "{stderr}");
	assert!(tree.join("file").is_file());
	assert!(fs::symlink_metadata(tree.join("socket")).is_ok());
}

/// A symlink the destination cannot hold (vfat, here a provider without
/// links) fails the move like any other entry. `mv` used to drop the error
/// and then delete the source link.
#[cfg(unix)]
#[tokio::test]
async fn cross_device_mv_keeps_a_symlink_it_could_not_copy() {
	let provider = tempfile::tempdir().expect("isolated provider filesystem");
	let host = tempfile::tempdir().expect("host directory");
	let tree = host.path().join("tree");
	fs::create_dir(&tree).expect("source tree");
	fs::write(tree.join("file"), b"data").expect("source file");
	symlink("file", tree.join("link")).expect("source link");

	let (status, stderr) =
		run_from_host_dir(provider.path(), host.path(), "mv tree virtual://tree").await;
	assert_eq!(status, 1, "{stderr}");
	assert!(stderr.contains("symbolic link"), "{stderr}");
	assert_eq!(fs::read_link(tree.join("link")).expect("source link kept"), Path::new("file"));
	assert!(tree.join("file").is_file());
}

/// A provider file whose reads never complete, as a stalled provider's.
#[derive(Debug)]
struct StalledFile;

#[async_trait]
impl FileHandle for StalledFile {
	async fn read(&self, _buffer: &mut [u8]) -> io::Result<usize> {
		std::future::pending().await
	}

	async fn write(&self, buffer: &[u8]) -> io::Result<usize> {
		Ok(buffer.len())
	}

	async fn seek(&self, _position: SeekFrom) -> io::Result<u64> {
		Err(omp_vfs::unsupported("seeking"))
	}

	async fn metadata(&self) -> io::Result<Metadata> {
		Err(omp_vfs::unsupported("metadata"))
	}
}

/// Provider-backed stdin has no descriptor to poll, and its file observes the
/// cancellation of the command that opened it, not of the `timeout` operand
/// reading it, so the limit did not stop a read the provider never completed
/// and `timeout` never returned.
///
/// The run gets a runtime of its own on another thread, which this test leaves
/// behind when it ends: a read the limit does not stop holds a blocking task
/// forever, and dropping its runtime would wait for that task.
#[test]
fn timeout_stops_a_utility_reading_stalled_provider_stdin() {
	let (sender, result) = std::sync::mpsc::channel();
	std::thread::spawn(move || {
		let runtime = tokio::runtime::Builder::new_multi_thread()
			.enable_all()
			.build()
			.expect("test runtime");
		let ran = runtime.block_on(async {
			let directory = tempfile::tempdir().expect("isolated provider filesystem");
			// The provider opens `virtual://stalled` as a `StalledFile`, so the
			// redirect hands `cat` provider-backed stdin whose read never
			// completes.
			let run = run_virtual(directory.path(), "timeout 0.2 cat < virtual://stalled").await;
			(run.status, run.stderr)
		});
		let _ = sender.send(ran);
		runtime.shutdown_background();
	});

	let (status, stderr) = result
		.recv_timeout(Duration::from_secs(5))
		.expect("`timeout` waited for the stalled read");
	assert_eq!(status, Some(124), "{stderr}");
}

/// Resolving a URL argument awaits the provider and the spawned child's
/// output is pumped by the same runtime: on a current-thread runtime both
/// must progress cooperatively, and a delayed writer must still reach the
/// pipeline's reader.
#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn url_spawn_and_output_pumps_run_on_a_current_thread_runtime() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	fs::write(directory.path().join("a.txt"), b"alpha\n").expect("document");
	let run = tokio::time::timeout(
		Duration::from_secs(5),
		run_virtual(
			directory.path(),
			"/bin/sh -c 'printf \"%s\\n\" \"$0\"; sleep 0.05; echo late' virtual://a.txt | /bin/cat",
		),
	)
	.await
	.expect("a URL spawn and its output pump progress on the only runtime thread");
	assert_eq!(run.status, Some(0), "{}", run.stderr);
	assert!(run.stdout.ends_with("a.txt\nlate\n"), "{}", run.stdout);
}

/// `direnv exec` runs its command in the shell, not as a program of its own:
/// the command it starts from an allowed `.envrc`'s environment still opens
/// provider URLs, which no spawned process could.
#[cfg(unix)]
#[tokio::test]
async fn direnv_exec_commands_open_provider_urls() {
	let provider_root = tempfile::tempdir().expect("isolated provider filesystem");
	fs::write(provider_root.path().join("a.txt"), b"alpha\n").expect("document");
	let host = tempfile::tempdir().expect("host working directory");
	fs::write(host.path().join(".envrc"), "export GREETING=hello\n").expect(".envrc");
	let run = run_script(
		provider(provider_root.path(), true),
		Some(host.path()),
		"export HOME=\"$PWD/home\" XDG_DATA_HOME=\"$PWD/data\" XDG_CONFIG_HOME=\"$PWD/config\" \
		 XDG_CACHE_HOME=\"$PWD/cache\"\nunset DIRENV_DIFF DIRENV_DIR DIRENV_FILE DIRENV_WATCHES \
		 DIRENV_CONFIG DIRENV_EXE_PATH\ndirenv allow && direnv exec . cat virtual://a.txt && direnv \
		 exec . printenv GREETING",
	)
	.await;
	assert_eq!(run.status, Some(0), "{}", run.stderr);
	assert_eq!(run.stdout, "alpha\nhello\n");
}
