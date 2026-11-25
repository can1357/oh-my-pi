//! Socket: address packing, name/number conversion, and the platform's socket constants (Socket 2.031 API).
//!
//! Constants the platform does not define croak when called, as the XS module does. Name lookups use
//! the hosts and services databases plus the system resolver, like `gethostbyname`.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddrV4, SocketAddrV6};

use socket2::SockAddr;

use crate::perl::{
	func::sys::{pack_sockaddr, sockaddr_family},
	interp::{Cx, Interp, PResult, Ret},
	value::{Dual, HKey, Num, PStr, Ref, Sv, Value, new_hv, new_sv},
};

use super::{arg, constant, define, export, export_tag, version};

const EXPORT: &str = "
	PF_802 PF_AAL PF_APPLETALK PF_CCITT PF_CHAOS PF_CTF PF_DATAKIT PF_DECnet PF_DLI PF_ECMA PF_GOSIP PF_HYLINK PF_IMPLINK
	PF_INET PF_INET6 PF_ISO PF_KEY PF_LAST PF_LAT PF_LINK PF_MAX PF_NBS PF_NIT PF_NS PF_OSI PF_OSINET PF_PUP PF_ROUTE
	PF_SNA PF_UNIX PF_UNSPEC PF_USER PF_WAN PF_X25 AF_802 AF_AAL AF_APPLETALK AF_CCITT AF_CHAOS AF_CTF AF_DATAKIT
	AF_DECnet AF_DLI AF_ECMA AF_GOSIP AF_HYLINK AF_IMPLINK AF_INET AF_INET6 AF_ISO AF_KEY AF_LAST AF_LAT AF_LINK AF_MAX
	AF_NBS AF_NIT AF_NS AF_OSI AF_OSINET AF_PUP AF_ROUTE AF_SNA AF_UNIX AF_UNSPEC AF_USER AF_WAN AF_X25 SOCK_DGRAM
	SOCK_RAW SOCK_RDM SOCK_SEQPACKET SOCK_STREAM SOL_SOCKET SO_ACCEPTCONN SO_ATTACH_FILTER SO_BACKLOG SO_BROADCAST
	SO_CHAMELEON SO_DEBUG SO_DETACH_FILTER SO_DGRAM_ERRIND SO_DOMAIN SO_DONTLINGER SO_DONTROUTE SO_ERROR SO_FAMILY
	SO_KEEPALIVE SO_LINGER SO_OOBINLINE SO_PASSCRED SO_PASSIFNAME SO_PEERCRED SO_PROTOCOL SO_PROTOTYPE SO_RCVBUF
	SO_RCVLOWAT SO_RCVTIMEO SO_REUSEADDR SO_REUSEPORT SO_SECURITY_AUTHENTICATION SO_SECURITY_ENCRYPTION_NETWORK
	SO_SECURITY_ENCRYPTION_TRANSPORT SO_SNDBUF SO_SNDLOWAT SO_SNDTIMEO SO_STATE SO_TYPE SO_USELOOPBACK SO_XOPEN SO_XSE
	IP_HDRINCL IP_OPTIONS IP_RECVOPTS IP_RECVRETOPTS IP_RETOPTS IP_TOS IP_TTL MSG_BCAST MSG_BTAG MSG_CTLFLAGS
	MSG_CTLIGNORE MSG_CTRUNC MSG_DONTROUTE MSG_DONTWAIT MSG_EOF MSG_EOR MSG_ERRQUEUE MSG_ETAG MSG_FASTOPEN MSG_FIN
	MSG_MAXIOVLEN MSG_MCAST MSG_NOSIGNAL MSG_OOB MSG_PEEK MSG_PROXY MSG_RST MSG_SYN MSG_TRUNC MSG_URG MSG_WAITALL MSG_WIRE
	SHUT_RD SHUT_RDWR SHUT_WR INADDR_ANY INADDR_BROADCAST INADDR_LOOPBACK INADDR_NONE SCM_CONNECT SCM_CREDENTIALS
	SCM_CREDS SCM_RIGHTS SCM_TIMESTAMP SOMAXCONN IOV_MAX UIO_MAXIOV sockaddr_family pack_sockaddr_in unpack_sockaddr_in
	sockaddr_in pack_sockaddr_in6 unpack_sockaddr_in6 sockaddr_in6 pack_sockaddr_un unpack_sockaddr_un sockaddr_un
	inet_aton inet_ntoa
";
const EXPORT_OK: &str = "
	CR LF CRLF $CR $LF $CRLF SOCK_NONBLOCK SOCK_CLOEXEC IP_ADD_MEMBERSHIP IP_ADD_SOURCE_MEMBERSHIP IP_BIND_ADDRESS_NO_PORT
	IP_DROP_MEMBERSHIP IP_DROP_SOURCE_MEMBERSHIP IP_FREEBIND IP_MULTICAST_ALL IP_MULTICAST_IF IP_MULTICAST_LOOP
	IP_MULTICAST_TTL IP_MTU IP_MTU_DISCOVER IP_NODEFRAG IP_RECVERR IP_TRANSPARENT IPPROTO_IP IPPROTO_IPV6 IPPROTO_RAW
	IPPROTO_ICMP IPPROTO_IGMP IPPROTO_TCP IPPROTO_UDP IPPROTO_GRE IPPROTO_ESP IPPROTO_AH IPPROTO_ICMPV6 IPPROTO_SCTP
	IP_PMTUDISC_DO IP_PMTUDISC_DONT IP_PMTUDISC_PROBE IP_PMTUDISC_WANT IPTOS_LOWDELAY IPTOS_THROUGHPUT IPTOS_RELIABILITY
	IPTOS_MINCOST TCP_CONGESTION TCP_CONNECTIONTIMEOUT TCP_CORK TCP_DEFER_ACCEPT TCP_FASTOPEN TCP_INFO TCP_INIT_CWND
	TCP_KEEPALIVE TCP_KEEPCNT TCP_KEEPIDLE TCP_KEEPINTVL TCP_LINGER2 TCP_MAXRT TCP_MAXSEG TCP_MD5SIG TCP_NODELAY TCP_NOOPT
	TCP_NOPUSH TCP_QUICKACK TCP_SACK_ENABLE TCP_STDURG TCP_SYNCNT TCP_USER_TIMEOUT TCP_WINDOW_CLAMP IN6ADDR_ANY
	IN6ADDR_LOOPBACK IPV6_ADDRFROM IPV6_ADD_MEMBERSHIP IPV6_DROP_MEMBERSHIP IPV6_JOIN_GROUP IPV6_LEAVE_GROUP IPV6_MTU
	IPV6_MTU_DISCOVER IPV6_MULTICAST_HOPS IPV6_MULTICAST_IF IPV6_MULTICAST_LOOP IPV6_RECVERR IPV6_ROUTER_ALERT
	IPV6_UNICAST_HOPS IPV6_V6ONLY SO_LOCK_FILTER SO_RCVBUFFORCE SO_SNDBUFFORCE pack_ip_mreq unpack_ip_mreq
	pack_ip_mreq_source unpack_ip_mreq_source pack_ipv6_mreq unpack_ipv6_mreq inet_pton inet_ntop getaddrinfo getnameinfo
	AI_ADDRCONFIG AI_ALL AI_CANONIDN AI_CANONNAME AI_IDN AI_IDN_ALLOW_UNASSIGNED AI_IDN_USE_STD3_ASCII_RULES
	AI_NUMERICHOST AI_NUMERICSERV AI_PASSIVE AI_V4MAPPED NI_DGRAM NI_IDN NI_IDN_ALLOW_UNASSIGNED
	NI_IDN_USE_STD3_ASCII_RULES NI_NAMEREQD NI_NOFQDN NI_NUMERICHOST NI_NUMERICSERV NIx_NOHOST NIx_NOSERV EAI_ADDRFAMILY
	EAI_AGAIN EAI_BADFLAGS EAI_BADHINTS EAI_FAIL EAI_FAMILY EAI_NODATA EAI_NONAME EAI_PROTOCOL EAI_SERVICE EAI_SOCKTYPE
	EAI_SYSTEM
