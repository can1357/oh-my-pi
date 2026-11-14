//! Open files from Linux procfs: `/proc/<pid>/{cwd,root,exe,maps,fd,fdinfo}`
//! per process, sockets resolved by inode through
//! `/proc/net/{tcp,tcp6,udp,udp6,unix,netlink}`, locks from `/proc/locks`.

use std::{
	collections::{HashMap, HashSet},
	fs, io,
	net::{IpAddr, Ipv4Addr, Ipv6Addr},
	os::unix::fs::MetadataExt,
};

use super::{Device, Entry, Fd, Inet, Listing, Node, Proto};
use crate::{host::strip_errno, proc_snapshot::ProcInfo};

/// Kernel TCP state names in `st` code order (1-based), as lsof prints them.
pub(super) const TCP_STATES: &[&str] = &[
	"ESTABLISHED",
	"SYN_SENT",
	"SYN_RECV",
	"FIN_WAIT1",
	"FIN_WAIT2",
	"TIME_WAIT",
	"CLOSE",
	"CLOSE_WAIT",
	"LAST_ACK",
	"LISTEN",
	"CLOSING",
	"NEW_SYN_RECV",
];

/// UDP sockets report the same `st` codes (`ESTABLISHED` when connected,
/// `CLOSE` otherwise).
pub(super) const UDP_STATES: &[&str] = TCP_STATES;

pub(super) fn command_name(process: &ProcInfo) -> String {
	process.command_name()
}

pub(super) const fn normalize_dev(dev: u64) -> u64 {
	dev
}

const fn major(dev: u64) -> u32 {
	(((dev >> 8) & 0xfff) | ((dev >> 32) & 0xffff_f000)) as u32
}

const fn minor(dev: u64) -> u32 {
	((dev & 0xff) | ((dev >> 12) & 0xffff_ff00)) as u32
}

const fn makedev(major: u32, minor: u32) -> u64 {
	let (major, minor) = (major as u64, minor as u64);
	((major & 0xffff_f000) << 32) | ((major & 0xfff) << 8) | ((minor & 0xffff_ff00) << 12) | (minor & 0xff)
}

fn device(raw: u64) -> Device {
	Device::Numbers { raw, major: major(raw), minor: minor(raw) }
}

fn mode_kind(mode: u32) -> &'static str {
	match mode & libc::S_IFMT {
		libc::S_IFREG => "REG",
		libc::S_IFDIR => "DIR",
		libc::S_IFCHR => "CHR",
		libc::S_IFBLK => "BLK",
		libc::S_IFIFO => "FIFO",
		libc::S_IFLNK => "LINK",
		libc::S_IFSOCK => "sock",
		_ => "unknown",
	}
}

/// What a socket inode is, from the `/proc/net` tables.
enum Socket {
	Inet { v6: bool, inet: Inet },
	Unix { address: String, kind: &'static str, path: Option<String> },
	Netlink(String),
}

/// Socket and lock tables read once per run.
pub(super) struct Scanner {
	sockets: HashMap<u64, Socket>,
	/// `(pid, major, minor, inode)` to lsof's lock character.
	locks:   HashMap<(i32, u32, u32, u64), char>,
}

impl Scanner {
	pub(super) fn new() -> Self {
		let mut sockets = HashMap::new();
		read_inet(&mut sockets, "/proc/net/tcp", Proto::Tcp, false);
		read_inet(&mut sockets, "/proc/net/tcp6", Proto::Tcp, true);
		read_inet(&mut sockets, "/proc/net/udp", Proto::Udp, false);
		read_inet(&mut sockets, "/proc/net/udp6", Proto::Udp, true);
		read_unix(&mut sockets);
		read_netlink(&mut sockets);
		Self { sockets, locks: read_locks() }
	}

