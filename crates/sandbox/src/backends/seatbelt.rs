#[cfg(target_os = "macos")]
use std::process::Command;
use std::{
	collections::BTreeSet,
	env,
	ffi::OsString,
	fmt::Write as _,
	path::{Path, PathBuf},
};

#[cfg(target_os = "macos")]
use omp_core::CowBytes;

#[cfg(target_os = "macos")]
use crate::SandboxOperation;
use crate::{
	Backend, BackendStatus, Capability, CapabilitySet, Caveat, DegradationPolicy,
	FilesystemVirtualizationKind, NetworkMode, Plan, ProbeFailure, SandboxError, SandboxSpec,
	WriteMode, paths::temp_roots, runner::COMMAND_WRAPPER_PLACEHOLDER,
};
const LAUNCHER: &str = "/usr/bin/sandbox-exec";
pub const EPHEMERAL_ROOT_PLACEHOLDER: &str = "<omp-sandbox-ephemeral-root>";

const SEATBELT_BASE_POLICY: &str = r#"(version 1)
(deny default)
(allow process-exec*)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read
	(sysctl-name "hw.activecpu")
	(sysctl-name "hw.busfrequency_compat")
	(sysctl-name "hw.byteorder")
	(sysctl-name "hw.cacheconfig")
	(sysctl-name "hw.cachelinesize_compat")
	(sysctl-name "hw.cpufamily")
	(sysctl-name "hw.cpufrequency_compat")
	(sysctl-name "hw.cputype")
	(sysctl-name "hw.l1dcachesize_compat")
	(sysctl-name "hw.l1icachesize_compat")
	(sysctl-name "hw.l2cachesize_compat")
	(sysctl-name "hw.l3cachesize_compat")
	(sysctl-name "hw.logicalcpu_max")
	(sysctl-name "hw.machine")
	(sysctl-name "hw.model")
	(sysctl-name "hw.memsize")
	(sysctl-name "hw.ncpu")
	(sysctl-name "hw.nperflevels")
	(sysctl-name-prefix "hw.optional.arm.")
	(sysctl-name-prefix "hw.optional.armv8_")
	(sysctl-name "hw.packages")
	(sysctl-name "hw.pagesize_compat")
	(sysctl-name "hw.pagesize")
	(sysctl-name "hw.physicalcpu")
	(sysctl-name "hw.physicalcpu_max")
	(sysctl-name "hw.logicalcpu")
	(sysctl-name "hw.cpufrequency")
	(sysctl-name "hw.tbfrequency_compat")
	(sysctl-name "hw.vectorunit")
	(sysctl-name "machdep.cpu.brand_string")
	(sysctl-name "kern.argmax")
	(sysctl-name "kern.hostname")
	(sysctl-name "kern.maxfilesperproc")
	(sysctl-name "kern.maxproc")
	(sysctl-name "kern.osproductversion")
	(sysctl-name "kern.osrelease")
	(sysctl-name "kern.ostype")
	(sysctl-name "kern.osvariant_status")
	(sysctl-name "kern.osversion")
	(sysctl-name "kern.secure_kernel")
	(sysctl-name "kern.sysv.semmns")
	(sysctl-name "kern.usrstack64")
	(sysctl-name "kern.version")
	(sysctl-name "sysctl.proc_cputype")
	(sysctl-name "vm.loadavg")
	(sysctl-name-prefix "hw.perflevel")
	(sysctl-name-prefix "kern.proc.pgrp.")
	(sysctl-name-prefix "kern.proc.pid.")
	(sysctl-name-prefix "net.routetable."))
(allow sysctl-write (sysctl-name "kern.grade_cputype"))
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(deny mach-lookup)
(allow mach-lookup
	(global-name "com.apple.system.opendirectoryd.libinfo")
	(global-name "com.apple.PowerManagement.control"))
(allow ipc-posix-sem)
(allow ipc-posix-shm-read-data
	ipc-posix-shm-write-create
	ipc-posix-shm-write-unlink
	(ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write*
	(require-all
		(regex #"^/dev/ttys[0-9]+")
		(extension "com.apple.sandbox.pty")))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))
