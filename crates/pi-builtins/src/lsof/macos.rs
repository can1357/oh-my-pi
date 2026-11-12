//! Open files from macOS libproc: `proc_pidinfo` (`PROC_PIDVNODEPATHINFO` for
//! cwd/rtd, `PROC_PIDREGIONPATHINFO` for mapped files, `PROC_PIDLISTFDS`) and
//! `proc_pidfdinfo` per descriptor.
//!
//! The `sys/proc_info.h` records `libc` lacks are ported from libproc-rs 0.14
//! (MIT).

use std::{
	collections::HashSet,
	ffi::{c_char, c_int, c_void},
	net::{IpAddr, Ipv4Addr, Ipv6Addr},
	os::unix::fs::MetadataExt,
};

use super::{Device, Entry, Fd, Inet, Listing, Node, Proto};
use crate::proc_snapshot::{ProcInfo, sys};

/// `TSI_S_*` state names in code order, as lsof prints them.
pub(super) const TCP_STATES: &[&str] = &[
	"CLOSED",
	"LISTEN",
	"SYN_SENT",
	"SYN_RECEIVED",
	"ESTABLISHED",
	"CLOSE_WAIT",
	"FIN_WAIT_1",
	"CLOSING",
	"LAST_ACK",
	"FIN_WAIT_2",
	"TIME_WAIT",
];

/// Darwin UDP sockets have no states.
pub(super) const UDP_STATES: &[&str] = &[];

/// The long process name (`pbi_name`), which lsof prints, else `pbi_comm`.
pub(super) fn command_name(process: &ProcInfo) -> String {
	sys::bsdinfo(process.pid())
		.and_then(|info| {
			let name: Vec<u8> = info.pbi_name.iter().map(|c| *c as u8).take_while(|byte| *byte != 0).collect();
			(!name.is_empty()).then(|| String::from_utf8_lossy(&name).into_owned())
		})
		.unwrap_or_else(|| process.command_name())
}

/// `dev_t` is 32 bits; std sign-extends it.
pub(super) const fn normalize_dev(dev: u64) -> u64 {
	dev as u32 as u64
}

const PROC_PIDFDVNODEPATHINFO: c_int = 2;
const PROC_PIDFDSOCKETINFO: c_int = 3;
const PROC_PIDFDPIPEINFO: c_int = 6;
const PROC_PIDFDKQUEUEINFO: c_int = 7;
const PROC_PIDREGIONPATHINFO: c_int = 8;

const SOCKINFO_IN: c_int = 1;
const SOCKINFO_TCP: c_int = 2;
const SOCKINFO_UN: c_int = 3;
const SOCKINFO_KERN_EVENT: c_int = 5;
const SOCKINFO_KERN_CTL: c_int = 6;

const INI_IPV4: u8 = 0x1;
const INI_IPV6: u8 = 0x2;

const FREAD: u32 = 0x1;
const FWRITE: u32 = 0x2;

/// Upper bound on regions walked per process, against a looping kernel answer.
const MAX_REGIONS: usize = 1 << 16;

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "kernel ABI record; only some fields are read")]
struct ProcFileInfo {
	fi_openflags:  u32,
	fi_status:     u32,
	fi_offset:     i64,
	fi_type:       i32,
	fi_guardflags: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "kernel ABI record; only some fields are read")]
struct VnodeFdInfoWithPath {
	pfi:  ProcFileInfo,
	pvip: libc::vnode_info_path,
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "kernel ABI record; only some fields are read")]
struct SockbufInfo {
	sbi_cc:    u32,
	sbi_hiwat: u32,
	sbi_mbcnt: u32,
	sbi_mbmax: u32,
	sbi_lowat: u32,
	sbi_flags: i16,
	sbi_timeo: i16,
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "kernel ABI record; only some fields are read")]
struct In6Info {
	in6_hlim:    u8,
	in6_cksum:   i32,
	in6_ifindex: u16,
	in6_hops:    i16,
}

/// `in_sockinfo`; each address union (`in4in6_addr` / `in6_addr`) is four
/// 32-bit words, the IPv4 address in the last.
#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "kernel ABI record; only some fields are read")]
struct InSockInfo {
	insi_fport:  c_int,
	insi_lport:  c_int,
	insi_gencnt: u64,
	insi_flags:  u32,
	insi_flow:   u32,
	insi_vflag:  u8,
	insi_ip_ttl: u8,
	rfu_1:       u32,
	insi_faddr:  [u32; 4],
	insi_laddr:  [u32; 4],
	insi_v4:     u8,
	insi_v6:     In6Info,
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "kernel ABI record; only some fields are read")]
struct TcpSockInfo {
	tcpsi_ini:   InSockInfo,
	tcpsi_state: c_int,
	tcpsi_timer: [c_int; 4],
	tcpsi_mss:   c_int,
	tcpsi_flags: u32,
	rfu_1:       u32,
	tcpsi_tp:    u64,
}

