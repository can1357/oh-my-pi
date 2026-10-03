//! Shell operations must await provider I/O even on a current-thread runtime.

#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::{
	fs,
	io::{self, Read, Seek, SeekFrom},
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use async_trait::async_trait;
use brush_core::{
	ExecutionParameters, ProfileLoadBehavior, RcLoadBehavior, Shell, SourceInfo,
	openfiles::{self, OpenFile, OpenFiles},
};
use pi_builtins::{BuiltinSet, default_builtins, utility_builtins};
use pi_vfs::{
	DirEntry, File, FileHandle, FileSystem, Fs, Metadata, OpenOptions, Permissions, ReadDir,
	join_path,
};
use tokio_util::sync::CancellationToken;

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
		!pi_vfs::is_virtual_path(path)
	}

	async fn backing_path(&self, path: &Path) -> io::Result<Option<PathBuf>> {
		delay().await;
		self.path(path).map(Some)
	}

	async fn open(&self, path: &Path, options: &OpenOptions) -> io::Result<File> {
		delay().await;
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

	async fn read_dir(&self, path: &Path) -> io::Result<ReadDir> {
		delay().await;
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
		let mut options = pi_vfs::DirOptions::new();
		if let Some(mode) = mode {
			options = options.mode(mode);
		}
		Fs::native()
			.create_dir_with(self.path(path)?, &options)
			.await
	}

	async fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
		delay().await;
		Fs::native().rename(self.path(from)?, self.path(to)?).await
	}

	async fn remove_file(&self, path: &Path) -> io::Result<()> {
		delay().await;
		Fs::native().remove_file(self.path(path)?).await
	}

	async fn set_permissions(&self, path: &Path, permissions: Permissions) -> io::Result<()> {
		delay().await;
		Fs::native()
			.set_permissions(self.path(path)?, permissions)
			.await
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
			return Err(pi_vfs::unsupported("seeking"));
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

async fn virtual_shell(root: &Path) -> Shell {
	let mut shell = Shell::builder()
		.do_not_inherit_env(true)
		.profile(ProfileLoadBehavior::Skip)
		.rc(RcLoadBehavior::Skip)
		.builtins(default_builtins(BuiltinSet::BashMode))
		.build()
		.await
		.expect("shell");
	for (name, builtin) in utility_builtins() {
		shell.register_builtin(name, builtin);
	}
	shell.set_filesystem(Fs::new(Arc::new(DelayedFilesystem {
		root:     root.to_path_buf(),
		seekable: true,
	})));
	shell
}

fn capture_parameters(shell: &Shell, output: &fs::File, error: &fs::File) -> ExecutionParameters {
	let mut parameters = shell.default_exec_params();
	parameters.set_fd(OpenFiles::STDIN_FD, openfiles::null().expect("null stdin"));
	parameters
		.set_fd(OpenFiles::STDOUT_FD, OpenFile::from(output.try_clone().expect("stdout descriptor")));
	parameters
		.set_fd(OpenFiles::STDERR_FD, OpenFile::from(error.try_clone().expect("stderr descriptor")));
	parameters
}

fn captured_text(mut file: &fs::File) -> String {
	file.rewind().expect("rewind capture");
	let mut text = String::new();
	file.read_to_string(&mut text).expect("read capture");
	text
}

#[tokio::test]
async fn expanded_urls_redirect_and_edit_without_blocking_the_provider_runtime() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	let output = tempfile::tempfile().expect("captured stdout");
	let error = tempfile::tempfile().expect("captured stderr");
	let mut shell = virtual_shell(directory.path()).await;
	let parameters = capture_parameters(&shell, &output, &error);
	let result = shell
		.run_string(
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
			&SourceInfo::from("vfs-regression"),
			&parameters,
		)
		.await
		.expect("filesystem-backed shell execution");
	let stdout = captured_text(&output);
	let stderr = captured_text(&error);
	assert_eq!(u8::from(result.exit_code), 0, "{stderr}");
	assert_eq!(stdout, "A\nb\n");
	assert_eq!(fs::read(directory.path().join("input")).expect("appended source"), b"b\na\na\n");
	assert!(!directory.path().join("sorted").exists());
}

/// `xargs`, `ifne`, and `find -exec`/`-execdir` must dispatch their command
/// through the shell: only in-process builtins can open provider URLs, and an
/// external program cannot even start in a provider working directory.
#[tokio::test]
async fn command_running_utilities_dispatch_builtins_that_open_urls() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	fs::create_dir(directory.path().join("docs")).expect("provider directory");
	fs::write(directory.path().join("docs/a.txt"), b"alpha\n").expect("first document");
	fs::write(directory.path().join("docs/b.txt"), b"beta\n").expect("second document");
	let output = tempfile::tempfile().expect("captured stdout");
	let error = tempfile::tempfile().expect("captured stderr");
	let mut shell = virtual_shell(directory.path()).await;
	let parameters = capture_parameters(&shell, &output, &error);
	let result = shell
		.run_string(
			"printf 'virtual://docs/a.txt\\n' | xargs cat && echo go | ifne cat virtual://docs/b.txt \
			 && find virtual://docs -name b.txt -exec cat {} ';' && find virtual://docs -name a.txt \
			 -execdir cat {} ';'",
			&SourceInfo::from("vfs-command-runners"),
			&parameters,
		)
		.await
		.expect("command-running utilities");
	assert_eq!(u8::from(result.exit_code), 0, "{}", captured_text(&error));
	assert_eq!(captured_text(&output), "alpha\nbeta\nbeta\nalpha\n");
}