";

/// Constants libc defines on both Apple platforms and Linux.
#[cfg(any(target_vendor = "apple", target_os = "linux"))]
const BOTH: &[(&str, i64)] = &[
	("PF_APPLETALK", libc::PF_APPLETALK as i64), ("PF_DECnet", libc::PF_DECnet as i64), ("PF_INET", libc::PF_INET as i64),
	("PF_INET6", libc::PF_INET6 as i64), ("PF_KEY", libc::PF_KEY as i64), ("PF_ROUTE", libc::PF_ROUTE as i64),
	("PF_SNA", libc::PF_SNA as i64), ("PF_UNIX", libc::PF_UNIX as i64), ("PF_UNSPEC", libc::PF_UNSPEC as i64),
	("AF_APPLETALK", libc::AF_APPLETALK as i64), ("AF_DECnet", libc::AF_DECnet as i64), ("AF_INET", libc::AF_INET as i64),
	("AF_INET6", libc::AF_INET6 as i64), ("AF_ROUTE", libc::AF_ROUTE as i64), ("AF_SNA", libc::AF_SNA as i64),
	("AF_UNIX", libc::AF_UNIX as i64), ("AF_UNSPEC", libc::AF_UNSPEC as i64), ("SOCK_DGRAM", libc::SOCK_DGRAM as i64),
	("SOCK_RAW", libc::SOCK_RAW as i64), ("SOCK_RDM", libc::SOCK_RDM as i64), ("SOCK_SEQPACKET", libc::SOCK_SEQPACKET as i64),
	("SOCK_STREAM", libc::SOCK_STREAM as i64), ("SOL_SOCKET", libc::SOL_SOCKET as i64), ("SO_ACCEPTCONN", libc::SO_ACCEPTCONN as i64),
	("SO_BROADCAST", libc::SO_BROADCAST as i64), ("SO_DEBUG", libc::SO_DEBUG as i64), ("SO_DONTROUTE", libc::SO_DONTROUTE as i64),
	("SO_ERROR", libc::SO_ERROR as i64), ("SO_KEEPALIVE", libc::SO_KEEPALIVE as i64), ("SO_LINGER", libc::SO_LINGER as i64),
	("SO_OOBINLINE", libc::SO_OOBINLINE as i64), ("SO_RCVBUF", libc::SO_RCVBUF as i64), ("SO_RCVLOWAT", libc::SO_RCVLOWAT as i64),
	("SO_RCVTIMEO", libc::SO_RCVTIMEO as i64), ("SO_REUSEADDR", libc::SO_REUSEADDR as i64), ("SO_REUSEPORT", libc::SO_REUSEPORT as i64),
	("SO_SNDBUF", libc::SO_SNDBUF as i64), ("SO_SNDLOWAT", libc::SO_SNDLOWAT as i64), ("SO_SNDTIMEO", libc::SO_SNDTIMEO as i64),
	("SO_TYPE", libc::SO_TYPE as i64), ("IP_HDRINCL", libc::IP_HDRINCL as i64), ("IP_TOS", libc::IP_TOS as i64),
	("IP_TTL", libc::IP_TTL as i64), ("MSG_CTRUNC", libc::MSG_CTRUNC as i64), ("MSG_DONTROUTE", libc::MSG_DONTROUTE as i64),
	("MSG_DONTWAIT", libc::MSG_DONTWAIT as i64), ("MSG_EOR", libc::MSG_EOR as i64), ("MSG_NOSIGNAL", libc::MSG_NOSIGNAL as i64),
	("MSG_OOB", libc::MSG_OOB as i64), ("MSG_PEEK", libc::MSG_PEEK as i64), ("MSG_TRUNC", libc::MSG_TRUNC as i64),
	("MSG_WAITALL", libc::MSG_WAITALL as i64), ("SHUT_RD", libc::SHUT_RD as i64), ("SHUT_RDWR", libc::SHUT_RDWR as i64),
	("SHUT_WR", libc::SHUT_WR as i64), ("SCM_RIGHTS", libc::SCM_RIGHTS as i64), ("SCM_TIMESTAMP", libc::SCM_TIMESTAMP as i64),
	("SOMAXCONN", libc::SOMAXCONN as i64), ("IP_ADD_MEMBERSHIP", libc::IP_ADD_MEMBERSHIP as i64), ("IP_ADD_SOURCE_MEMBERSHIP", libc::IP_ADD_SOURCE_MEMBERSHIP as i64),
	("IP_DROP_MEMBERSHIP", libc::IP_DROP_MEMBERSHIP as i64), ("IP_DROP_SOURCE_MEMBERSHIP", libc::IP_DROP_SOURCE_MEMBERSHIP as i64), ("IP_MULTICAST_IF", libc::IP_MULTICAST_IF as i64),
	("IP_MULTICAST_LOOP", libc::IP_MULTICAST_LOOP as i64), ("IP_MULTICAST_TTL", libc::IP_MULTICAST_TTL as i64), ("IPPROTO_IP", libc::IPPROTO_IP as i64),
	("IPPROTO_IPV6", libc::IPPROTO_IPV6 as i64), ("IPPROTO_RAW", libc::IPPROTO_RAW as i64), ("IPPROTO_ICMP", libc::IPPROTO_ICMP as i64),
	("IPPROTO_IGMP", libc::IPPROTO_IGMP as i64), ("IPPROTO_TCP", libc::IPPROTO_TCP as i64), ("IPPROTO_UDP", libc::IPPROTO_UDP as i64),
	("IPPROTO_GRE", libc::IPPROTO_GRE as i64), ("IPPROTO_ESP", libc::IPPROTO_ESP as i64), ("IPPROTO_AH", libc::IPPROTO_AH as i64),
	("IPPROTO_ICMPV6", libc::IPPROTO_ICMPV6 as i64), ("IPPROTO_SCTP", libc::IPPROTO_SCTP as i64), ("TCP_FASTOPEN", libc::TCP_FASTOPEN as i64),
	("TCP_KEEPCNT", libc::TCP_KEEPCNT as i64), ("TCP_KEEPINTVL", libc::TCP_KEEPINTVL as i64), ("TCP_MAXSEG", libc::TCP_MAXSEG as i64),
	("TCP_NODELAY", libc::TCP_NODELAY as i64), ("IPV6_MULTICAST_HOPS", libc::IPV6_MULTICAST_HOPS as i64), ("IPV6_MULTICAST_IF", libc::IPV6_MULTICAST_IF as i64),
	("IPV6_MULTICAST_LOOP", libc::IPV6_MULTICAST_LOOP as i64), ("IPV6_UNICAST_HOPS", libc::IPV6_UNICAST_HOPS as i64), ("IPV6_V6ONLY", libc::IPV6_V6ONLY as i64),
	("AI_ADDRCONFIG", libc::AI_ADDRCONFIG as i64), ("AI_ALL", libc::AI_ALL as i64), ("AI_CANONNAME", libc::AI_CANONNAME as i64),
	("AI_NUMERICHOST", libc::AI_NUMERICHOST as i64), ("AI_NUMERICSERV", libc::AI_NUMERICSERV as i64), ("AI_PASSIVE", libc::AI_PASSIVE as i64),
	("AI_V4MAPPED", libc::AI_V4MAPPED as i64), ("NI_DGRAM", libc::NI_DGRAM as i64), ("NI_NAMEREQD", libc::NI_NAMEREQD as i64),
	("NI_NOFQDN", libc::NI_NOFQDN as i64), ("NI_NUMERICHOST", libc::NI_NUMERICHOST as i64), ("NI_NUMERICSERV", libc::NI_NUMERICSERV as i64),
	("EAI_AGAIN", libc::EAI_AGAIN as i64), ("EAI_BADFLAGS", libc::EAI_BADFLAGS as i64), ("EAI_FAIL", libc::EAI_FAIL as i64),
	("EAI_FAMILY", libc::EAI_FAMILY as i64), ("EAI_NODATA", libc::EAI_NODATA as i64), ("EAI_NONAME", libc::EAI_NONAME as i64),
	("EAI_SERVICE", libc::EAI_SERVICE as i64), ("EAI_SOCKTYPE", libc::EAI_SOCKTYPE as i64), ("EAI_SYSTEM", libc::EAI_SYSTEM as i64),
];
#[cfg(target_vendor = "apple")]
const APPLE: &[(&str, i64)] = &[
	("PF_CCITT", libc::PF_CCITT as i64), ("PF_CHAOS", libc::PF_CHAOS as i64), ("PF_DATAKIT", libc::PF_DATAKIT as i64),
	("PF_DLI", libc::PF_DLI as i64), ("PF_ECMA", libc::PF_ECMA as i64), ("PF_HYLINK", libc::PF_HYLINK as i64),
	("PF_IMPLINK", libc::PF_IMPLINK as i64), ("PF_ISO", libc::PF_ISO as i64), ("PF_LAT", libc::PF_LAT as i64),
	("PF_LINK", libc::PF_LINK as i64), ("PF_NS", libc::PF_NS as i64), ("PF_OSI", libc::PF_OSI as i64),
	("PF_PUP", libc::PF_PUP as i64), ("AF_CCITT", libc::AF_CCITT as i64), ("AF_CHAOS", libc::AF_CHAOS as i64),
	("AF_DATAKIT", libc::AF_DATAKIT as i64), ("AF_DLI", libc::AF_DLI as i64), ("AF_ECMA", libc::AF_ECMA as i64),
	("AF_HYLINK", libc::AF_HYLINK as i64), ("AF_IMPLINK", libc::AF_IMPLINK as i64), ("AF_ISO", libc::AF_ISO as i64),
	("AF_LAT", libc::AF_LAT as i64), ("AF_LINK", libc::AF_LINK as i64), ("AF_NS", libc::AF_NS as i64),
	("AF_OSI", libc::AF_OSI as i64), ("AF_PUP", libc::AF_PUP as i64), ("SO_USELOOPBACK", libc::SO_USELOOPBACK as i64),
	("MSG_EOF", libc::MSG_EOF as i64), ("SCM_CREDS", libc::SCM_CREDS as i64), ("IOV_MAX", libc::IOV_MAX as i64),
	("TCP_KEEPALIVE", libc::TCP_KEEPALIVE as i64), ("TCP_NOOPT", libc::TCP_NOOPT as i64), ("TCP_NOPUSH", libc::TCP_NOPUSH as i64),
	("IPV6_JOIN_GROUP", libc::IPV6_JOIN_GROUP as i64), ("IPV6_LEAVE_GROUP", libc::IPV6_LEAVE_GROUP as i64),
];
#[cfg(target_os = "linux")]
const LINUX: &[(&str, i64)] = &[
	("PF_X25", libc::PF_X25 as i64), ("AF_KEY", libc::AF_KEY as i64), ("AF_X25", libc::AF_X25 as i64),
	("SO_ATTACH_FILTER", libc::SO_ATTACH_FILTER as i64), ("SO_DETACH_FILTER", libc::SO_DETACH_FILTER as i64), ("SO_DOMAIN", libc::SO_DOMAIN as i64),
	("SO_PASSCRED", libc::SO_PASSCRED as i64), ("SO_PEERCRED", libc::SO_PEERCRED as i64), ("SO_PROTOCOL", libc::SO_PROTOCOL as i64),
	("SO_SECURITY_AUTHENTICATION", libc::SO_SECURITY_AUTHENTICATION as i64), ("SO_SECURITY_ENCRYPTION_NETWORK", libc::SO_SECURITY_ENCRYPTION_NETWORK as i64), ("SO_SECURITY_ENCRYPTION_TRANSPORT", libc::SO_SECURITY_ENCRYPTION_TRANSPORT as i64),
	("IP_OPTIONS", libc::IP_OPTIONS as i64), ("IP_RECVOPTS", libc::IP_RECVOPTS as i64), ("IP_RETOPTS", libc::IP_RETOPTS as i64),
	("MSG_ERRQUEUE", libc::MSG_ERRQUEUE as i64), ("MSG_FASTOPEN", libc::MSG_FASTOPEN as i64), ("MSG_FIN", libc::MSG_FIN as i64),
	("MSG_RST", libc::MSG_RST as i64), ("MSG_SYN", libc::MSG_SYN as i64), ("SCM_CREDENTIALS", libc::SCM_CREDENTIALS as i64),
	("UIO_MAXIOV", libc::UIO_MAXIOV as i64), ("SOCK_NONBLOCK", libc::SOCK_NONBLOCK as i64), ("SOCK_CLOEXEC", libc::SOCK_CLOEXEC as i64),
	("IP_BIND_ADDRESS_NO_PORT", libc::IP_BIND_ADDRESS_NO_PORT as i64), ("IP_FREEBIND", libc::IP_FREEBIND as i64), ("IP_MULTICAST_ALL", libc::IP_MULTICAST_ALL as i64),
	("IP_MTU", libc::IP_MTU as i64), ("IP_MTU_DISCOVER", libc::IP_MTU_DISCOVER as i64), ("IP_NODEFRAG", libc::IP_NODEFRAG as i64),
	("IP_RECVERR", libc::IP_RECVERR as i64), ("IP_TRANSPARENT", libc::IP_TRANSPARENT as i64), ("IP_PMTUDISC_DO", libc::IP_PMTUDISC_DO as i64),
	("IP_PMTUDISC_DONT", libc::IP_PMTUDISC_DONT as i64), ("IP_PMTUDISC_PROBE", libc::IP_PMTUDISC_PROBE as i64), ("IP_PMTUDISC_WANT", libc::IP_PMTUDISC_WANT as i64),
	("IPTOS_LOWDELAY", libc::IPTOS_LOWDELAY as i64), ("IPTOS_THROUGHPUT", libc::IPTOS_THROUGHPUT as i64), ("IPTOS_RELIABILITY", libc::IPTOS_RELIABILITY as i64),
	("IPTOS_MINCOST", libc::IPTOS_MINCOST as i64), ("TCP_CONGESTION", libc::TCP_CONGESTION as i64), ("TCP_CORK", libc::TCP_CORK as i64),
	("TCP_DEFER_ACCEPT", libc::TCP_DEFER_ACCEPT as i64), ("TCP_INFO", libc::TCP_INFO as i64), ("TCP_KEEPIDLE", libc::TCP_KEEPIDLE as i64),
	("TCP_LINGER2", libc::TCP_LINGER2 as i64), ("TCP_MD5SIG", libc::TCP_MD5SIG as i64), ("TCP_QUICKACK", libc::TCP_QUICKACK as i64),
	("TCP_SYNCNT", libc::TCP_SYNCNT as i64), ("TCP_USER_TIMEOUT", libc::TCP_USER_TIMEOUT as i64), ("TCP_WINDOW_CLAMP", libc::TCP_WINDOW_CLAMP as i64),
	("IPV6_ADD_MEMBERSHIP", libc::IPV6_ADD_MEMBERSHIP as i64), ("IPV6_DROP_MEMBERSHIP", libc::IPV6_DROP_MEMBERSHIP as i64), ("IPV6_MTU", libc::IPV6_MTU as i64),
	("IPV6_MTU_DISCOVER", libc::IPV6_MTU_DISCOVER as i64), ("IPV6_RECVERR", libc::IPV6_RECVERR as i64), ("IPV6_ROUTER_ALERT", libc::IPV6_ROUTER_ALERT as i64),
	("SO_LOCK_FILTER", libc::SO_LOCK_FILTER as i64), ("SO_RCVBUFFORCE", libc::SO_RCVBUFFORCE as i64), ("SO_SNDBUFFORCE", libc::SO_SNDBUFFORCE as i64),
	("NI_IDN", libc::NI_IDN as i64),
];