	/// The open files of `pid`: cwd, rtd, txt, mem, then descriptors.
	pub(super) fn files(&self, pid: i32, sockets_only: bool) -> Listing {
		let base = format!("/proc/{pid}");
		let mut entries = Vec::new();
		let mut denied = false;
		let mut exe = None;
		if !sockets_only {
			for (fd, link) in [(Fd::Cwd, "cwd"), (Fd::Rtd, "root"), (Fd::Txt, "exe")] {
				let path = format!("{base}/{link}");
				match fs::read_link(&path) {
					Ok(target) => {
						let entry = path_entry(fd, fs::metadata(&path).ok(), target.to_string_lossy().into_owned());
						if fd == Fd::Txt {
							exe = entry.file_id;
						}
						entries.push(entry);
					},
					Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
						denied = true;
						let mut entry = Entry::new(fd, "unknown");
						entry.name = format!("{path} (readlink: {})", strip_errno(&error));
						entries.push(entry);
					},
					Err(_) => {},
				}
			}
			if !denied {
				self.mapped_files(pid, exe, &mut entries);
			}
		}
		match fs::read_dir(format!("{base}/fd")) {
			Ok(dir) => {
				let mut fds: Vec<i32> =
					dir.flatten().filter_map(|entry| entry.file_name().to_str()?.parse().ok()).collect();
				fds.sort_unstable();
				entries.extend(fds.into_iter().filter_map(|fd| self.fd_entry(pid, fd, sockets_only)));
			},
			Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
				denied = true;
				let mut entry = Entry::new(Fd::NoFd, "");
				entry.name = format!("{base}/fd (opendir: {})", strip_errno(&error));
				entries.push(entry);
			},
			Err(_) => {},
		}
		Listing { entries, denied }
	}

	/// `mem` (and deleted `DEL`) rows: each mapped file once, the executable
	/// excepted.
	fn mapped_files(&self, pid: i32, exe: Option<(u64, u64)>, entries: &mut Vec<Entry>) {
		let Ok(maps) = fs::read_to_string(format!("/proc/{pid}/maps")) else {
			return;
		};
		let mut seen = HashSet::new();
		for line in maps.lines() {
			let mut rest = line;
			let mut fields = [""; 5];
			for field in &mut fields {
				rest = rest.trim_start();
				let end = rest.find(' ').unwrap_or(rest.len());
				*field = &rest[..end];
				rest = &rest[end..];
			}
			let path = rest.trim_start();
			let Ok(inode) = fields[4].parse::<u64>() else {
				continue;
			};
			let Some((major, minor)) = fields[3].split_once(':') else {
				continue;
			};
			let (Ok(major), Ok(minor)) = (u32::from_str_radix(major, 16), u32::from_str_radix(minor, 16)) else {
				continue;
			};
			if inode == 0 || !path.starts_with('/') {
				continue;
			}
			let raw = makedev(major, minor);
			if exe == Some((raw, inode)) || !seen.insert((raw, inode)) {
				continue;
			}
			let (fd, name) = match path.strip_suffix(" (deleted)") {
				Some(name) => (Fd::Del, name),
				None => (Fd::Mem, path),
			};
			let mut entry = Entry::new(fd, "REG");
			entry.device = Some(Device::Numbers { raw, major, minor });
			entry.node = Some(Node::Inode(inode));
			entry.file_id = Some((raw, inode));
			entry.name = name.to_owned();
			if fd == Fd::Mem
				&& let Ok(metadata) = fs::metadata(path)
				&& metadata.ino() == inode
			{
				entry.size = Some(metadata.size());
				entry.nlink = Some(metadata.nlink());
			}
			entries.push(entry);
		}
	}

	fn fd_entry(&self, pid: i32, fd: i32, sockets_only: bool) -> Option<Entry> {
		let path = format!("/proc/{pid}/fd/{fd}");
		let link = fs::read_link(&path).ok()?.to_string_lossy().into_owned();
		let socket = link
			.strip_prefix("socket:[")
			.and_then(|rest| rest.strip_suffix(']'))
			.and_then(|inode| inode.parse::<u64>().ok());
		if sockets_only && socket.is_none() {
			return None;
		}
		let (position, flags) = fd_info(pid, fd);
		let mut entry = if let Some(inode) = socket {
			self.socket_entry(fd, inode, &path)
		} else if let Some(inode) =
			link.strip_prefix("pipe:[").and_then(|rest| rest.strip_suffix(']')).and_then(|inode| inode.parse().ok())
		{
			let mut entry = Entry::new(Fd::Num(fd), "FIFO");
			entry.device = fs::metadata(&path).ok().map(|metadata| device(metadata.dev()));
			entry.offset = Some(position);
			entry.node = Some(Node::Inode(inode));
			entry.name = "pipe".to_owned();
			entry
		} else if let Some(kind) = link.strip_prefix("anon_inode:") {
			let mut entry = Entry::new(Fd::Num(fd), "a_inode");
			if let Ok(metadata) = fs::metadata(&path) {
				entry.device = Some(device(metadata.dev()));
				entry.size = Some(metadata.size());
				entry.node = Some(Node::Inode(metadata.ino()));
			}
			entry.name = kind.to_owned();
			entry
		} else {
			let metadata = fs::metadata(&path).ok();
			let mut entry = path_entry(Fd::Num(fd), metadata, link);
			if entry.size.is_none() {
				entry.offset = Some(position);
			}
			entry
		};
		entry.access = match flags.map(|flags| flags & libc::O_ACCMODE as u32) {
			Some(0) => 'r',
			Some(1) => 'w',
			Some(2) => 'u',
			_ => ' ',
		};
		if let Some(Device::Numbers { major, minor, .. }) = &entry.device
			&& let Some(Node::Inode(inode)) = entry.node
			&& let Some(lock) = self.locks.get(&(pid, *major, *minor, inode))
		{
			entry.lock = *lock;
		}
		Some(entry)
	}

	fn socket_entry(&self, fd: i32, inode: u64, path: &str) -> Entry {
		match self.sockets.get(&inode) {
			Some(Socket::Inet { v6, inet }) => {
				let mut entry = Entry::new(Fd::Num(fd), if *v6 { "IPv6" } else { "IPv4" });
				entry.device = Some(Device::Text(inode.to_string()));
				entry.offset = Some(0);
				entry.node = Some(Node::Protocol(inet.proto.name()));
				entry.inet = Some(inet.clone());
				entry
			},
			Some(Socket::Unix { address, kind, path }) => {
				let mut entry = Entry::new(Fd::Num(fd), "unix");
				entry.device = Some(Device::Text(format!("0x{address}")));
				entry.offset = Some(0);
				entry.node = Some(Node::Inode(inode));
				entry.name = match path {
					Some(path) => format!("{path} type={kind}"),
					None => format!("type={kind}"),
				};
				entry
			},
			Some(Socket::Netlink(protocol)) => {
				let mut entry = Entry::new(Fd::Num(fd), "netlink");
				entry.offset = Some(0);
				entry.node = Some(Node::Inode(inode));
				entry.name = protocol.clone();
				entry
			},
			None => {
				let mut entry = Entry::new(Fd::Num(fd), "sock");
				entry.device = fs::metadata(path).ok().map(|metadata| device(metadata.dev()));
				entry.offset = Some(0);
				entry.node = Some(Node::Inode(inode));
				entry.name = "can't identify protocol".to_owned();
				entry
			},
		}
	}
}