/// `un_sockinfo`; each address is a `sockaddr_un` in a `SOCK_MAXADDRLEN`
/// (255) byte union.
#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "kernel ABI record; only some fields are read")]
struct UnSockInfo {
	unsi_conn_so:  u64,
	unsi_conn_pcb: u64,
	unsi_addr:     [u8; 255],
	unsi_caddr:    [u8; 255],
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "kernel ABI record; only some fields are read")]
struct KernCtlInfo {
	kcsi_id:          u32,
	kcsi_reg_unit:    u32,
	kcsi_flags:       u32,
	kcsi_recvbufsize: u32,
	kcsi_sendbufsize: u32,
	kcsi_unit:        u32,
	kcsi_name:        [u8; 96],
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "kernel ABI record; only some fields are read")]
union SocketProto {
	pri_in:       InSockInfo,
	pri_tcp:      TcpSockInfo,
	pri_un:       UnSockInfo,
	pri_kern_ctl: KernCtlInfo,
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "kernel ABI record; only some fields are read")]
struct SocketInfo {
	soi_stat:     libc::vinfo_stat,
	soi_so:       u64,
	soi_pcb:      u64,
	soi_type:     c_int,
	soi_protocol: c_int,
	soi_family:   c_int,
	soi_options:  i16,
	soi_linger:   i16,
	soi_state:    i16,
	soi_qlen:     i16,
	soi_incqlen:  i16,
	soi_qlimit:   i16,
	soi_timeo:    i16,
	soi_error:    u16,
	soi_oobmark:  u32,
	soi_rcv:      SockbufInfo,
	soi_snd:      SockbufInfo,
	soi_kind:     c_int,
	rfu_1:        u32,
	soi_proto:    SocketProto,
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "kernel ABI record; only some fields are read")]
struct SocketFdInfo {
	pfi: ProcFileInfo,
	psi: SocketInfo,
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "kernel ABI record; only some fields are read")]
struct PipeInfo {
	pipe_stat:       libc::vinfo_stat,
	pipe_handle:     u64,
	pipe_peerhandle: u64,
	pipe_status:     c_int,
	rfu_1:           c_int,
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "kernel ABI record; only some fields are read")]
struct PipeFdInfo {
	pfi:      ProcFileInfo,
	pipeinfo: PipeInfo,
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "kernel ABI record; only some fields are read")]
struct KqueueInfo {
	kq_stat:  libc::vinfo_stat,
	kq_state: u32,
	rfu_1:    u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "kernel ABI record; only some fields are read")]
struct KqueueFdInfo {
	pfi:         ProcFileInfo,
	kqueueinfo:  KqueueInfo,
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "kernel ABI record; only some fields are read")]
struct ProcRegionInfo {
	pri_protection:               u32,
	pri_max_protection:           u32,
	pri_inheritance:              u32,
	pri_flags:                    u32,
	pri_offset:                   u64,
	pri_behavior:                 u32,
	pri_user_wired_count:         u32,
	pri_user_tag:                 u32,
	pri_pages_resident:           u32,
	pri_pages_shared_now_private: u32,
	pri_pages_swapped_out:        u32,
	pri_pages_dirtied:            u32,
	pri_ref_count:                u32,
	pri_shadow_depth:             u32,
	pri_share_mode:               u32,
	pri_private_pages_resident:   u32,
	pri_shared_pages_resident:    u32,
	pri_obj_id:                   u32,
	pri_depth:                    u32,
	pri_address:                  u64,
	pri_size:                     u64,
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code, reason = "kernel ABI record; only some fields are read")]
struct ProcRegionWithPathInfo {
	prp_prinfo: ProcRegionInfo,
	prp_vip:    libc::vnode_info_path,
}

/// A zeroed record of a plain-data `proc_info.h` type.
fn zeroed<T: Copy>() -> T {
	// SAFETY: only instantiated with the integer/array records above and
	// libc's, for which all-zero bytes are a valid value.
	unsafe { std::mem::zeroed() }
}

/// `proc_pidinfo(pid, flavor, arg)` into a `T`; `None` unless filled whole.
fn pid_info<T: Copy>(pid: i32, flavor: c_int, arg: u64) -> Option<T> {
	let mut record = zeroed::<T>();
	let size = size_of::<T>() as c_int;
	// SAFETY: record is writable for exactly `size` bytes.
	let filled = unsafe { libc::proc_pidinfo(pid, flavor, arg, (&raw mut record).cast::<c_void>(), size) };
	(filled >= size).then_some(record)
}