/// Packed IPv4 constants (`inet_aton` form).
const INET_ADDRESSES: &[(&str, Ipv4Addr)] = &[
	("INADDR_ANY", Ipv4Addr::UNSPECIFIED), ("INADDR_LOOPBACK", Ipv4Addr::LOCALHOST),
	("INADDR_BROADCAST", Ipv4Addr::BROADCAST), ("INADDR_NONE", Ipv4Addr::BROADCAST),
];

fn platform_constants() -> impl Iterator<Item = (&'static str, i64)> {
	let mut tables: Vec<&[(&str, i64)]> = Vec::new();
	#[cfg(any(target_vendor = "apple", target_os = "linux"))]
	tables.push(BOTH);
	#[cfg(target_vendor = "apple")]
	tables.push(APPLE);
	#[cfg(target_os = "linux")]
	tables.push(LINUX);
	tables.into_iter().flatten().copied()
}

/// Install Socket.
pub(super) fn load(interp: &mut Interp<'_>, module: &str) -> PResult<()> {
	version(interp, module, "2.031");
	let defined: Vec<(&str, i64)> = platform_constants().collect();
	for &(name, value) in &defined { constant(interp, &format!("Socket::{name}"), Value::Int(value)); }
	for (name, ip) in INET_ADDRESSES { constant(interp, &format!("Socket::{name}"), Value::Str(PStr::from_bytes(&ip.octets()))); }
	constant(interp, "Socket::IN6ADDR_ANY", Value::Str(PStr::from_bytes(&Ipv6Addr::UNSPECIFIED.octets())));
	constant(interp, "Socket::IN6ADDR_LOOPBACK", Value::Str(PStr::from_bytes(&Ipv6Addr::LOCALHOST.octets())));
	for (name, text) in [("CR", "\r"), ("LF", "\n"), ("CRLF", "\r\n")] {
		constant(interp, &format!("Socket::{name}"), Value::str(text));
		interp.sv(&format!("Socket::{name}")).set(Value::str(text));
	}
	constant(interp, "Socket::NIx_NOHOST", Value::Int(1));
	constant(interp, "Socket::NIx_NOSERV", Value::Int(2));
	define(interp, module, &[
		("inet_aton", inet_aton), ("inet_ntoa", inet_ntoa), ("inet_pton", inet_pton), ("inet_ntop", inet_ntop),
		("sockaddr_family", family), ("pack_sockaddr_in", pack_in), ("unpack_sockaddr_in", unpack_in), ("sockaddr_in", sockaddr_in),
		("pack_sockaddr_in6", pack_in6), ("unpack_sockaddr_in6", unpack_in6), ("sockaddr_in6", sockaddr_in6),
		("pack_sockaddr_un", pack_un), ("unpack_sockaddr_un", unpack_un), ("sockaddr_un", sockaddr_un),
		("pack_ip_mreq", pack_ip_mreq), ("unpack_ip_mreq", unpack_ip_mreq),
		("pack_ip_mreq_source", pack_ip_mreq_source), ("unpack_ip_mreq_source", unpack_ip_mreq_source),
		("pack_ipv6_mreq", pack_ipv6_mreq), ("unpack_ipv6_mreq", unpack_ipv6_mreq),
		("getaddrinfo", getaddrinfo), ("getnameinfo", getnameinfo),
	]);
	let defaults: Vec<&str> = EXPORT.split_whitespace().collect();
	let optional: Vec<&str> = EXPORT_OK.split_whitespace().collect();
	for &name in defaults.iter().chain(&optional) {
		let is_constant = name.starts_with(|c: char| c.is_ascii_uppercase());
		let qualified = format!("Socket::{name}");
		if is_constant && interp.glob(&qualified).code.borrow().is_none() { interp.define_native(&qualified, undefined_macro); }
	}
	export(interp, module, &defaults, &optional);
	export_tag(interp, module, "crlf", &["CR", "LF", "CRLF", "$CR", "$LF", "$CRLF"]);
	let addrinfo: Vec<&str> = ["getaddrinfo", "getnameinfo"].into_iter()
		.chain(optional.iter().copied().filter(|n| ["AI_", "NI_", "NIx_", "EAI_"].iter().any(|p| n.starts_with(p)))).collect();
	export_tag(interp, module, "addrinfo", &addrinfo);
	let all: Vec<&str> = defaults.iter().chain(&optional).copied().collect();
	export_tag(interp, module, "all", &all);
	Ok(())
}