(allow file-read* file-write* file-ioctl
	(literal "/dev/null")
	(literal "/dev/tty"))
(allow file-read* file-ioctl
	(literal "/dev/zero")
	(literal "/dev/random")
	(literal "/dev/urandom")
	(subpath "/dev/fd"))
"#;

const NETWORK_MACH_SERVICES: [&str; 9] = [
	"com.apple.trustd",
	"com.apple.trustd.agent",
	"com.apple.SecurityServer",
	"com.apple.bsd.dirhelper",
	"com.apple.system.opendirectoryd.membership",
	"com.apple.networkd",
	"com.apple.ocspd",
	"com.apple.SystemConfiguration.DNSConfiguration",
	"com.apple.SystemConfiguration.configd",
];

const NETWORK_SERVICE_POLICY: &str = r#"(allow system-socket
	(require-all
		(socket-domain AF_SYSTEM)
		(socket-protocol 2)))
(allow sysctl-read (sysctl-name-regex #"^net.routetable"))
"#;

pub fn compile(
	spec: &SandboxSpec,
	program: &Path,
	requested: CapabilitySet,
	mut enforced: CapabilitySet,
) -> Result<Plan, SandboxError> {
	enforced = enforced.union(CapabilitySet::one(Capability::MachRestrict));
	if spec.write == WriteMode::Overlay {
		enforced = enforced.difference(CapabilitySet::one(Capability::FsWriteEphemeral));
	}
	let mut profile = String::from(SEATBELT_BASE_POLICY);
	let mut mach_services: Vec<&str> = spec
		.mach_services
		.iter()
		.map(|service| service.as_str())
		.collect();
	if matches!(spec.network, NetworkMode::Enabled | NetworkMode::Outbound)
		|| spec.proxy_port.is_some()
	{
		for service in NETWORK_MACH_SERVICES {
			if !mach_services.contains(&service) {
				mach_services.push(service);
			}
		}
	}
	for service in mach_services {
		profile.push_str("(allow mach-lookup (global-name ");
		push_string(&mut profile, service);
		profile.push_str("))\n");
	}
	match spec.network {
		NetworkMode::Disabled => profile.push_str("(deny network*)\n"),
		NetworkMode::Enabled => {
			profile.push_str(NETWORK_SERVICE_POLICY);
			profile.push_str("(allow network-outbound)\n(allow network-inbound)\n");
		},
		NetworkMode::Outbound => {
			profile.push_str(NETWORK_SERVICE_POLICY);
			profile.push_str("(allow network-outbound)\n");
			profile.push_str("(deny network-inbound)\n(deny network-bind)\n");
			// Seatbelt uses the last matching rule. Close UDS after the broad
			// outbound grant, then reopen only the system resolver endpoint.
			profile.push_str("(deny network-outbound (remote unix-socket))\n");
			profile.push_str(
				"(allow network-outbound (remote unix-socket (path-literal \
				 \"/private/var/run/mDNSResponder\")))\n",
			);
		},
	}
	if let Some(port) = spec.proxy_port {
		// Scoped egress never grants general networking: the only reachable TCP
		// peer is the session-owned loopback broker.
		profile.push_str("(deny network*)\n(allow network-outbound (remote tcp ");
		push_string(&mut profile, &format!("127.0.0.1:{port}"));
		profile.push_str("))\n");
	}

	if spec.readable.is_empty() {
		// Broad reads still exclude raw disk and kernel-memory devices. Otherwise a
		// privileged caller could bypass the filesystem policy entirely.
		profile.push_str("(allow file-read*)\n");
		profile.push_str("(deny file-read* (regex #\"^/dev/r?disk\"))\n");
		profile.push_str("(deny file-read* (regex #\"^/dev/(mem|kmem|kcore)$\"))\n");
	} else {
		profile.push_str("(deny file-read* (subpath \"/\"))\n");
		push_paths(&mut profile, "allow", "file-read*", [
			Path::new("/bin"),
			Path::new("/usr/bin"),
			Path::new("/usr/lib"),
			Path::new("/lib"),
			Path::new("/System"),
			Path::new("/private/var/db/dyld"),
		]);
		profile.push_str("(allow file-read-data (literal \"/\"))\n");
		// Allowed scopes are canonicalized under /private; callers still address
		// them through these firmlink symlinks, whose resolution needs a read.
		push_literals(&mut profile, "allow", "file-read*", [
			Path::new("/tmp"),
			Path::new("/var"),
			Path::new("/etc"),
		]);
		push_literals(&mut profile, "allow", "file-read*", [
			Path::new("/dev/null"),
			Path::new("/dev/zero"),
			Path::new("/dev/random"),
			Path::new("/dev/urandom"),
		]);
		push_literals(&mut profile, "allow", "file-read*", [
			Path::new("/dev/ptmx"),
			Path::new("/dev/tty"),
		]);
		push_paths(&mut profile, "allow", "file-read*", [Path::new("/dev/fd")]);
		profile.push_str(
			"(allow file-read* (require-all (regex #\"^/dev/ttys[0-9]+\") (extension \
			 \"com.apple.sandbox.pty\")))\n",
		);
		push_scopes(
			&mut profile,
			"allow",
			"file-read*",
			spec
				.readable
				.iter()
				.map(PathBuf::as_path)
				.chain((program != Path::new(COMMAND_WRAPPER_PLACEHOLDER)).then_some(program)),
		);
		if spec.write == WriteMode::Ephemeral {
			push_paths(&mut profile, "allow", "file-read*", [Path::new(EPHEMERAL_ROOT_PLACEHOLDER)]);
		}
		// /System lexically includes this firmlink target. This follows every
		// runtime and caller grant, including a caller-provided /System scope.
		profile.push_str("(deny file-read* (subpath \"/System/Volumes/Data\"))\n");
	}
	// A deny must follow every built-in and caller allow because the last
	// matching Seatbelt rule wins.
	push_scopes(&mut profile, "deny", "file-read*", spec.read_deny.iter().map(PathBuf::as_path));
	// One-shot approvals follow ordinary denials without turning a host-read
	// policy into an allowlist.
	push_scopes(
		&mut profile,
		"allow",
		"file-read*",
		spec.read_override.iter().map(PathBuf::as_path),
	);

	profile.push_str("(deny file-write* (subpath \"/\"))\n");
	push_literals(&mut profile, "allow", "file-write*", [Path::new("/dev/null")]);
	profile.push_str(
		"(allow file-write* file-ioctl (literal \"/dev/ptmx\") (literal \"/dev/tty\") (subpath \
		 \"/dev/fd\"))\n",
	);
	profile.push_str(
		"(allow file-write* (require-all (regex #\"^/dev/ttys[0-9]+\") (extension \
		 \"com.apple.sandbox.pty\")))\n",
	);
	match spec.write {
		WriteMode::Deny => {},
		WriteMode::Scoped | WriteMode::Overlay => {
			let temporary = spec.allow_temp.then(temp_roots).unwrap_or_default();
			push_write_scopes(
				&mut profile,
				spec
					.writable
					.iter()
					.map(PathBuf::as_path)
					.chain(temporary.iter().map(PathBuf::as_path)),
				&spec.write_deny,
			);
		},
		WriteMode::Ephemeral => {
			push_write_scopes(&mut profile, [Path::new(EPHEMERAL_ROOT_PLACEHOLDER)], &spec.write_deny);
		},
	}

	// One-shot scopes are emitted after ordinary carve-out denials: Seatbelt's
	// last matching rule wins, so this reopens only the approved nested path.
	push_scopes(
		&mut profile,
		"allow",
		"file-write*",
		spec.write_override.iter().map(PathBuf::as_path),
	);

	if spec.no_exec {
		profile.push_str("(deny process-exec*)\n(allow process-exec* (literal ");
		push_path_string(&mut profile, program);
		profile.push_str("))\n");
	}
	// Caller-declared socket exceptions stay last so they can reopen named
	// endpoints without weakening the preceding blanket network/UDS denial.
	for socket in &spec.unix_sockets {
		profile.push_str("(allow network-outbound (remote unix-socket (path-literal ");
		push_path_string(&mut profile, socket);
		profile.push_str(")))\n");
	}

	let launcher = env::var_os("OMP_SANDBOX_EXEC").unwrap_or_else(|| OsString::from(LAUNCHER));
	let mut argv = vec![
		launcher,
		OsString::from("-p"),
		OsString::from(&profile),
		program.as_os_str().to_owned(),
	];
	argv.extend(spec.args.iter().cloned());
	let mut plan = Plan::new(Backend::Seatbelt, requested, enforced, argv, true);
	plan.set_profile(profile);

	match spec.write {
		WriteMode::Ephemeral => {
			plan.set_filesystem(FilesystemVirtualizationKind::WorkspaceClone);
			plan.add_caveat(Caveat::capability(
				Capability::FsWriteEphemeral,
				"macOS ephemeral writes are workspace-scoped to a private APFS clone of the working \
				 directory, not a whole-host overlay",
			));
		},
		WriteMode::Overlay => {
			plan.set_filesystem(FilesystemVirtualizationKind::ScopedDeny);
			plan.add_caveat(Caveat::capability(
				Capability::FsWriteEphemeral,
				"Seatbelt denies writes outside persistent scopes instead of redirecting them",
			));
		},
		WriteMode::Deny | WriteMode::Scoped => {},
	}
	if matches!(spec.write, WriteMode::Scoped | WriteMode::Overlay) {
		plan.add_caveat(Caveat::capability(
			Capability::FsWriteScope,
			"Seatbelt write scopes are path based; an in-scope hardlink can modify the same file \
			 through an out-of-scope alias",
		));
		plan.add_caveat(Caveat::general(
			"OMP does not enforce res.disk; scoped persistent writes can fill the backing host \
			 filesystem unless separately constrained",
		));
	}
	if spec.readable.is_empty() {
		plan.add_caveat(Caveat::capability(
			Capability::FsReadHost,
			"Broad host reads rely on OS permissions; raw disk and kernel-memory devices are denied",
		));
	} else {
		plan.add_caveat(Caveat::capability(
			Capability::FsReadScope,
			"Seatbelt additionally exposes /usr/lib, /System, and /private/var/db/dyld so dynamic \
			 Mach-O programs can load; reading the root directory itself is allowed for cwd \
			 resolution without exposing descendant contents",
		));
	}
	if !spec.read_deny.is_empty() {
		plan.add_caveat(Caveat::capability(
			Capability::FsReadDeny,
			"Seatbelt read denials are path based and can be bypassed through an allowed hardlink to \
			 the same inode",
		));
	}
	if !spec.write_deny.is_empty() {
		plan.add_caveat(Caveat::capability(
			Capability::FsWriteDeny,
			"Seatbelt write denials are path based and can be bypassed through an allowed hardlink \
			 to the same inode",
		));
	}
	match spec.network {
		NetworkMode::Disabled => plan.add_caveat(Caveat::capability(
			Capability::NetDisable,
			"Seatbelt network denial also blocks loopback IP sockets",
		)),
		NetworkMode::Enabled | NetworkMode::Outbound => plan.add_caveat(Caveat::general(
			"Seatbelt re-allows the Apple TLS trust, DNS, and network-configuration services needed \
			 by network clients",
		)),
	}
	if spec.network == NetworkMode::Outbound {
		plan.add_caveat(Caveat::capability(
			Capability::NetOutbound,
			"net.outbound is not an egress filter or domain/CIDR allowlist; permitted connections \
			 can exfiltrate data unless separately constrained",
		));
	}
	if spec.no_exec {
		plan.add_caveat(Caveat::capability(
			Capability::ProcNoExec,
			"Seatbelt path rules cannot prevent an interpreter from re-executing itself",
		));
	}
	if spec.degradation == DegradationPolicy::AllowCaveats {
		if spec.resources.cpu_cores().is_some() {
			plan.add_caveat(Caveat::capability(
				Capability::ResCpu,
				"Seatbelt uses a best-effort process-group duty-cycle watchdog rather than a kernel \
				 CPU quota",
			));
		}
		if spec.resources.memory_bytes().is_some() {
			plan.add_caveat(Caveat::capability(
				Capability::ResMemory,
				"Seatbelt uses a sampled process-group RSS watchdog rather than a kernel memory cap",
			));
		}
		if spec.resources.pids().is_some() {
			plan.add_caveat(Caveat::capability(
				Capability::ResPids,
				"Seatbelt has no process-count limit primitive",
			));
		}
	}
	Ok(plan)
}

pub fn probe() -> BackendStatus {
	#[cfg(not(target_os = "macos"))]
	{
		return BackendStatus::unavailable(Backend::Seatbelt, ProbeFailure::WrongHost {
			backend: Backend::Seatbelt,
			os:      std::env::consts::OS,
		});
	}
	#[cfg(target_os = "macos")]
	{
		let launcher = env::var_os("OMP_SANDBOX_EXEC").unwrap_or_else(|| OsString::from(LAUNCHER));
		let output = match Command::new(&launcher)
			.args(["-p", "(version 1) (allow default)", "/usr/bin/true"])
			.output()
		{
			Ok(output) => output,
			Err(source) => {
				return BackendStatus::unavailable(Backend::Seatbelt, ProbeFailure::Start {
					backend: Backend::Seatbelt,
					operation: SandboxOperation::Probe,
					source,
				});
			},
		};
		if output.status.success() {
			BackendStatus::available(Backend::Seatbelt)
		} else {
			let mut diagnostic = output.stderr;
			diagnostic.truncate(4096);
			BackendStatus::unavailable(Backend::Seatbelt, ProbeFailure::Rejected {
				backend:    Backend::Seatbelt,
				operation:  SandboxOperation::Probe,
				status:     output.status.code(),
				diagnostic: CowBytes::from(diagnostic),
			})
		}
	}
}

fn push_paths<'a>(
	profile: &mut String,
	verb: &str,
	operation: &str,
	paths: impl IntoIterator<Item = &'a Path>,
) {
	let mut paths = paths.into_iter().peekable();
	if paths.peek().is_none() {
		return;
	}
	let _ = write!(profile, "({verb} {operation}");
	for path in paths {
		profile.push_str(" (subpath ");
		push_path_string(profile, path);
		profile.push(')');
	}
	profile.push_str(")\n");
}

fn push_literals<'a>(
	profile: &mut String,
	verb: &str,
	operation: &str,
	paths: impl IntoIterator<Item = &'a Path>,
) {
	let mut paths = paths.into_iter().peekable();
	if paths.peek().is_none() {
		return;
	}
	let _ = write!(profile, "({verb} {operation}");
	for path in paths {
		profile.push_str(" (literal ");
		push_path_string(profile, path);
		profile.push(')');
	}
	profile.push_str(")\n");
}