/// `proc_pidfdinfo(pid, fd, flavor)` into a `T`; `None` unless filled whole.
fn fd_info<T: Copy>(pid: i32, fd: i32, flavor: c_int) -> Option<T> {
	let mut record = zeroed::<T>();
	let size = size_of::<T>() as c_int;
	// SAFETY: record is writable for exactly `size` bytes.
	let filled = unsafe { libc::proc_pidfdinfo(pid, fd, flavor, (&raw mut record).cast::<c_void>(), size) };
	(filled >= size).then_some(record)
}

/// The descriptors of `pid`; `None` when they cannot be read.
fn list_fds(pid: i32) -> Option<Vec<libc::proc_fdinfo>> {
	// SAFETY: a null buffer asks libproc for the byte count it needs.
	let needed = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
	if needed <= 0 {
		return None;
	}
	let entry = size_of::<libc::proc_fdinfo>();
	// Room for descriptors opened between the two calls.
	let capacity = needed as usize / entry + 32;
	let mut fds = vec![libc::proc_fdinfo { proc_fd: 0, proc_fdtype: 0 }; capacity];
	// SAFETY: fds is writable for capacity * entry bytes.
	let filled = unsafe {
		libc::proc_pidinfo(
			pid,
			libc::PROC_PIDLISTFDS,
			0,
			fds.as_mut_ptr().cast::<c_void>(),
			(capacity * entry) as c_int,
		)
	};
	if filled <= 0 {
		return None;
	}
	fds.truncate((filled as usize / entry).min(capacity));
	Some(fds)
}

/// The NUL-terminated path in a `vnode_info_path`.
fn vnode_path(info: &libc::vnode_info_path) -> String {
	let bytes: Vec<u8> = info
		.vip_path
		.as_flattened()
		.iter()
		.map(|c: &c_char| *c as u8)
		.take_while(|byte| *byte != 0)
		.collect();
	String::from_utf8_lossy(&bytes).into_owned()
}

fn device(dev: u32) -> Device {
	Device::Numbers { raw: u64::from(dev), major: (dev >> 24) & 0xff, minor: dev & 0x00ff_ffff }
}

fn mode_kind(mode: u16) -> &'static str {
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

/// A row for a vnode described by `stat` and `path`.
fn vnode_entry(fd: Fd, stat: &libc::vinfo_stat, path: String) -> Entry {
	let format = stat.vst_mode & libc::S_IFMT;
	let mut entry = Entry::new(fd, mode_kind(stat.vst_mode));
	let special = format == libc::S_IFCHR || format == libc::S_IFBLK;
	entry.device = Some(device(if special { stat.vst_rdev } else { stat.vst_dev }));
	if format == libc::S_IFREG || format == libc::S_IFDIR {
		entry.size = u64::try_from(stat.vst_size).ok();
	}
	entry.node = Some(Node::Inode(stat.vst_ino));
	entry.nlink = Some(u64::from(stat.vst_nlink));
	entry.file_id = Some((u64::from(stat.vst_dev), stat.vst_ino));
	entry.name = path;
	entry
}

fn access(info: &ProcFileInfo) -> char {
	match (info.fi_openflags & FREAD != 0, info.fi_openflags & FWRITE != 0) {
		(true, true) => 'u',
		(true, false) => 'r',
		(false, true) => 'w',
		(false, false) => ' ',
	}
}

/// libproc holds no per-run tables.
pub(super) struct Scanner;

impl Scanner {
	pub(super) fn new() -> Self {
		Self
	}

