use std::{
	fs::{self, File},
	io::{self, Read, Write},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use omp_shell::{OpenError, OpenRequest, PathAccess, PathDenied, PathPolicy};

use crate::host::Host;

#[test]
fn plain_write_works_and_read_is_unchanged() {
	let dir = tempfile::tempdir().expect("workspace");
	let root = dir.path().canonicalize().expect("canonical workspace");
	let (mut host, _) = Host::for_test("write", Vec::<u8>::new(), &root);
	host.set_test_path_policy(Arc::new(NofollowRoot::new(&root)));

	let mut written = host
		.open_write("plain.txt", PathAccess::Truncate)
		.expect("plain write");
	written.write_all(b"hello").expect("write bytes");
	drop(written);

	let mut read = host.open_read("plain.txt").expect("read stays open");
	let mut bytes = Vec::new();
	read.read_to_end(&mut bytes).expect("read bytes");
	assert_eq!(bytes, b"hello");
	assert_eq!(fs::read(root.join("plain.txt")).expect("file"), b"hello");
	assert!(host.ensure_writable("plain.txt").is_ok());
}

#[test]
fn symlink_escape_and_swap_are_refused() {
	let dir = tempfile::tempdir().expect("workspace");
	let outside_dir = tempfile::tempdir().expect("outside");
	let root = dir.path().canonicalize().expect("canonical workspace");
	let outside = outside_dir
		.path()
		.canonicalize()
		.expect("canonical outside");
	fs::write(root.join("inside.txt"), b"inside").expect("inside");
	fs::write(outside.join("secret"), b"untouched").expect("secret");
	fs::write(root.join("swap.txt"), b"swap").expect("swap file");
	std::os::unix::fs::symlink(outside.join("secret"), root.join("link")).expect("link");

	let (mut host, _) = Host::for_test("write", Vec::<u8>::new(), &root);
	host.set_test_path_policy(Arc::new(NofollowRoot::new(&root)));
	assert!(host.open_write("link", PathAccess::Truncate).is_err());
	assert_eq!(fs::read(root.join("inside.txt")).expect("inside"), b"inside");
	assert_eq!(fs::read(outside.join("secret")).expect("secret"), b"untouched");

	let (mut host, _) = Host::for_test("write", Vec::<u8>::new(), &root);
	host.set_test_path_policy(Arc::new(NofollowRoot::swapping(
		&root,
		root.join("swap.txt"),
		outside.join("secret"),
	)));
	assert!(
		host.open_write("swap.txt", PathAccess::Truncate).is_err(),
		"a link swapped between admission and open must fail"
	);
	assert_eq!(fs::read(root.join("inside.txt")).expect("inside"), b"inside");
	assert_eq!(fs::read(outside.join("secret")).expect("secret"), b"untouched");
	assert!(
		host
			.open_write(&outside.join("nope"), PathAccess::Truncate)
			.is_err()
	);
	assert!(!outside.join("nope").exists());
}

struct NofollowRoot {
	root:        PathBuf,
	swap_link:   Option<PathBuf>,
	swap_target: Option<PathBuf>,
	swapped:     AtomicBool,
}

impl NofollowRoot {
	fn new(root: &Path) -> Self {
		Self {
			root:        root.to_path_buf(),
			swap_link:   None,
			swap_target: None,
			swapped:     AtomicBool::new(false),
		}
	}

	fn swapping(root: &Path, link: PathBuf, target: PathBuf) -> Self {
		Self {
			root:        root.to_path_buf(),
			swap_link:   Some(link),
			swap_target: Some(target),
			swapped:     AtomicBool::new(false),
		}
	}

	fn admit(&self, path: &Path, access: PathAccess) -> Result<(), PathDenied> {
		if path.starts_with(&self.root) {
			Ok(())
		} else {
			Err(PathDenied { path: path.to_path_buf(), access })
		}
	}
}

impl PathPolicy for NofollowRoot {
	fn check_read(&self, path: &Path) -> Result<(), PathDenied> {
		self.admit(path, PathAccess::Read)
	}

	fn check_write(&self, path: &Path) -> Result<(), PathDenied> {
		self.admit(path, PathAccess::Write)
	}

	fn open(&self, path: &Path, request: OpenRequest) -> Result<File, OpenError> {
		self.admit(path, request.access)?;
		if let (Some(link), Some(target)) = (&self.swap_link, &self.swap_target)
			&& !self.swapped.swap(true, Ordering::SeqCst)
		{
			fs::remove_file(link).expect("remove admitted link");
			std::os::unix::fs::symlink(target, link).expect("swap link");
		}
		nofollow_open(path, request).map_err(OpenError::from)
	}
}

fn nofollow_open(path: &Path, request: OpenRequest) -> io::Result<File> {
	use std::os::unix::fs::OpenOptionsExt;

	let mut options = File::options();
	match request.access {
		PathAccess::Read => {
			options.read(true);
		},
		PathAccess::CreateNew => {
			options.write(true).create_new(true);
		},
		PathAccess::Truncate => {
			options.write(true).create(true).truncate(true);
		},
		PathAccess::Append => {
			options.append(true).create(true);
		},
		PathAccess::ReadWrite => {
			options.read(true).write(true).create(true);
		},
		PathAccess::Write => {
			options.write(true).create(true);
		},
	}
	options
		.custom_flags(libc::O_NOFOLLOW)
		.mode(request.create_mode);
	options.open(path)
}