/// A listed constant the platform lacks: the sub's own name says which.
fn undefined_macro(interp: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let name = interp.current_sub_name().map_or_else(String::new, |sub| sub.rsplit("::").next().unwrap_or_default().to_owned());
	Err(interp.die_msg(format!("Your vendor has not defined Socket macro {name}, used")))
}

fn bytes_arg(interp: &mut Interp<'_>, args: &[Sv], index: usize, function: &str) -> PResult<Vec<u8>> {
	let value = arg(args, index);
	let text = interp.stringify(&value)?;
	if !text.utf8 { return Ok(text.bytes); }
	text.downgraded().ok_or_else(|| interp.die_msg(format!("Wide character in Socket::{function}")))
}

fn bad_length(interp: &mut Interp<'_>, function: &str, got: usize, want: usize) -> crate::perl::interp::Flow {
	interp.die_msg(format!("Bad arg length for Socket::{function}, length is {got}, should be {want}"))
}

fn packed(bytes: &[u8]) -> Value { Value::Str(PStr::from_bytes(bytes)) }

fn one(value: Value) -> PResult<Ret> { Ok(Ret::One(value)) }

/// inet_aton(3) numbers-and-dots forms (`a`, `a.b`, `a.b.c`, `a.b.c.d`; each part decimal, 0octal, or 0xhex).
fn parse_inet_aton(text: &str) -> Option<Ipv4Addr> {
	let parts: Vec<u64> = text.split('.').map(|part| {
		let (digits, radix) = if let Some(hex) = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X")) { (hex, 16) }
			else if part.len() > 1 && part.starts_with('0') { (&part[1..], 8) } else { (part, 10) };
		if digits.is_empty() && radix != 8 { return None; }
		if digits.is_empty() { return Some(0); }
		u64::from_str_radix(digits, radix).ok()
	}).collect::<Option<_>>()?;
	let (last, head) = parts.split_last()?;
	if head.len() > 3 || head.iter().any(|&p| p > 0xff) || *last >= 1u64 << (8 * (4 - head.len())) { return None; }
	let value = head.iter().enumerate().fold(*last, |acc, (i, &p)| acc | (p << (24 - 8 * i)));
	Some(Ipv4Addr::from(value as u32))
}