	/// The open files of `pid`: cwd, rtd, txt, then descriptors.
	pub(super) fn files(&self, pid: i32, sockets_only: bool) -> Listing {
		let mut entries = Vec::new();
		let Some(fds) = list_fds(pid) else {
			return Listing { entries, denied: true };
		};
		if !sockets_only {
			if let Some(dirs) = pid_info::<libc::proc_vnodepathinfo>(pid, libc::PROC_PIDVNODEPATHINFO, 0) {
				for (fd, info) in [(Fd::Cwd, &dirs.pvi_cdir), (Fd::Rtd, &dirs.pvi_rdir)] {
					let path = vnode_path(info);
					if !path.is_empty() {
						entries.push(vnode_entry(fd, &info.vip_vi.vi_stat, path));
					}
				}
			}
			mapped_files(pid, &mut entries);
		}
		for fd in fds {
			let number = fd.proc_fd;
			let entry = match fd.proc_fdtype as c_int {
				libc::PROX_FDTYPE_SOCKET => socket_entry(pid, number),
				_ if sockets_only => None,
				libc::PROX_FDTYPE_VNODE => {
					fd_info::<VnodeFdInfoWithPath>(pid, number, PROC_PIDFDVNODEPATHINFO).map(|info| {
						let mut entry = vnode_entry(Fd::Num(number), &info.pvip.vip_vi.vi_stat, vnode_path(&info.pvip));
						if entry.size.is_none() {
							entry.offset = u64::try_from(info.pfi.fi_offset).ok();
						}
						entry.access = access(&info.pfi);
						entry
					})
				},
				libc::PROX_FDTYPE_PIPE => fd_info::<PipeFdInfo>(pid, number, PROC_PIDFDPIPEINFO).map(|info| {
					let mut entry = Entry::new(Fd::Num(number), "PIPE");
					entry.device = Some(Device::Address(info.pipeinfo.pipe_handle));
					entry.size = u64::try_from(info.pipeinfo.pipe_stat.vst_blksize).ok();
					if info.pipeinfo.pipe_peerhandle != 0 {
						entry.name = format!("->{:#x}", info.pipeinfo.pipe_peerhandle);
					}
					entry.access = access(&info.pfi);
					entry
				}),
				libc::PROX_FDTYPE_KQUEUE => fd_info::<KqueueFdInfo>(pid, number, PROC_PIDFDKQUEUEINFO).map(|info| {
					let mut entry = Entry::new(Fd::Num(number), "KQUEUE");
					entry.name = format!(
						"count={}, state={:#x}",
						info.kqueueinfo.kq_stat.vst_size, info.kqueueinfo.kq_state
					);
					entry.access = access(&info.pfi);
					entry
				}),
				kind => Some(Entry::new(Fd::Num(number), match kind {
					libc::PROX_FDTYPE_ATALK => "ATALK",
					libc::PROX_FDTYPE_PSHM => "PSXSHM",
					libc::PROX_FDTYPE_PSEM => "PSXSEM",
					libc::PROX_FDTYPE_FSEVENTS => "FSEVENT",
					libc::PROX_FDTYPE_NETPOLICY => "NPOLICY",
					libc::PROX_FDTYPE_CHANNEL => "CHAN",
					libc::PROX_FDTYPE_NEXUS => "NEXUS",
					_ => "unknown",
				})),
			};
			entries.extend(entry);
		}
		Listing { entries, denied: false }
	}
}

/// `txt` rows: every file mapped into `pid`, once each, in address order;
/// the executable alone when the regions cannot be read.
fn mapped_files(pid: i32, entries: &mut Vec<Entry>) {
	let mut seen = HashSet::new();
	let mut address = 0u64;
	for _ in 0..MAX_REGIONS {
		let Some(region) = pid_info::<ProcRegionWithPathInfo>(pid, PROC_PIDREGIONPATHINFO, address) else {
			break;
		};
		let stat = &region.prp_vip.vip_vi.vi_stat;
		let path = vnode_path(&region.prp_vip);
		if !path.is_empty() && seen.insert((stat.vst_dev, stat.vst_ino)) {
			entries.push(vnode_entry(Fd::Txt, stat, path));
		}
		let next = region.prp_prinfo.pri_address.saturating_add(region.prp_prinfo.pri_size);
		if next <= address {
			break;
		}
		address = next;
	}
	if seen.is_empty() {
		let mut buffer = [0u8; sys::PATH_CAPACITY];
		if let Some(path) = sys::executable_path(pid, &mut buffer) {
			let path = String::from_utf8_lossy(path).into_owned();
			if let Ok(metadata) = std::fs::metadata(&path) {
				let mut entry = Entry::new(Fd::Txt, "REG");
				let dev = metadata.dev() as u32;
				entry.device = Some(device(dev));
				entry.size = Some(metadata.size());
				entry.node = Some(Node::Inode(metadata.ino()));
				entry.nlink = Some(metadata.nlink());
				entry.file_id = Some((u64::from(dev), metadata.ino()));
				entry.name = path;
				entries.push(entry);
			}
		}
	}
}

fn in_address(words: &[u32; 4], flags: u8) -> Option<IpAddr> {
	if flags & INI_IPV4 != 0 {
		Some(IpAddr::V4(Ipv4Addr::from(words[3].to_ne_bytes())))
	} else if flags & INI_IPV6 != 0 {
		let mut bytes = [0u8; 16];
		for (chunk, word) in bytes.chunks_exact_mut(4).zip(words) {
			chunk.copy_from_slice(&word.to_ne_bytes());
		}
		Some(IpAddr::V6(Ipv6Addr::from(bytes)))
	} else {
		None
	}
}

