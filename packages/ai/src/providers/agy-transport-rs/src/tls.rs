//! Convert measured ClientHello structure into fork configuration, never replay
//! random/session/key bytes. Unsupported structures fail rather than falling
//! back to a generic browser profile. Advertising an id does NOT prove that
//! the TLS fork can negotiate it; production cutover requires the Go TLS suite.
use wreq::tls::{AlpnProtocol, ExtensionType, KeyShare, TlsOptions, TlsVersion};

use crate::Result;

struct Cursor<'a>(&'a [u8]);
impl<'a> Cursor<'a> {
	fn take(&mut self, count: usize) -> Result<&'a [u8]> {
		if count > self.0.len() {
			return Err("truncated reference ClientHello".into());
		}
		let (value, rest) = self.0.split_at(count);
		self.0 = rest;
		Ok(value)
	}

	fn byte(&mut self) -> Result<u8> {
		Ok(self.take(1)?[0])
	}

	fn word(&mut self) -> Result<u16> {
		let bytes = self.take(2)?;
		Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
	}

	fn vector8(&mut self) -> Result<&'a [u8]> {
		let length = self.byte()? as usize;
		self.take(length)
	}

	fn vector16(&mut self) -> Result<&'a [u8]> {
		let length = self.word()? as usize;
		self.take(length)
	}

	fn finish(self) -> Result<()> {
		if self.0.is_empty() {
			Ok(())
		} else {
			Err("unexpected bytes in reference ClientHello".into())
		}
	}
}
fn words(bytes: &[u8]) -> Result<Vec<u16>> {
	if bytes.is_empty() || bytes.len() % 2 != 0 {
		return Err("invalid empty or odd TLS vector".into());
	}
	Ok(bytes
		.chunks_exact(2)
		.map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
		.collect())
}
fn word_vector(bytes: &[u8]) -> Result<Vec<u16>> {
	let mut cursor = Cursor(bytes);
	let values = words(cursor.vector16()?)?;
	cursor.finish()?;
	Ok(values)
}
fn expected(actual: &[u8], expected: &[u8], name: &str) -> Result<()> {
	if actual == expected {
		Ok(())
	} else {
		Err(format!("unsupported reference {name}").into())
	}
}