fn hosts_file(interp: &mut Interp<'_>) -> Vec<u8> {
	let path = interp.resolve_path(b"/etc/hosts");
	interp.host().fs().read(path).unwrap_or_default()
}

/// Addresses for a host name: /etc/hosts first, then the system resolver (cancellable, off-thread).
fn resolve(interp: &mut Interp<'_>, host: &str) -> PResult<Vec<IpAddr>> {
	let mut found = Vec::new();
	for line in hosts_file(interp).split(|&b| b == b'\n') {
		let line = line.split(|&b| b == b'#').next().unwrap_or_default();
		let mut fields = line.split(|b| b.is_ascii_whitespace()).filter(|f| !f.is_empty());
		let Some(address) = fields.next() else { continue };
		if fields.any(|name| name.eq_ignore_ascii_case(host.as_bytes()))
			&& let Ok(ip) = String::from_utf8_lossy(address).parse::<IpAddr>() && !found.contains(&ip) { found.push(ip); }
	}
	if found.is_empty() && let Ok(addresses) = crate::perl::func::sys::resolve_host(interp, host)? {
		for address in addresses { if !found.contains(&address) { found.push(address); } }
	}
	Ok(found)
}

fn inet_aton(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let host = bytes_arg(interp, &args, 0, "inet_aton")?;
	let host = String::from_utf8_lossy(&host).into_owned();
	if let Some(ip) = parse_inet_aton(&host) { return one(packed(&ip.octets())); }
	let ip = resolve(interp, &host)?.into_iter().find_map(|ip| match ip { IpAddr::V4(v4) => Some(v4), IpAddr::V6(_) => None });
	one(ip.map_or(Value::Undef, |ip| packed(&ip.octets())))
}

fn inet_ntoa(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let bytes = bytes_arg(interp, &args, 0, "inet_ntoa")?;
	let octets: [u8; 4] = bytes.as_slice().try_into().map_err(|_| bad_length(interp, "inet_ntoa", bytes.len(), 4))?;
	one(Value::str(&Ipv4Addr::from(octets).to_string()))
}

fn inet_pton(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let af = arg(&args, 0).to_i64();
	let host = bytes_arg(interp, &args, 1, "inet_pton")?;
	let host = String::from_utf8_lossy(&host);
	let result = if af == i64::from(libc::AF_INET) { host.parse::<Ipv4Addr>().ok().map(|ip| ip.octets().to_vec()) }
		else if af == i64::from(libc::AF_INET6) { host.parse::<Ipv6Addr>().ok().map(|ip| ip.octets().to_vec()) }
		else { return Err(interp.die_msg(format!("Bad address family for Socket::inet_pton, got {af}, should be either AF_INET or AF_INET6"))); };
	one(result.map_or(Value::Undef, |bytes| packed(&bytes)))
}

