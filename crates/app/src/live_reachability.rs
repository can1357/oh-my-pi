//! Bounded, redacted reachability diagnosis for native live voice.
//!
//! Probes are deliberately small and carry no provider credentials, request
//! bodies, addresses, interface names, or proxy URLs into their result. The
//! result is presentation-safe and exists only to help the user recover.

use std::{net::SocketAddr, time::Duration};

use omp_ai::realtime::{live::LiveIcePath, transport::LiveProxy};
use omp_core::{Str, sf};
use smallvec::SmallVec;
use strum::IntoStaticStr;
use tokio::{
	net::{TcpStream, UdpSocket, lookup_host},
	task::JoinSet,
	time,
};
use url::Url;

const DNS_TIMEOUT: Duration = Duration::from_millis(750);
const TCP_TIMEOUT: Duration = Duration::from_millis(900);
const TLS_TIMEOUT: Duration = Duration::from_millis(1_500);
const UDP_TIMEOUT: Duration = Duration::from_millis(500);
const MAX_TCP_CANDIDATES: usize = 4;

/// Stable failure categories shown by the live controller.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "kebab-case")]
pub(crate) enum LiveFailureClass {
	Authentication,
	Configuration,
	Dns,
	Ice,
	Media,
	Permission,
	Protocol,
	Proxy,
	Service,
	Sideband,
	Tcp,
	Timeout,
	Tls,
	Udp,
	#[strum(to_string = "webrtc")]
	WebRtc,
}

impl LiveFailureClass {
	pub(crate) const fn automatic_retry(self) -> bool {
		matches!(
			self,
			Self::Dns
				| Self::Ice
				| Self::Media
				| Self::Service
				| Self::Sideband
				| Self::Tcp
				| Self::Timeout
				| Self::Tls
				| Self::Udp
				| Self::WebRtc
		)
	}

	pub(crate) const fn user_recoverable(self) -> bool {
		!matches!(self, Self::Authentication | Self::Configuration | Self::Protocol)
	}

	const fn probes_network(self) -> bool {
		matches!(
			self,
			Self::Dns
				| Self::Ice
				| Self::Proxy
				| Self::Sideband
				| Self::Tcp
				| Self::Timeout
				| Self::Tls
				| Self::Udp
				| Self::WebRtc
		)
	}
}

#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase")]
enum ProbeStatus {
	Passed,
	Failed,
	#[strum(to_string = "timed out")]
	TimedOut,
	Skipped,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ProbeEvidence {
	dns: ProbeStatus,
	tcp: ProbeStatus,
	tls: ProbeStatus,
	udp: ProbeStatus,
}

impl Default for ProbeEvidence {
	fn default() -> Self {
		Self {
			dns: ProbeStatus::Skipped,
			tcp: ProbeStatus::Skipped,
			tls: ProbeStatus::Skipped,
			udp: ProbeStatus::Skipped,
		}
	}
}

/// Presentation-safe diagnosis produced after a live transport failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LiveReachabilityDiagnostic {
	pub(crate) class:   LiveFailureClass,
	pub(crate) message: Str,
}

/// Adds the last selected ICE candidate classes and relay/direct aggregate.
///
/// The typed path cannot contain endpoint or credential material, so this
/// diagnostic remains safe for the live overlay and diagnostic bundles.
pub(crate) fn annotate_ice_path(
	mut diagnostic: LiveReachabilityDiagnostic,
	path: Option<LiveIcePath>,
) -> LiveReachabilityDiagnostic {
	let Some(path) = path else {
		return diagnostic;
	};
	diagnostic.message = Str::new(format!(
		"{} Last ICE path: {}; local {}; remote {}.",
		diagnostic.message, path.kind, path.local, path.remote
	));
	diagnostic
}