async fn wait_for_output(path: &Path, suffix: &str) -> io::Result<()> {
	tokio::time::timeout(Duration::from_secs(5), async {
		loop {
			if tokio::fs::read_to_string(path).await?.ends_with(suffix) {
				return Ok(());
			}
			tokio::time::sleep(Duration::from_millis(5)).await;
		}
	})
	.await
	.map_err(|error| io::Error::new(io::ErrorKind::TimedOut, error))?
}

#[tokio::test]
async fn virtual_follow_observes_append_same_size_rotation_and_truncation() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	let output = tempfile::NamedTempFile::new().expect("captured stdout");
	let error = tempfile::tempfile().expect("captured stderr");
	let file = directory.path().join("follow");
	fs::write(&file, b"initial\n").expect("initial content");
	let mut shell = virtual_shell(directory.path()).await;
	let mut parameters = capture_parameters(&shell, output.as_file(), &error);
	let cancel = CancellationToken::new();
	parameters.set_cancel_token(cancel.clone());
	let runner = tokio::spawn(async move {
		shell
			.run_string(
				"tail -n 1 --sleep-interval=.01 --max-unchanged-stats=0 -F virtual://follow",
				&SourceInfo::from("vfs-follow"),
				&parameters,
			)
			.await
	});
	let updates: io::Result<()> = async {
		wait_for_output(output.path(), "initial\n").await?;
		let mut append = fs::OpenOptions::new().append(true).open(&file)?;
		io::Write::write_all(&mut append, b"appended\n")?;
		wait_for_output(output.path(), "appended\n").await?;
		let replacement = directory.path().join("replacement");
		fs::write(&replacement, b"rotation-content\n")?;
		fs::rename(&replacement, &file)?;
		wait_for_output(output.path(), "rotation-content\n").await?;
		fs::write(&file, b"x\n")?;
		wait_for_output(output.path(), "x\n").await
	}
	.await;
	cancel.cancel();
	tokio::time::timeout(Duration::from_secs(5), runner)
		.await
		.expect("cancelled tail exits")
		.expect("tail worker")
		.expect("tail command");
	updates.expect("each provider transition reaches stdout");
	let diagnostics = captured_text(&error);
	assert!(diagnostics.contains("has been replaced"), "{diagnostics}");
	assert!(diagnostics.contains("file truncated"), "{diagnostics}");
	assert_eq!(
		fs::read_to_string(output.path()).expect("captured output"),
		"initial\nappended\nrotation-content\nx\n"
	);
}

#[cfg(unix)]
#[tokio::test]
async fn backed_urls_expose_physical_paths_without_changing_native_readlink() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	fs::write(directory.path().join("target"), b"content").expect("backing file");
	symlink("target", directory.path().join("alias")).expect("native relative link");
	let output = tempfile::tempfile().expect("captured stdout");
	let error = tempfile::tempfile().expect("captured stderr");
	let mut shell = virtual_shell(directory.path()).await;
	shell
		.set_working_dir(directory.path())
		.await
		.expect("native working directory");
	let parameters = capture_parameters(&shell, &output, &error);
	let result = shell
		.run_string(
			"realpath virtual://alias && readlink virtual://alias && readlink alias && realpath -m \
			 virtual://missing/leaf && realpath --relative-to=virtual:// virtual://alias",
			&SourceInfo::from("vfs-backing-path"),
			&parameters,
		)
		.await
		.expect("backing path commands");
	assert_eq!(u8::from(result.exit_code), 0, "{}", captured_text(&error));
	let root = fs::canonicalize(directory.path()).expect("physical backing root");
	let target = root.join("target");
	assert_eq!(
		captured_text(&output),
		format!(
			"{}\n{}\ntarget\n{}\ntarget\n",
			target.display(),
			target.display(),
			root.join("missing/leaf").display(),
		)
	);
	assert!(!directory.path().join("missing").exists());
}

#[tokio::test]
async fn cmp_compares_nonseekable_files_and_discards_requested_prefixes() {
	let directory = tempfile::tempdir().expect("isolated provider filesystem");
	fs::write(directory.path().join("left"), b"aa-shared\n").expect("left stream");
	fs::write(directory.path().join("right"), b"bb-shared\n").expect("right stream");
	let output = tempfile::tempfile().expect("captured stdout");
	let error = tempfile::tempfile().expect("captured stderr");
	let mut shell = virtual_shell(directory.path()).await;
	shell.set_filesystem(Fs::new(Arc::new(DelayedFilesystem {
		root:     directory.path().to_path_buf(),
		seekable: false,
	})));
	let parameters = capture_parameters(&shell, &output, &error);
	let result = shell
		.run_string(
			"cmp -s virtual://left virtual://left && { cmp -s virtual://left virtual://right; test \
			 \"$?\" -eq 1; } && cmp -i 2 virtual://left virtual://right",
			&SourceInfo::from("vfs-nonseekable-cmp"),
			&parameters,
		)
		.await
		.expect("stream comparison");
	assert_eq!(u8::from(result.exit_code), 0, "{}", captured_text(&error));
}