fn inet_ntop(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let af = arg(&args, 0).to_i64();
	let bytes = bytes_arg(interp, &args, 1, "inet_ntop")?;
	let (name, want) = if af == i64::from(libc::AF_INET) { ("AF_INET", 4) } else if af == i64::from(libc::AF_INET6) { ("AF_INET6", 16) }
		else { return Err(interp.die_msg(format!("Bad address family for Socket::inet_ntop, got {af}, should be either AF_INET or AF_INET6"))); };
	if bytes.len() != want {
		return Err(interp.die_msg(format!("Bad address length for Socket::inet_ntop on {name}; got {}, should be {want}", bytes.len())));
	}
	let text = match <[u8; 16]>::try_from(bytes.as_slice()) {
		Ok(octets) => Ipv6Addr::from(octets).to_string(),
		Err(_) => Ipv4Addr::new(bytes[0], bytes[1], bytes[2], bytes[3]).to_string(),
	};
	one(Value::str(&text))
}

fn family_of(interp: &mut Interp<'_>, bytes: &[u8], function: &str, want: i32) -> PResult<()> {
	let family = sockaddr_family(bytes).unwrap_or(-1);
	if family == want { return Ok(()); }
	Err(interp.die_msg(format!("Bad address family for Socket::{function}, got {family}, should be {want}")))
}

fn family(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let bytes = bytes_arg(interp, &args, 0, "sockaddr_family")?;
	match sockaddr_family(&bytes) {
		Some(family) if bytes.len() >= 2 => one(Value::Int(i64::from(family))),
		_ => Err(interp.die_msg(format!("Bad arg length for Socket::sockaddr_family, length is {}, should be at least 2", bytes.len()))),
	}
}

fn port_arg(args: &[Sv], index: usize) -> u16 { arg(args, index).to_i64() as u16 }

fn pack_in(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let port = port_arg(&args, 0);
	let ip = bytes_arg(interp, &args, 1, "pack_sockaddr_in")?;
	let octets: [u8; 4] = ip.as_slice().try_into().map_err(|_| bad_length(interp, "pack_sockaddr_in", ip.len(), 4))?;
	one(packed(&pack_sockaddr(&SockAddr::from(SocketAddrV4::new(Ipv4Addr::from(octets), port)))))
}

fn unpack_in(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let bytes = bytes_arg(interp, &args, 0, "unpack_sockaddr_in")?;
	if bytes.len() != 16 { return Err(bad_length(interp, "unpack_sockaddr_in", bytes.len(), 16)); }
	family_of(interp, &bytes, "unpack_sockaddr_in", libc::AF_INET)?;
	let port = u16::from_be_bytes([bytes[2], bytes[3]]);
	let ip = packed(&bytes[4..8]);
	Ok(if cx == Cx::List { Ret::Many(vec![Value::Int(i64::from(port)), ip]) } else { Ret::One(ip) })
}

fn sockaddr_in(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	if args.len() == 6 && cx != Cx::List {
		interp.warn_category("deprecated", "6-ARG sockaddr_in call is deprecated");
		let quad: Vec<String> = args[2..].iter().map(|sv| sv.get().to_pstr().to_string_lossy().into_owned()).collect();
		let Some(ip) = parse_inet_aton(&quad.join(".")) else { return one(Value::Undef) };
		return one(packed(&pack_sockaddr(&SockAddr::from(SocketAddrV4::new(ip, port_arg(&args, 1))))));
	}
	if cx == Cx::List {
		if args.len() != 1 { return Err(interp.die_msg("usage:   (port,iaddr) = sockaddr_in(sin_sv)")); }
		return unpack_in(interp, args, cx);
	}
	if args.len() != 2 { return Err(interp.die_msg("usage:   sin_sv = sockaddr_in(port,iaddr))")); }
	pack_in(interp, args, cx)
}

fn pack_in6(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let port = port_arg(&args, 0);
	let ip = bytes_arg(interp, &args, 1, "pack_sockaddr_in6")?;
	let octets: [u8; 16] = ip.as_slice().try_into().map_err(|_| bad_length(interp, "pack_sockaddr_in6", ip.len(), 16))?;
	let scope = arg(&args, 2).to_u64() as u32;
	let flow = arg(&args, 3).to_u64() as u32;
	one(packed(&pack_sockaddr(&SockAddr::from(SocketAddrV6::new(Ipv6Addr::from(octets), port, flow, scope)))))
}

fn unpack_in6(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let bytes = bytes_arg(interp, &args, 0, "unpack_sockaddr_in6")?;
	if bytes.len() != 28 { return Err(bad_length(interp, "unpack_sockaddr_in6", bytes.len(), 28)); }
	family_of(interp, &bytes, "unpack_sockaddr_in6", libc::AF_INET6)?;
	let port = u16::from_be_bytes([bytes[2], bytes[3]]);
	let flow = u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
	let scope = u32::from_ne_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
	let ip = packed(&bytes[8..24]);
	Ok(if cx == Cx::List {
		Ret::Many(vec![Value::Int(i64::from(port)), ip, Value::Int(i64::from(scope)), Value::Int(i64::from(flow))])
	} else { Ret::One(ip) })
}

fn sockaddr_in6(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	if cx == Cx::List {
		if args.len() != 1 { return Err(interp.die_msg("usage:   (port,in6addr,scope_id,flowinfo) = sockaddr_in6(sin6_sv)")); }
		return unpack_in6(interp, args, cx);
	}
	if !(2..=4).contains(&args.len()) { return Err(interp.die_msg("usage:   sin6_sv = sockaddr_in6(port,in6addr,[scope_id,[flowinfo]])")); }
	pack_in6(interp, args, cx)
}

fn pack_un(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let path = bytes_arg(interp, &args, 0, "pack_sockaddr_un")?;
	let address = {
		use std::os::unix::ffi::OsStrExt as _;
		SockAddr::unix(std::ffi::OsStr::from_bytes(&path))
	};
	match address {
		Ok(address) => one(packed(&pack_sockaddr(&address))),
		Err(_) => Err(interp.die_msg(format!("Bad arg length for Socket::pack_sockaddr_un, length is {}, should be less than the sun_path size", path.len()))),
	}
}