fn push_scopes<'a>(
	profile: &mut String,
	verb: &str,
	operation: &str,
	paths: impl IntoIterator<Item = &'a Path>,
) {
	let mut paths = paths.into_iter().peekable();
	if paths.peek().is_none() {
		return;
	}
	let _ = write!(profile, "({verb} {operation}");
	for path in paths {
		let filter = if path.is_dir() { "subpath" } else { "literal" };
		profile.push_str(" (");
		profile.push_str(filter);
		profile.push(' ');
		push_path_string(profile, path);
		profile.push(')');
		if !path.exists() {
			profile.push_str(" (subpath ");
			push_path_string(profile, path);
			profile.push(')');
		}
	}
	profile.push_str(")\n");
}

fn push_write_scopes<'a>(
	profile: &mut String,
	paths: impl IntoIterator<Item = &'a Path>,
	denied: &[PathBuf],
) {
	let mut protected_ancestors = BTreeSet::new();
	for path in paths {
		let filter = if path.is_dir() || !path.exists() {
			"subpath"
		} else {
			"literal"
		};
		profile.push_str("(allow file-write* (require-all (");
		profile.push_str(filter);
		profile.push(' ');
		push_path_string(profile, path);
		profile.push(')');
		for denied in denied {
			profile.push_str(" (require-not (subpath ");
			push_path_string(profile, denied);
			profile.push_str(")) (require-not (literal ");
			push_path_string(profile, denied);
			profile.push_str("))");
			if denied.starts_with(path) {
				for ancestor in denied.parent().into_iter().flat_map(Path::ancestors) {
					if !ancestor.starts_with(path) {
						break;
					}
					protected_ancestors.insert(ancestor.to_owned());
				}
			}
		}
		profile.push_str("))\n");
	}
	for ancestor in protected_ancestors {
		profile.push_str("(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal ");
		push_path_string(profile, &ancestor);
		profile.push_str(")))\n");
	}
}