/// A cwd/rtd/txt or descriptor row for a path, typed and sized from `metadata`.
fn path_entry(fd: Fd, metadata: Option<fs::Metadata>, name: String) -> Entry {
	let Some(metadata) = metadata else {
		let mut entry = Entry::new(fd, "unknown");
		entry.name = name;
		return entry;
	};
	let format = metadata.mode() & libc::S_IFMT;
	let mut entry = Entry::new(fd, mode_kind(metadata.mode()));
	entry.device = Some(device(if format == libc::S_IFCHR || format == libc::S_IFBLK {
		metadata.rdev()
	} else {
		metadata.dev()
	}));
	if format == libc::S_IFREG || format == libc::S_IFDIR {
		entry.size = Some(metadata.size());
	}
	entry.node = Some(Node::Inode(metadata.ino()));
	entry.nlink = Some(metadata.nlink());
	entry.file_id = Some((metadata.dev(), metadata.ino()));
	entry.name = name;
	entry
}

/// The `pos:` and octal `flags:` lines of `/proc/<pid>/fdinfo/<fd>`.
fn fd_info(pid: i32, fd: i32) -> (u64, Option<u32>) {
	let Ok(text) = fs::read_to_string(format!("/proc/{pid}/fdinfo/{fd}")) else {
		return (0, None);
	};
	let mut position = 0;
	let mut flags = None;
	for line in text.lines() {
		if let Some(value) = line.strip_prefix("pos:") {
			position = value.trim().parse().unwrap_or(0);
		} else if let Some(value) = line.strip_prefix("flags:") {
			flags = u32::from_str_radix(value.trim(), 8).ok();
		}
	}
	(position, flags)
}