/// Runs a bounded DNS/TCP/TLS/UDP diagnosis without provider credentials.
///
/// At most four resolved addresses are dialed. DNS, TCP, TLS, and UDP each
/// have an independent short deadline. The returned message contains only
/// categorical outcomes and recovery instructions.
pub(crate) async fn diagnose_live_failure(
	destination: &Url,
	proxy: Option<&LiveProxy>,
	observed: LiveFailureClass,
) -> LiveReachabilityDiagnostic {
	if !observed.probes_network() {
		return diagnosis(observed, ProbeEvidence::default(), proxy.is_some());
	}

	let route = proxy.map_or(destination, LiveProxy::endpoint);
	let Some(host) = route.host_str() else {
		return diagnosis(LiveFailureClass::Configuration, ProbeEvidence::default(), proxy.is_some());
	};
	let port = route.port_or_known_default().unwrap_or(443);
	let mut evidence = ProbeEvidence::default();
	let addresses = match resolve_addresses(host, port).await {
		Ok(addresses) => {
			evidence.dns = ProbeStatus::Passed;
			addresses
		},
		Err(status) => {
			evidence.dns = status;
			return diagnosis(LiveFailureClass::Dns, evidence, proxy.is_some());
		},
	};

	evidence.tcp = probe_tcp(&addresses).await;
	if evidence.tcp != ProbeStatus::Passed {
		let class = if proxy.is_some() {
			LiveFailureClass::Proxy
		} else {
			LiveFailureClass::Tcp
		};
		return diagnosis(class, evidence, proxy.is_some());
	}

	evidence.tls = probe_tls(destination, proxy).await;
	if evidence.tls != ProbeStatus::Passed {
		let class = if proxy.is_some() && observed != LiveFailureClass::Tls {
			LiveFailureClass::Proxy
		} else {
			LiveFailureClass::Tls
		};
		return diagnosis(class, evidence, proxy.is_some());
	}

	if matches!(observed, LiveFailureClass::Ice | LiveFailureClass::Udp | LiveFailureClass::WebRtc) {
		let udp_addresses = if proxy.is_some() {
			let Some(host) = destination.host_str() else {
				return diagnosis(LiveFailureClass::Configuration, evidence, true);
			};
			match resolve_addresses(host, destination.port_or_known_default().unwrap_or(443)).await {
				Ok(addresses) => addresses,
				Err(_) => {
					evidence.udp = ProbeStatus::Failed;
					return diagnosis(LiveFailureClass::Udp, evidence, true);
				},
			}
		} else {
			addresses.clone()
		};
		evidence.udp = probe_udp(&udp_addresses).await;
		if evidence.udp != ProbeStatus::Passed {
			return diagnosis(LiveFailureClass::Udp, evidence, proxy.is_some());
		}
	}

	diagnosis(observed, evidence, proxy.is_some())
}

async fn resolve_addresses(
	host: &str,
	port: u16,
) -> Result<SmallVec<SocketAddr, MAX_TCP_CANDIDATES>, ProbeStatus> {
	match time::timeout(DNS_TIMEOUT, lookup_host((host, port))).await {
		Ok(Ok(addresses)) => {
			let addresses = addresses
				.take(MAX_TCP_CANDIDATES)
				.collect::<SmallVec<_, MAX_TCP_CANDIDATES>>();
			if addresses.is_empty() {
				Err(ProbeStatus::Failed)
			} else {
				Ok(addresses)
			}
		},
		Ok(Err(_)) => Err(ProbeStatus::Failed),
		Err(_) => Err(ProbeStatus::TimedOut),
	}
}

async fn probe_tcp(addresses: &[SocketAddr]) -> ProbeStatus {
	let mut attempts = JoinSet::new();
	for address in addresses.iter().copied() {
		attempts.spawn(async move { TcpStream::connect(address).await.is_ok() });
	}
	match time::timeout(TCP_TIMEOUT, async {
		while let Some(result) = attempts.join_next().await {
			if matches!(result, Ok(true)) {
				attempts.abort_all();
				return true;
			}
		}
		false
	})
	.await
	{
		Ok(true) => ProbeStatus::Passed,
		Ok(false) => ProbeStatus::Failed,
		Err(_) => {
			attempts.abort_all();
			ProbeStatus::TimedOut
		},
	}
}

async fn probe_tls(destination: &Url, proxy: Option<&LiveProxy>) -> ProbeStatus {
	let mut builder = reqwest::Client::builder()
		.no_proxy()
		.redirect(reqwest::redirect::Policy::none())
		.connect_timeout(TCP_TIMEOUT)
		.timeout(TLS_TIMEOUT);
	if let Some(proxy) = proxy {
		let Ok(mut configured) = reqwest::Proxy::all(proxy.endpoint().as_str()) else {
			return ProbeStatus::Failed;
		};
		if let Some(authorization) = proxy.authorization() {
			configured = configured.custom_http_auth(authorization.clone());
		}
		builder = builder.proxy(configured);
	}
	let Ok(client) = builder.build() else {
		return ProbeStatus::Failed;
	};
	match time::timeout(TLS_TIMEOUT, client.head(destination.clone()).send()).await {
		Ok(Ok(_)) => ProbeStatus::Passed,
		Ok(Err(error)) if error.is_timeout() => ProbeStatus::TimedOut,
		Ok(Err(_)) => ProbeStatus::Failed,
		Err(_) => ProbeStatus::TimedOut,
	}
}

async fn probe_udp(addresses: &[SocketAddr]) -> ProbeStatus {
	if addresses.is_empty() {
		return ProbeStatus::Skipped;
	}
	match time::timeout(UDP_TIMEOUT, async {
		for address in addresses.iter().copied() {
			let bind = if address.is_ipv6() {
				"[::]:0"
			} else {
				"0.0.0.0:0"
			};
			let Ok(socket) = UdpSocket::bind(bind).await else {
				continue;
			};
			if socket.connect(address).await.is_ok() && socket.send(&[0]).await.is_ok() {
				return true;
			}
		}
		false
	})
	.await
	{
		Ok(true) => ProbeStatus::Passed,
		Ok(false) => ProbeStatus::Failed,
		Err(_) => ProbeStatus::TimedOut,
	}
}