fn push_path_string(profile: &mut String, path: &Path) {
	push_string(profile, &path.as_os_str().to_string_lossy());
}

fn push_string(profile: &mut String, value: &str) {
	profile.push('"');
	for character in value.chars() {
		match character {
			'\\' => profile.push_str("\\\\"),
			'"' => profile.push_str("\\\""),
			character => profile.push(character),
		}
	}
	profile.push('"');
}

#[cfg(test)]
mod tests {
	use super::*;
	#[cfg(target_os = "macos")]
	#[test]
	fn data_volume_deny_follows_every_system_read_allow() {
		let mut spec = SandboxSpec::new("/bin/true");
		spec
			.allow_read(Path::new("/System"))
			.expect("system read scope");
		let requested = spec.requested_capabilities();
		let plan = compile(
			&spec,
			Path::new("/bin/true"),
			requested,
			requested.intersection(Backend::Seatbelt.capabilities()),
		)
		.expect("seatbelt plan");
		let profile = plan.profile().expect("seatbelt profile");
		let system_allow = profile
			.rfind("(subpath \"/System\")")
			.expect("system allow");
		let data_deny = profile
			.rfind("(deny file-read* (subpath \"/System/Volumes/Data\"))")
			.expect("data deny");
		assert!(system_allow < data_deny);
	}