/// `ADDR:PORT` in `/proc/net` hex: the address as native-endian 32-bit words.
fn parse_address(text: &str, v6: bool) -> Option<(IpAddr, u16)> {
	let (address, port) = text.split_once(':')?;
	let port = u16::from_str_radix(port, 16).ok()?;
	let address = if v6 {
		if address.len() != 32 {
			return None;
		}
		let mut bytes = [0u8; 16];
		for (index, chunk) in bytes.chunks_exact_mut(4).enumerate() {
			let word = u32::from_str_radix(address.get(index * 8..index * 8 + 8)?, 16).ok()?;
			chunk.copy_from_slice(&word.to_ne_bytes());
		}
		IpAddr::V6(Ipv6Addr::from(bytes))
	} else {
		IpAddr::V4(Ipv4Addr::from(u32::from_str_radix(address, 16).ok()?.to_ne_bytes()))
	};
	Some((address, port))
}

fn read_inet(sockets: &mut HashMap<u64, Socket>, path: &str, proto: Proto, v6: bool) {
	let Ok(text) = fs::read_to_string(path) else {
		return;
	};
	for line in text.lines().skip(1) {
		let fields: Vec<&str> = line.split_whitespace().collect();
		if fields.len() < 10 {
			continue;
		}
		let (Some(local), Some(remote)) = (parse_address(fields[1], v6), parse_address(fields[2], v6)) else {
			continue;
		};
		let Ok(inode) = fields[9].parse::<u64>() else {
			continue;
		};
		if inode == 0 {
			continue;
		}
		let mut inet = Inet::new(proto, local, remote);
		inet.state = u8::from_str_radix(fields[3], 16)
			.ok()
			.and_then(|code| TCP_STATES.get(usize::from(code).checked_sub(1)?))
			.copied();
		inet.queues = fields[4].split_once(':').and_then(|(send, receive)| {
			Some((u64::from_str_radix(receive, 16).ok()?, u64::from_str_radix(send, 16).ok()?))
		});
		sockets.insert(inode, Socket::Inet { v6, inet });
	}
}

fn read_unix(sockets: &mut HashMap<u64, Socket>) {
	let Ok(text) = fs::read_to_string("/proc/net/unix") else {
		return;
	};
	for line in text.lines().skip(1) {
		let mut fields = line.split_whitespace();
		let Some(address) = fields.next().map(|address| address.trim_end_matches(':').to_owned()) else {
			continue;
		};
		let mut fields = fields.skip(3);
		let kind = match fields.next() {
			Some("0001") => "STREAM",
			Some("0002") => "DGRAM",
			Some("0003") => "RAW",
			Some("0004") => "RDM",
			Some("0005") => "SEQPACKET",
			_ => "UNKNOWN",
		};
		let Some(Ok(inode)) = fields.nth(1).map(str::parse::<u64>) else {
			continue;
		};
		let path = fields.collect::<Vec<_>>().join(" ");
		sockets.insert(inode, Socket::Unix { address, kind, path: (!path.is_empty()).then_some(path) });
	}
}