fn diagnosis(
	class: LiveFailureClass,
	evidence: ProbeEvidence,
	using_proxy: bool,
) -> LiveReachabilityDiagnostic {
	let action = match class {
		LiveFailureClass::Authentication => "Sign in again, then reconnect live voice.",
		LiveFailureClass::Configuration => {
			"Correct the live voice or proxy configuration, then reconnect."
		},
		LiveFailureClass::Dns => {
			if using_proxy {
				"The configured proxy name could not be resolved. Check DNS, VPN, and proxy settings, \
				 then reconnect."
			} else {
				"The live service name could not be resolved. Check DNS or VPN settings, then \
				 reconnect."
			}
		},
		LiveFailureClass::Tcp => {
			"A TCP connection could not be opened. Check the firewall, VPN, and network connection, \
			 then reconnect."
		},
		LiveFailureClass::Tls => {
			"Secure TLS negotiation failed. Check the system clock, trust store, VPN, or TLS \
			 inspection policy, then reconnect."
		},
		LiveFailureClass::Proxy => {
			"The configured proxy path failed. Check proxy reachability, credentials, and \
			 CONNECT/WebSocket policy, then reconnect."
		},
		LiveFailureClass::Udp => {
			"UDP appears unavailable. Allow outbound UDP/WebRTC traffic or change networks, then \
			 reconnect."
		},
		LiveFailureClass::Ice => {
			"WebRTC ICE could not establish a media path. Allow STUN/UDP traffic or change networks, \
			 then reconnect."
		},
		LiveFailureClass::WebRtc => {
			"The WebRTC peer failed after basic reachability passed. Check VPN or media firewall \
			 policy, then reconnect."
		},
		LiveFailureClass::Sideband => {
			"The authenticated sideband was interrupted. Allow secure WebSocket traffic through the \
			 firewall or proxy, then reconnect."
		},
		LiveFailureClass::Timeout => {
			"The live connection timed out. Check network, VPN, or proxy stability, then reconnect."
		},
		LiveFailureClass::Service => {
			"The live service is temporarily unavailable. Wait briefly, then reconnect."
		},
		LiveFailureClass::Media => {
			"The local audio path failed. Check the selected microphone and speaker, then reconnect."
		},
		LiveFailureClass::Permission => {
			"Grant microphone permission in system settings, then reconnect."
		},
		LiveFailureClass::Protocol => {
			"The live service returned an incompatible response. Update omp before reconnecting."
		},
	};
	let message = if evidence == ProbeEvidence::default() {
		sf!(action)
	} else {
		Str::new(format!(
			"{action} Probe results: DNS {}; TCP {}; TLS {}; UDP {}.",
			<&'static str>::from(evidence.dns),
			<&'static str>::from(evidence.tcp),
			<&'static str>::from(evidence.tls),
			<&'static str>::from(evidence.udp),
		))
	};
	LiveReachabilityDiagnostic { class, message }
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn redacted_diagnostics_are_actionable_and_carry_no_route_values() {
		let evidence = ProbeEvidence {
			dns: ProbeStatus::Passed,
			tcp: ProbeStatus::Passed,
			tls: ProbeStatus::Failed,
			udp: ProbeStatus::Skipped,
		};
		let report = diagnosis(LiveFailureClass::Tls, evidence, true);
		assert_eq!(report.class, LiveFailureClass::Tls);
		assert!(report.message.contains("TLS"));
		assert!(report.message.contains("reconnect"));
		assert!(!report.message.contains("employee"));
		assert!(!report.message.contains("secret"));
		assert!(!report.message.contains("proxy.example"));
	}

	#[test]
	fn selected_ice_path_annotation_contains_only_redacted_classes_and_aggregate() {
		use omp_ai::realtime::live::{LiveIceCandidateClass, LiveIcePathKind};

		let report = annotate_ice_path(
			diagnosis(LiveFailureClass::Ice, ProbeEvidence::default(), false),
			Some(LiveIcePath {
				local:  LiveIceCandidateClass::Relay,
				remote: LiveIceCandidateClass::Host,
				kind:   LiveIcePathKind::Relay,
			}),
		);
		assert!(report.message.contains("Last ICE path: relay"));
		assert!(report.message.contains("local relay"));
		assert!(report.message.contains("remote host"));
		for sensitive in ["192.0.2.", "10.0.0.", ":3478", "credential", "password", "ssid"] {
			assert!(!report.message.to_ascii_lowercase().contains(sensitive));
		}
	}

	#[test]
	fn retryable_transport_failures_and_manual_proxy_recovery_are_explicit() {
		for class in [
			LiveFailureClass::Dns,
			LiveFailureClass::Tcp,
			LiveFailureClass::Tls,
			LiveFailureClass::Udp,
			LiveFailureClass::Ice,
			LiveFailureClass::WebRtc,
			LiveFailureClass::Sideband,
		] {
			assert!(class.automatic_retry(), "{class:?}");
			assert!(class.user_recoverable(), "{class:?}");
		}
		assert!(LiveFailureClass::Proxy.user_recoverable());
		assert!(!LiveFailureClass::Proxy.automatic_retry());
	}
}