pub fn options(reference: &[u8]) -> Result<TlsOptions> {
	let mut record = Cursor(reference);
	if record.byte()? != 22 {
		return Err("reference is not a TLS handshake record".into());
	}
	let version = record.word()?;
	if !matches!(version, 0x0301..=0x0303) {
		return Err("unsupported reference TLS record version".into());
	}
	let mut handshake = Cursor(record.vector16()?);
	record.finish()?;
	if handshake.byte()? != 1 {
		return Err("reference is not a ClientHello".into());
	}
	let length = handshake.take(3)?;
	let length = ((length[0] as usize) << 16) | ((length[1] as usize) << 8) | length[2] as usize;
	let mut hello = Cursor(handshake.take(length)?);
	handshake.finish()?;
	if hello.word()? != 0x0303 {
		return Err("reference must use TLS 1.2 legacy ClientHello version".into());
	}
	hello.take(32)?;
	if hello.vector8()?.len() != 32 {
		return Err("unsupported reference session ID length".into());
	}
	let cipher_ids = words(hello.vector16()?)?;
	let tls13_last = cipher_ids
		.first()
		.is_some_and(|id| !matches!(id, 0x1301..=0x1303));
	let mut changed = false;
	let first_tls13 = !tls13_last;
	for id in &cipher_ids {
		if matches!(id, 0x1301..=0x1303) != first_tls13 {
			changed = true;
		} else if changed {
			return Err("unsupported interleaved TLS 1.2/1.3 cipher suites".into());
		}
	}
	let ciphers: Vec<_> = cipher_ids
		.into_iter()
		.map(cipher_name)
		.collect::<Result<_>>()?;
	expected(hello.vector8()?, &[0], "compression methods")?;
	let mut extension_data = Cursor(hello.vector16()?);
	hello.finish()?;
	let mut order = Vec::new();
	let mut groups = None;
	let mut signatures = None;
	let mut certificate_signatures = None;
	let mut key_shares = None;
	let mut alpn = false;
	while !extension_data.0.is_empty() {
		let id = extension_data.word()?;
		if order.contains(&id) {
			return Err("duplicate reference TLS extension".into());
		}
		order.push(id);
		let bytes = extension_data.vector16()?;
		match id {
			0 => {
				let mut names = Cursor(bytes);
				let mut name = Cursor(names.vector16()?);
				names.finish()?;
				if name.byte()? != 0 || name.vector16()?.is_empty() {
					return Err("invalid reference SNI".into());
				}
				name.finish()?;
			},
			11 => expected(bytes, &[1, 0], "point formats")?,
			0xff01 => expected(bytes, &[0], "renegotiation info")?,
			23 | 18 => expected(bytes, &[], "empty TLS extension")?,
			5 => expected(bytes, &[1, 0, 0, 0, 0], "OCSP status request")?,
			10 => groups = Some(word_vector(bytes)?),
			13 => signatures = Some(word_vector(bytes)?),
			50 => certificate_signatures = Some(word_vector(bytes)?),
			16 => {
				let mut protocols = Cursor(bytes);
				expected(
					protocols.vector16()?,
					b"\x08http/1.1",
					"ALPN: reference must advertise exactly http/1.1, not the AGY updater HTTP/2 \
					 profile",
				)?;
				protocols.finish()?;
				alpn = true;
			},
			43 => expected(bytes, &[4, 3, 4, 3, 3], "supported TLS versions")?,
			51 => {
				let mut vector = Cursor(bytes);
				let mut shares = Cursor(vector.vector16()?);
				vector.finish()?;
				let mut configured = Vec::new();
				let mut seen = Vec::new();
				while !shares.0.is_empty() {
					let group = shares.word()?;
					if seen.contains(&group) {
						return Err("duplicate reference key share".into());
					}
					seen.push(group);
					let public_key = shares.vector16()?;
					let (share, length) = match group {
						0x11ec => (KeyShare::X25519_MLKEM768, 1216),
						0x001d => (KeyShare::X25519, 32),
						0x0017 => (KeyShare::P256, 65),
						0x0018 => (KeyShare::P384, 97),
						0x0019 => (KeyShare::P521, 133),
						_ => {
							return Err(
								format!("unsupported reference initial key share 0x{group:04x}").into(),
							);
						},
					};
					if public_key.len() != length {
						return Err("invalid reference public key share length".into());
					}
					configured.push(share);
				}
				if configured.is_empty() {
					return Err("reference contains no initial key shares".into());
				}
				key_shares = Some(configured);
			},
			_ => return Err(format!("unsupported reference TLS extension 0x{id:04x}").into()),
		}
	}
	if !alpn {
		return Err(
			"reference must advertise exactly http/1.1, not the AGY updater HTTP/2 profile".into(),
		);
	}
	for required in [0, 11, 0xff01, 23, 43] {
		if !order.contains(&required) {
			return Err(
				format!("unsupported reference missing TLS extension 0x{required:04x}").into(),
			);
		}
	}
	let ocsp = order.contains(&5);
	let sct = order.contains(&18);
	let mut builder = TlsOptions::builder()
		.alpn_protocols(vec![AlpnProtocol::HTTP1])
		.grease_enabled(false)
		.permute_extensions(false)
		.session_ticket(false)
		.psk_dhe_ke(false)
		.enable_ocsp_stapling(ocsp)
		.enable_signed_cert_timestamps(sct)
		.renegotiation(true)
		.min_tls_version(TlsVersion::TLS_1_2)
		.max_tls_version(TlsVersion::TLS_1_3)
		.preserve_tls13_cipher_list(true)
		.tls13_ciphers_last(tls13_last)
		.cipher_list(ciphers.join(":"))
		.key_shares(key_shares.ok_or("reference lacks key shares")?)
		.group_ids(groups.ok_or("reference lacks supported groups")?)
		.sigalgs(signatures.ok_or("reference lacks signature algorithms")?)
		.extension_permutation(
			order
				.into_iter()
				.map(ExtensionType::from)
				.collect::<Vec<_>>(),
		);
	if let Some(signatures) = certificate_signatures {
		builder = builder.cert_sigalgs(signatures);
	}
	Ok(builder.build())
}

fn cipher_name(id: u16) -> Result<&'static str> {
	Ok(match id {
		0xc02b => "ECDHE-ECDSA-AES128-GCM-SHA256",
		0xc02f => "ECDHE-RSA-AES128-GCM-SHA256",
		0xc02c => "ECDHE-ECDSA-AES256-GCM-SHA384",
		0xc030 => "ECDHE-RSA-AES256-GCM-SHA384",
		0xcca9 => "ECDHE-ECDSA-CHACHA20-POLY1305",
		0xcca8 => "ECDHE-RSA-CHACHA20-POLY1305",
		0xc009 => "ECDHE-ECDSA-AES128-SHA",
		0xc013 => "ECDHE-RSA-AES128-SHA",
		0xc00a => "ECDHE-ECDSA-AES256-SHA",
		0xc014 => "ECDHE-RSA-AES256-SHA",
		0x1301 => "TLS_AES_128_GCM_SHA256",
		0x1302 => "TLS_AES_256_GCM_SHA384",
		0x1303 => "TLS_CHACHA20_POLY1305_SHA256",
		_ => return Err(format!("unsupported reference cipher suite 0x{id:04x}").into()),
	})
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn embedded_reference_is_parsed_without_replaying_key_material() {
		let options = options(crate::CLIENT_HELLO).unwrap();
		assert_eq!(options.group_ids.as_deref().unwrap(), &[
			0x11ec, 0x11eb, 0x11ed, 0x001d, 0x0017, 0x0018, 0x0019
		]);
		assert_eq!(options.key_shares.as_deref().unwrap(), &[
			KeyShare::X25519_MLKEM768,
			KeyShare::X25519
		]);
		assert_eq!(options.extension_permutation.as_deref().unwrap().len(), 12);
	}
	#[test]
	fn truncated_records_never_fall_back_to_defaults() {
		for length in [0, 1, 5, 10, 100, crate::CLIENT_HELLO.len() - 1] {
			assert!(options(&crate::CLIENT_HELLO[..length]).is_err());
		}
		let mut trailing = crate::CLIENT_HELLO.to_vec();
		trailing.push(0);
		assert!(options(&trailing).is_err());
	}
}