fn unpack_un(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let bytes = bytes_arg(interp, &args, 0, "unpack_sockaddr_un")?;
	family_of(interp, &bytes, "unpack_sockaddr_un", libc::AF_UNIX)?;
	let path = bytes.get(2..).unwrap_or_default();
	// Linux abstract names start with NUL and run to the end of the address.
	let path = if cfg!(target_os = "linux") && path.first() == Some(&0) { path } else { path.split(|&b| b == 0).next().unwrap_or_default() };
	one(packed(path))
}

fn sockaddr_un(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	if cx == Cx::List {
		if args.len() != 1 { return Err(interp.die_msg("usage:   (filename) = sockaddr_un(sun_sv)")); }
		return unpack_un(interp, args, cx);
	}
	if args.len() != 1 { return Err(interp.die_msg("usage:   sun_sv = sockaddr_un(filename)")); }
	pack_un(interp, args, cx)
}

fn address4(interp: &mut Interp<'_>, args: &[Sv], index: usize, function: &str) -> PResult<[u8; 4]> {
	if args.get(index).is_none_or(|sv| sv.get().is_undef()) { return Ok(Ipv4Addr::UNSPECIFIED.octets()); }
	let bytes = bytes_arg(interp, args, index, function)?;
	bytes.as_slice().try_into().map_err(|_| bad_length(interp, function, bytes.len(), 4))
}

fn pack_ip_mreq(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let group = address4(interp, &args, 0, "pack_ip_mreq")?;
	let interface = address4(interp, &args, 1, "pack_ip_mreq")?;
	one(packed(&[group, interface].concat()))
}

fn unpack_ip_mreq(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let bytes = bytes_arg(interp, &args, 0, "unpack_ip_mreq")?;
	if bytes.len() != 8 { return Err(bad_length(interp, "unpack_ip_mreq", bytes.len(), 8)); }
	Ok(Ret::Many(vec![packed(&bytes[..4]), packed(&bytes[4..])]))
}

/// `struct ip_mreq_source` field order: Linux puts the interface before the source, BSDs after.
const SOURCE_BEFORE_INTERFACE: bool = !cfg!(target_os = "linux");

fn pack_ip_mreq_source(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let group = address4(interp, &args, 0, "pack_ip_mreq_source")?;
	let source = address4(interp, &args, 1, "pack_ip_mreq_source")?;
	let interface = address4(interp, &args, 2, "pack_ip_mreq_source")?;
	let fields = if SOURCE_BEFORE_INTERFACE { [group, source, interface] } else { [group, interface, source] };
	one(packed(&fields.concat()))
}

fn unpack_ip_mreq_source(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let bytes = bytes_arg(interp, &args, 0, "unpack_ip_mreq_source")?;
	if bytes.len() != 12 { return Err(bad_length(interp, "unpack_ip_mreq_source", bytes.len(), 12)); }
	let (second, third) = (packed(&bytes[4..8]), packed(&bytes[8..]));
	let (source, interface) = if SOURCE_BEFORE_INTERFACE { (second, third) } else { (third, second) };
	Ok(Ret::Many(vec![packed(&bytes[..4]), source, interface]))
}

fn pack_ipv6_mreq(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let group = bytes_arg(interp, &args, 0, "pack_ipv6_mreq")?;
	if group.len() != 16 { return Err(bad_length(interp, "pack_ipv6_mreq", group.len(), 16)); }
	let interface = arg(&args, 1).to_u64() as u32;
	one(packed(&[group.as_slice(), &interface.to_ne_bytes()].concat()))
}

fn unpack_ipv6_mreq(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let bytes = bytes_arg(interp, &args, 0, "unpack_ipv6_mreq")?;
	if bytes.len() != 20 { return Err(bad_length(interp, "unpack_ipv6_mreq", bytes.len(), 20)); }
	let interface = u32::from_ne_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
	Ok(Ret::Many(vec![packed(&bytes[..16]), Value::Int(i64::from(interface))]))
}

/// getaddrinfo/getnameinfo status: the EAI code with its message, "" (0) on success.
fn gai_status(code: i32, message: &str) -> Value {
	if code == 0 { return Value::Dual(std::rc::Rc::new(Dual { num: Num::Int(0), str: PStr::default() })); }
	Value::Dual(std::rc::Rc::new(Dual { num: Num::Int(i64::from(code)), str: PStr::from_str(message) }))
}

fn services_file(interp: &mut Interp<'_>) -> Vec<u8> {
	let path = interp.resolve_path(b"/etc/services");
	interp.host().fs().read(path).unwrap_or_default()
}

/// (name, port, protocol) entries of the services database.
fn services(interp: &mut Interp<'_>) -> Vec<(Vec<u8>, u16, Vec<u8>, Vec<Vec<u8>>)> {
	services_file(interp).split(|&b| b == b'\n').filter_map(|line| {
		let line = line.split(|&b| b == b'#').next().unwrap_or_default();
		let mut fields = line.split(|b| b.is_ascii_whitespace()).filter(|f| !f.is_empty());
		let name = fields.next()?.to_vec();
		let (port, protocol) = String::from_utf8_lossy(fields.next()?).split_once('/').map(|(p, proto)| (p.to_owned(), proto.to_owned()))?;
		Some((name, port.parse().ok()?, protocol.into_bytes(), fields.map(<[u8]>::to_vec).collect()))
	}).collect()
}

fn hint(interp: &mut Interp<'_>, hints: Option<&crate::perl::value::Hv>, name: &str) -> PResult<i64> {
	let Some(hints) = hints else { return Ok(0) };
	let slot = hints.entries().get(&HKey::new(&PStr::from_str(name))).cloned();
	Ok(match slot { Some(sv) => interp.read_sv(&sv)?.to_i64(), None => 0 })
}