fn netlink_protocol(number: u32) -> String {
	let name = match number {
		0 => "ROUTE",
		1 => "UNUSED",
		2 => "USERSOCK",
		3 => "FIREWALL",
		4 => "INET_DIAG",
		5 => "NFLOG",
		6 => "XFRM",
		7 => "SELINUX",
		8 => "ISCSI",
		9 => "AUDIT",
		10 => "FIB_LOOKUP",
		11 => "CONNECTOR",
		12 => "NETFILTER",
		13 => "IP6_FW",
		14 => "DNRTMSG",
		15 => "KOBJECT_UEVENT",
		16 => "GENERIC",
		18 => "SCSITRANSPORT",
		19 => "ECRYPTFS",
		20 => "RDMA",
		21 => "CRYPTO",
		22 => "SMC",
		_ => return number.to_string(),
	};
	name.to_owned()
}

fn read_netlink(sockets: &mut HashMap<u64, Socket>) {
	let Ok(text) = fs::read_to_string("/proc/net/netlink") else {
		return;
	};
	for line in text.lines().skip(1) {
		let fields: Vec<&str> = line.split_whitespace().collect();
		let (Some(protocol), Some(inode)) = (fields.get(1), fields.get(9)) else {
			continue;
		};
		let (Ok(protocol), Ok(inode)) = (protocol.parse::<u32>(), inode.parse::<u64>()) else {
			continue;
		};
		sockets.insert(inode, Socket::Netlink(netlink_protocol(protocol)));
	}
}

/// lsof's lock characters from `/proc/locks`: `R`/`W` for a whole-file read or
/// write lock, `r`/`w` for a partial one. Waiters (`->`) hold nothing.
fn read_locks() -> HashMap<(i32, u32, u32, u64), char> {
	let mut locks = HashMap::new();
	let Ok(text) = fs::read_to_string("/proc/locks") else {
		return locks;
	};
	for line in text.lines() {
		let fields: Vec<&str> = line.split_whitespace().collect();
		if fields.len() < 8 || fields[1] == "->" {
			continue;
		}
		let whole = fields[6] == "0" && fields[7] == "EOF";
		let lock = match (fields[3], whole) {
			("READ", true) => 'R',
			("READ", false) => 'r',
			("WRITE", true) => 'W',
			("WRITE", false) => 'w',
			_ => continue,
		};
		let Ok(pid) = fields[4].parse::<i32>() else {
			continue;
		};
		let mut id = fields[5].split(':');
		let (Some(major), Some(minor), Some(inode)) = (id.next(), id.next(), id.next()) else {
			continue;
		};
		let (Ok(major), Ok(minor), Ok(inode)) =
			(u32::from_str_radix(major, 16), u32::from_str_radix(minor, 16), inode.parse::<u64>())
		else {
			continue;
		};
		locks.insert((pid, major, minor, inode), lock);
	}
	locks
}

#[cfg(test)]
mod tests {
	use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

	use super::{major, makedev, minor, parse_address};

	#[test]
	fn proc_net_addresses_are_native_endian_words() {
		let local = u32::from_ne_bytes([127, 0, 0, 1]);
		assert_eq!(
			parse_address(&format!("{local:08X}:1F90"), false),
			Some((IpAddr::V4(Ipv4Addr::LOCALHOST), 8080))
		);
		let one = u32::from_ne_bytes([0, 0, 0, 1]);
		let text = format!("000000000000000000000000{one:08X}:0050");
		assert_eq!(parse_address(&text, true), Some((IpAddr::V6(Ipv6Addr::LOCALHOST), 80)));
	}

	#[test]
	fn device_numbers_round_trip() {
		let raw = makedev(259, 70_000);
		assert_eq!((major(raw), minor(raw)), (259, 70_000));
		assert_eq!(makedev(8, 1), 0x801);
	}
}