/// A port kept in network order in the low 16 bits of an `int`.
fn in_port(port: c_int) -> u16 {
	u16::from_be(port as u16)
}

fn socket_entry(pid: i32, fd: i32) -> Option<Entry> {
	let info = fd_info::<SocketFdInfo>(pid, fd, PROC_PIDFDSOCKETINFO)?;
	let socket = &info.psi;
	let kind = match socket.soi_family {
		libc::AF_INET => "IPv4",
		libc::AF_INET6 => "IPv6",
		libc::AF_UNIX => "unix",
		libc::AF_SYSTEM => "systm",
		libc::AF_NDRV => "ndrv",
		libc::PF_KEY => "key",
		libc::AF_ROUTE => "rte",
		_ => "sock",
	};
	let mut entry = Entry::new(Fd::Num(fd), kind);
	entry.device = Some(Device::Address(socket.soi_so));
	entry.offset = u64::try_from(info.pfi.fi_offset).ok();
	entry.access = access(&info.pfi);
	match socket.soi_kind {
		SOCKINFO_IN | SOCKINFO_TCP => {
			// SAFETY: soi_kind says which union member the kernel filled; the
			// TCP record begins with the Internet one.
			let (inet, state) = unsafe {
				if socket.soi_kind == SOCKINFO_TCP {
					(socket.soi_proto.pri_tcp.tcpsi_ini, Some(socket.soi_proto.pri_tcp.tcpsi_state))
				} else {
					(socket.soi_proto.pri_in, None)
				}
			};
			let proto = match socket.soi_protocol {
				libc::IPPROTO_TCP => Proto::Tcp,
				libc::IPPROTO_UDP => Proto::Udp,
				_ => {
					entry.node = Some(Node::Protocol(if socket.soi_protocol == libc::IPPROTO_ICMP {
						"ICMP"
					} else {
						"IP"
					}));
					return Some(entry);
				},
			};
			let local = in_address(&inet.insi_laddr, inet.insi_vflag)?;
			let remote = in_address(&inet.insi_faddr, inet.insi_vflag)?;
			let mut endpoints =
				Inet::new(proto, (local, in_port(inet.insi_lport)), (remote, in_port(inet.insi_fport)));
			endpoints.state = state
				.and_then(|state| usize::try_from(state).ok())
				.and_then(|state| TCP_STATES.get(state))
				.copied();
			endpoints.queues = Some((u64::from(socket.soi_rcv.sbi_cc), u64::from(socket.soi_snd.sbi_cc)));
			entry.node = Some(Node::Protocol(proto.name()));
			entry.inet = Some(endpoints);
		},
		SOCKINFO_UN => {
			// SAFETY: soi_kind says the kernel filled the UNIX-domain member.
			let unix = unsafe { socket.soi_proto.pri_un };
			let path = sockaddr_un_path(&unix.unsi_addr);
			entry.name = if !path.is_empty() {
				path
			} else if unix.unsi_conn_so != 0 {
				format!("->{:#x}", unix.unsi_conn_so)
			} else {
				String::new()
			};
		},
		SOCKINFO_KERN_CTL => {
			// SAFETY: soi_kind says the kernel filled the kernel-control member.
			let control = unsafe { socket.soi_proto.pri_kern_ctl };
			let name = control.kcsi_name.iter().take_while(|byte| **byte != 0).map(|byte| char::from(*byte)).collect::<String>();
			entry.name = format!("[ctl {name} id {} unit {}]", control.kcsi_id, control.kcsi_unit);
		},
		SOCKINFO_KERN_EVENT => entry.name = "[kev]".to_owned(),
		_ => {},
	}
	Some(entry)
}

/// `sun_path` of a `sockaddr_un` (`sun_len`, `sun_family`, then the path).
fn sockaddr_un_path(address: &[u8; 255]) -> String {
	let length = usize::from(address[0]).clamp(2, address.len());
	let path: Vec<u8> = address[2..length].iter().copied().take_while(|byte| *byte != 0).collect();
	String::from_utf8_lossy(&path).into_owned()
}

#[cfg(test)]
mod tests {
	use super::{SocketFdInfo, VnodeFdInfoWithPath};

	#[test]
	fn record_sizes_match_the_kernel_abi() {
		// sizeof(struct socket_fdinfo) and sizeof(struct vnode_fdinfowithpath)
		// on 64-bit Darwin.
		assert_eq!(size_of::<SocketFdInfo>(), 792);
		assert_eq!(size_of::<VnodeFdInfoWithPath>(), 1200);
	}
}