fn getaddrinfo(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if args.len() > 3 { return Err(interp.die_msg("Usage: Socket::getaddrinfo(host, service, hints)")); }
	let host_value = arg(&args, 0);
	let host = if host_value.is_undef() { String::new() } else { String::from_utf8_lossy(&bytes_arg(interp, &args, 0, "getaddrinfo")?).into_owned() };
	let service_value = arg(&args, 1);
	let service = if service_value.is_undef() { String::new() } else { String::from_utf8_lossy(&bytes_arg(interp, &args, 1, "getaddrinfo")?).into_owned() };
	let hints = match arg(&args, 2) { Value::Ref(Ref::Hash(hv)) => Some(hv), _ => None };
	let flags = hint(interp, hints.as_ref(), "flags")?;
	let family = hint(interp, hints.as_ref(), "family")?;
	let socktype = hint(interp, hints.as_ref(), "socktype")?;
	let protocol = hint(interp, hints.as_ref(), "protocol")?;
	let fail = |code: i32, message: &str| -> PResult<Ret> { Ok(Ret::Many(vec![gai_status(code, message)])) };
	if host.is_empty() && service.is_empty() { return fail(libc::EAI_NONAME, "nodename nor servname provided, or not known"); }
	let port = if service.is_empty() { 0 } else if let Ok(port) = service.parse::<u16>() { port }
		else if flags & i64::from(libc::AI_NUMERICSERV) != 0 { return fail(libc::EAI_NONAME, "nodename nor servname provided, or not known"); }
		else {
			let wanted: &[u8] = if socktype == i64::from(libc::SOCK_DGRAM) { b"udp" } else { b"tcp" };
			match services(interp).into_iter().find(|(name, _, proto, aliases)| (name == service.as_bytes() || aliases.iter().any(|a| a == service.as_bytes())) && proto == wanted) {
				Some((_, port, _, _)) => port,
				None => return fail(libc::EAI_SERVICE, "servname not supported for ai_socktype"),
			}
		};
	let addresses: Vec<IpAddr> = if host.is_empty() {
		let passive = flags & i64::from(libc::AI_PASSIVE) != 0;
		vec![if passive { IpAddr::V6(Ipv6Addr::UNSPECIFIED) } else { IpAddr::V6(Ipv6Addr::LOCALHOST) },
			if passive { IpAddr::V4(Ipv4Addr::UNSPECIFIED) } else { IpAddr::V4(Ipv4Addr::LOCALHOST) }]
	} else if let Ok(ip) = host.parse::<IpAddr>() { vec![ip] }
	else if flags & i64::from(libc::AI_NUMERICHOST) != 0 { return fail(libc::EAI_NONAME, "nodename nor servname provided, or not known"); }
	else { resolve(interp, &host)? };
	let addresses: Vec<IpAddr> = addresses.into_iter().filter(|ip| match ip {
		IpAddr::V4(_) => family == 0 || family == i64::from(libc::AF_INET),
		IpAddr::V6(_) => family == 0 || family == i64::from(libc::AF_INET6),
	}).collect();
	if addresses.is_empty() { return fail(libc::EAI_NONAME, "nodename nor servname provided, or not known"); }
	let kinds: Vec<(i64, i64)> = if socktype != 0 {
		vec![(socktype, if protocol != 0 { protocol } else if socktype == i64::from(libc::SOCK_DGRAM) { i64::from(libc::IPPROTO_UDP) } else if socktype == i64::from(libc::SOCK_STREAM) { i64::from(libc::IPPROTO_TCP) } else { 0 })]
	} else {
		vec![(i64::from(libc::SOCK_STREAM), i64::from(libc::IPPROTO_TCP)), (i64::from(libc::SOCK_DGRAM), i64::from(libc::IPPROTO_UDP))]
	};
	let canonical = (flags & i64::from(libc::AI_CANONNAME) != 0 && !host.is_empty()).then(|| host.clone());
	let mut out = vec![gai_status(0, "")];
	for (index, ip) in addresses.iter().enumerate() {
		for (kind_index, &(kind, proto)) in kinds.iter().enumerate() {
			let (af, address) = match *ip {
				IpAddr::V4(v4) => (libc::AF_INET, SockAddr::from(SocketAddrV4::new(v4, port))),
				IpAddr::V6(v6) => (libc::AF_INET6, SockAddr::from(SocketAddrV6::new(v6, port, 0, 0))),
			};
			let entry = new_hv();
			{
				let mut map = entry.entries_mut();
				let first = index == 0 && kind_index == 0;
				for (name, value) in [
					("family", Value::Int(i64::from(af))), ("socktype", Value::Int(kind)), ("protocol", Value::Int(proto)),
					("addr", packed(&pack_sockaddr(&address))),
					("canonname", canonical.as_ref().filter(|_| first).map_or(Value::Undef, |name| Value::str(name))),
				] { map.insert(HKey::new(&PStr::from_str(name)), new_sv(value)); }
			}
			out.push(Value::Ref(Ref::Hash(entry)));
		}
	}
	Ok(Ret::Many(out))
}

fn getnameinfo(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if args.is_empty() || args.len() > 3 { return Err(interp.die_msg("Usage: Socket::getnameinfo(addr, flags=0, xflags=0)")); }
	let bytes = bytes_arg(interp, &args, 0, "getnameinfo")?;
	let flags = arg(&args, 1).to_i64();
	let xflags = arg(&args, 2).to_i64();
	let fail = |code: i32, message: &str| -> PResult<Ret> { Ok(Ret::Many(vec![gai_status(code, message)])) };
	let (ip, port) = match sockaddr_family(&bytes) {
		Some(libc::AF_INET) if bytes.len() >= 8 => (IpAddr::V4(Ipv4Addr::new(bytes[4], bytes[5], bytes[6], bytes[7])), u16::from_be_bytes([bytes[2], bytes[3]])),
		Some(libc::AF_INET6) if bytes.len() >= 24 => {
			let octets: [u8; 16] = bytes[8..24].try_into().unwrap_or_default();
			(IpAddr::V6(Ipv6Addr::from(octets)), u16::from_be_bytes([bytes[2], bytes[3]]))
		},
		_ => return fail(libc::EAI_FAMILY, "ai_family not supported"),
	};
	let host = if xflags & 1 != 0 { Value::Undef } else {
		let numeric = ip.to_string();
		let named = (flags & i64::from(libc::NI_NUMERICHOST) == 0).then(|| {
			hosts_file(interp).split(|&b| b == b'\n').find_map(|line| {
				let line = line.split(|&b| b == b'#').next().unwrap_or_default();
				let mut fields = line.split(|b| b.is_ascii_whitespace()).filter(|f| !f.is_empty());
				let address = String::from_utf8_lossy(fields.next()?).parse::<IpAddr>().ok()?;
				(address == ip).then(|| fields.next().map(<[u8]>::to_vec)).flatten()
			})
		}).flatten();
		match named {
			Some(name) => packed(&name),
			None if flags & i64::from(libc::NI_NAMEREQD) != 0 => return fail(libc::EAI_NONAME, "nodename nor servname provided, or not known"),
			None => Value::str(&numeric),
		}
	};
	let service = if xflags & 2 != 0 { Value::Undef } else {
		let wanted: &[u8] = if flags & i64::from(libc::NI_DGRAM) != 0 { b"udp" } else { b"tcp" };
		let named = (flags & i64::from(libc::NI_NUMERICSERV) == 0)
			.then(|| services(interp).into_iter().find(|(_, p, proto, _)| *p == port && proto == wanted).map(|(name, ..)| name)).flatten();
		named.map_or_else(|| Value::str(&port.to_string()), |name| packed(&name))
	};
	Ok(Ret::Many(vec![gai_status(0, ""), host, service]))
}