	#[test]
	fn scoped_proxy_allows_only_its_exact_loopback_tcp_port() {
		let mut spec = SandboxSpec::new("/bin/true");
		spec
			.set_proxy_endpoint(18443, None)
			.expect("proxy endpoint");
		let requested = spec.requested_capabilities();
		let plan = compile(
			&spec,
			Path::new("/bin/true"),
			requested,
			requested.intersection(Backend::Seatbelt.capabilities()),
		)
		.expect("seatbelt plan");
		let profile = plan.profile().expect("seatbelt profile");
		assert!(profile.contains("(deny network*)"));
		assert!(profile.contains("(remote tcp \"127.0.0.1:18443\")"));
	}

	#[test]
	fn read_override_follows_read_denials() {
		let directory = tempfile::tempdir().expect("directory");
		let path = directory.path().join("approved");
		std::fs::write(&path, "approved").expect("approved path");
		let mut spec = SandboxSpec::new("/bin/true");
		spec.deny_read(&path).expect("read deny");
		spec.allow_read_override(&path).expect("read override");
		let requested = spec.requested_capabilities();
		let plan = compile(
			&spec,
			Path::new("/bin/true"),
			requested,
			requested.intersection(Backend::Seatbelt.capabilities()),
		)
		.expect("seatbelt plan");
		let profile = plan.profile().expect("seatbelt profile");
		let deny = profile.find("(deny file-read*").expect("read deny");
		let allow = profile.rfind("(allow file-read*").expect("read override");
		assert!(deny < allow);
	}
	#[cfg(unix)]
	#[test]
	fn lexical_write_deny_blocks_logical_entry_removal() {
		use std::os::unix::fs::symlink;

		let workspace = tempfile::tempdir().expect("workspace");
		let external = tempfile::tempdir().expect("external");
		let protected = workspace.path().join(".git");
		symlink(external.path(), &protected).expect("protected symlink");

		let mut spec = SandboxSpec::new("/bin/true");
		spec.set_write(WriteMode::Scoped);
		spec
			.allow_write(workspace.path())
			.expect("writable workspace");
		spec.deny_write_lexical(&protected).expect("logical deny");
		let requested = spec.requested_capabilities();
		let plan = compile(
			&spec,
			Path::new("/bin/true"),
			requested,
			requested.intersection(Backend::Seatbelt.capabilities()),
		)
		.expect("seatbelt plan");
		let profile = plan.profile().expect("seatbelt profile");
		assert!(profile.contains(protected.to_string_lossy().as_ref()));
		assert!(profile.contains("(deny file-write-unlink"));
	}
}
