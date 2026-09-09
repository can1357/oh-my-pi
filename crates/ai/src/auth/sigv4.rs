//! AWS Signature Version 4 over finalized request bytes.

use std::{
	collections::BTreeMap,
	fmt,
	time::{SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use http::{
	HeaderValue, Request,
	header::{AUTHORIZATION, HOST, HeaderName},
};
use omp_core::{ExposeSecret, SecretString, hex};
use ring::hmac;
use sha2::{Digest as _, Sha256};
use zeroize::{Zeroize, Zeroizing};

use super::spec::SigV4Spec;

/// Sealed AWS access material accepted only by a credential lease.
pub(crate) struct AwsCredential {
	pub(crate) access_key_id:     SecretString,
	pub(crate) secret_access_key: SecretString,
	pub(crate) session_token:     Option<SecretString>,
}

impl AwsCredential {
	pub(crate) const fn new(
		access_key_id: SecretString,
		secret_access_key: SecretString,
		session_token: Option<SecretString>,
	) -> Self {
		Self { access_key_id, secret_access_key, session_token }
	}
}

impl Clone for AwsCredential {
	fn clone(&self) -> Self {
		Self {
			access_key_id:     self.access_key_id.clone(),
			secret_access_key: self.secret_access_key.clone(),
			session_token:     self.session_token.clone(),
		}
	}
}

impl fmt::Debug for AwsCredential {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str("AwsCredential([REDACTED])")
	}
}

/// Failure while signing a finalized request.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SigV4Error {
	/// The injectable signing time predates the Unix epoch or cannot be
	/// represented.
	#[error("SigV4 signing time is invalid")]
	InvalidTime,
	/// Neither the URI nor request headers identify a host.
	#[error("SigV4 request has no host")]
	MissingHost,
	/// A request header value cannot be represented canonically.
	#[error("SigV4 request contains a non-canonical header value")]
	InvalidHeaderValue,
	/// A query component is not valid `decodeURIComponent` input.
	#[error("SigV4 request query contains invalid percent-encoded UTF-8")]
	InvalidQueryEncoding,
	/// The catalog signing specification is structurally incomplete.
	#[error("SigV4 signing specification is incomplete")]
	InvalidSpec,
}

/// Infers the signing service and region from a regional AWS endpoint.
///
/// Catalog data remains the fallback for custom endpoints. Standard regional
/// endpoints override it because the credential scope must match the actual
/// invocation host, including FIPS, China, and `api.aws` endpoints.
pub(crate) fn endpoint_scope(endpoint: &str) -> Option<(&str, &str)> {
	let authority = endpoint
		.strip_prefix("https://")
		.or_else(|| endpoint.strip_prefix("http://"))?
		.split('/')
		.next()?;
	let host = authority.split(':').next()?;
	let stem = host
		.strip_suffix(".amazonaws.com.cn")
		.or_else(|| host.strip_suffix(".amazonaws.com"))
		.or_else(|| host.strip_suffix(".api.aws"))?;
	let (service, region) = stem.split_once('.')?;
	if service.is_empty() || region.is_empty() || region.contains('.') {
		return None;
	}
	let service = service.strip_suffix("-fips").unwrap_or(service);
	let service = if service == "bedrock-runtime" {
		"bedrock"
	} else {
		service
	};
	Some((service, region))
}

/// Signs the exact method, URI, headers, and buffered body in place.
///
/// Header mutation is transactional: malformed public input or signing
/// material leaves the original request untouched.
///
/// This function is crate-private so AWS key material cannot be used outside a
/// [`super::lease::CredentialLease`].
pub(crate) fn sign_request(
	credential: &AwsCredential,
	spec: &SigV4Spec,
	signed_at: SystemTime,
	request: &mut Request<Bytes>,
) -> Result<(), SigV4Error> {
	if spec.service.is_empty() || spec.region.is_empty() {
		return Err(SigV4Error::InvalidSpec);
	}
	let (amz_date, short_date) = aws_dates(signed_at)?;
	let host = request
		.uri()
		.authority()
		.map(|authority| {
			HeaderValue::from_str(authority.as_str()).map_err(|_| SigV4Error::InvalidHeaderValue)
		})
		.transpose()?
		.or_else(|| request.headers().get(HOST).cloned())
		.ok_or(SigV4Error::MissingHost)?;
	let amz_date_header =
		HeaderValue::from_str(&amz_date).map_err(|_| SigV4Error::InvalidHeaderValue)?;
	let payload_hash = Sha256::digest(request.body());
	let payload_hash = hex::encode(&payload_hash).into_string();
	let payload_hash_header =
		HeaderValue::from_str(&payload_hash).map_err(|_| SigV4Error::InvalidHeaderValue)?;
	let session_token = credential
		.session_token
		.as_ref()
		.map(|token| {
			let mut value = HeaderValue::from_str(token.expose_secret())
				.map_err(|_| SigV4Error::InvalidHeaderValue)?;
			value.set_sensitive(true);
			Ok(value)
		})
		.transpose()?;

	let owned = SignerHeaders {
		host,
		amz_date: amz_date_header,
		payload_hash: payload_hash_header,
		session_token,
	};
	let (canonical_hash, signed_headers) = canonical_request(request, &payload_hash, spec, &owned)?;
	let scope = format!("{short_date}/{}/{}/aws4_request", spec.region, spec.service);
	let string_to_sign = format!(
		"AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
		hex::encode(&canonical_hash).into_string()
	);

	let signing_key = derive_signing_key(
		credential.secret_access_key.expose_secret(),
		&short_date,
		spec.region.as_str(),
		spec.service.as_str(),
	);
	let mut signature = Zeroizing::new(hmac_sha256(&signing_key[..], string_to_sign.as_bytes()));
	let signature_hex = hex::encode(&signature[..]).into_string();

	let mut authorization = Zeroizing::new(Vec::with_capacity(
		credential.access_key_id.expose_secret().len()
			+ scope.len()
			+ signed_headers.len()
			+ signature_hex.len()
			+ 64,
	));
	authorization.extend_from_slice(b"AWS4-HMAC-SHA256 Credential=");
	authorization.extend_from_slice(credential.access_key_id.expose_secret().as_bytes());
	authorization.push(b'/');
	authorization.extend_from_slice(scope.as_bytes());
	authorization.extend_from_slice(b", SignedHeaders=");
	authorization.extend_from_slice(signed_headers.as_bytes());
	authorization.extend_from_slice(b", Signature=");
	authorization.extend_from_slice(signature_hex.as_bytes());
	let mut authorization =
		HeaderValue::from_bytes(&authorization).map_err(|_| SigV4Error::InvalidHeaderValue)?;
	authorization.set_sensitive(true);
	signature.zeroize();

	let headers = request.headers_mut();
	headers.insert(HOST, owned.host);
	headers.insert(HeaderName::from_static("x-amz-date"), owned.amz_date);
	headers.insert(HeaderName::from_static("x-amz-content-sha256"), owned.payload_hash);
	if let Some(token) = owned.session_token {
		headers.insert(HeaderName::from_static("x-amz-security-token"), token);
	} else {
		headers.remove(HeaderName::from_static("x-amz-security-token"));
	}
	headers.insert(AUTHORIZATION, authorization);
	Ok(())
}

struct SignerHeaders {
	host:          HeaderValue,
	amz_date:      HeaderValue,
	payload_hash:  HeaderValue,
	session_token: Option<HeaderValue>,
}

fn canonical_request(
	request: &Request<Bytes>,
	payload_hash: &str,
	spec: &SigV4Spec,
	owned: &SignerHeaders,
) -> Result<([u8; 32], String), SigV4Error> {
	let mut headers: BTreeMap<&str, Vec<&HeaderValue>> = BTreeMap::new();
	for (name, value) in request.headers() {
		let name = name.as_str();
		if default_unsigned_header(name)
			|| signer_owned_header(name)
			|| spec
				.unsigned_headers
				.iter()
				.any(|excluded| excluded == name)
		{
			continue;
		}
		headers.entry(name).or_default().push(value);
	}
	headers.insert("host", vec![&owned.host]);
	headers.insert("x-amz-content-sha256", vec![&owned.payload_hash]);
	headers.insert("x-amz-date", vec![&owned.amz_date]);
	if let Some(token) = owned.session_token.as_ref() {
		headers.insert("x-amz-security-token", vec![token]);
	}
	let signed_headers = headers.keys().copied().collect::<Vec<_>>().join(";");
	let mut canonical = Zeroizing::new(Vec::new());
	canonical.extend_from_slice(request.method().as_str().as_bytes());
	canonical.push(b'\n');
	let canonical_uri = canonical_path(request.uri().path());
	canonical.extend_from_slice(canonical_uri.as_bytes());
	canonical.push(b'\n');
	let canonical_query = canonical_query(request.uri().query().unwrap_or_default())?;
	canonical.extend_from_slice(canonical_query.as_bytes());
	canonical.push(b'\n');
	for (name, values) in headers {
		canonical.extend_from_slice(name.as_bytes());
		canonical.push(b':');
		for (index, value) in values.into_iter().enumerate() {
			if index != 0 {
				canonical.push(b',');
			}
			let value = value.to_str().map_err(|_| SigV4Error::InvalidHeaderValue)?;
			append_normalized_header(&mut canonical, value);
		}
		canonical.push(b'\n');
	}
	canonical.push(b'\n');
	canonical.extend_from_slice(signed_headers.as_bytes());
	canonical.push(b'\n');
	canonical.extend_from_slice(payload_hash.as_bytes());
	let hash = Sha256::digest(&canonical);
	Ok((hash.into(), signed_headers))
}

fn canonical_path(path: &str) -> String {
	let mut output = String::with_capacity(path.len());
	for byte in path.bytes() {
		if byte == b'/' {
			output.push('/');
		} else {
			append_uri_byte(&mut output, byte);
		}
	}
	output
}

fn canonical_query(query: &str) -> Result<String, SigV4Error> {
	if query.is_empty() {
		return Ok(String::new());
	}
	let mut parameters = query
		.split('&')
		.filter(|parameter| !parameter.is_empty())
		.map(|parameter| {
			let (name, value) = parameter.split_once('=').unwrap_or((parameter, ""));
			Ok((decode_query_component(name)?, decode_query_component(value)?))
		})
		.collect::<Result<Vec<_>, SigV4Error>>()?;
	parameters.sort_by(|(left_name, left_value), (right_name, right_value)| {
		left_name
			.encode_utf16()
			.cmp(right_name.encode_utf16())
			.then_with(|| left_value.encode_utf16().cmp(right_value.encode_utf16()))
	});
	let mut output = String::new();
	for (index, (name, value)) in parameters.into_iter().enumerate() {
		if index != 0 {
			output.push('&');
		}
		append_query_component(&mut output, &name);
		output.push('=');
		append_query_component(&mut output, &value);
	}
	Ok(output)
}

fn decode_query_component(value: &str) -> Result<String, SigV4Error> {
	let bytes = value.as_bytes();
	let mut decoded = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'%' {
			let high = bytes
				.get(index + 1)
				.and_then(|&byte| hex_value(byte))
				.ok_or(SigV4Error::InvalidQueryEncoding)?;
			let low = bytes
				.get(index + 2)
				.and_then(|&byte| hex_value(byte))
				.ok_or(SigV4Error::InvalidQueryEncoding)?;
			decoded.push(high * 16 + low);
			index += 3;
		} else {
			decoded.push(bytes[index]);
			index += 1;
		}
	}
	String::from_utf8(decoded).map_err(|_| SigV4Error::InvalidQueryEncoding)
}

fn append_query_component(output: &mut String, value: &str) {
	for byte in value.bytes() {
		append_uri_byte(output, byte);
	}
}

fn append_uri_byte(output: &mut String, byte: u8) {
	if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
		output.push(char::from(byte));
	} else {
		output.push('%');
		output.push(hex_digit(byte >> 4));
		output.push(hex_digit(byte & 0x0f));
	}
}

const fn hex_value(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'a'..=b'f' => Some(byte - b'a' + 10),
		b'A'..=b'F' => Some(byte - b'A' + 10),
		_ => None,
	}
}

const fn hex_digit(value: u8) -> char {
	match value {
		0..=9 => (b'0' + value) as char,
		_ => (b'A' + value - 10) as char,
	}
}

fn default_unsigned_header(name: &str) -> bool {
	matches!(
		name.as_bytes(),
		b"authorization"
			| b"cache-control"
			| b"connection"
			| b"expect"
			| b"from"
			| b"keep-alive"
			| b"max-forwards"
			| b"pragma"
			| b"referer"
			| b"te"
			| b"trailer"
			| b"transfer-encoding"
			| b"upgrade"
			| b"user-agent"
			| b"x-amzn-trace-id"
	) || name.starts_with("proxy-")
		|| name.starts_with("sec-")
}

const fn signer_owned_header(name: &str) -> bool {
	matches!(
		name.as_bytes(),
		b"host" | b"x-amz-content-sha256" | b"x-amz-date" | b"x-amz-security-token"
	)
}

fn append_normalized_header(output: &mut Vec<u8>, value: &str) {
	for (index, part) in value.split_ascii_whitespace().enumerate() {
		if index != 0 {
			output.push(b' ');
		}
		output.extend_from_slice(part.as_bytes());
	}
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
	let key = hmac::Key::new(hmac::HMAC_SHA256, key);
	hmac::sign(&key, message)
		.as_ref()
		.try_into()
		.expect("SHA-256 HMAC is 32 bytes")
}

fn derive_signing_key(
	secret_access_key: &str,
	short_date: &str,
	region: &str,
	service: &str,
) -> Zeroizing<[u8; 32]> {
	let mut initial = Zeroizing::new(Vec::with_capacity(4 + secret_access_key.len()));
	initial.extend_from_slice(b"AWS4");
	initial.extend_from_slice(secret_access_key.as_bytes());
	let date_key = Zeroizing::new(hmac_sha256(&initial, short_date.as_bytes()));
	let region_key = Zeroizing::new(hmac_sha256(&date_key[..], region.as_bytes()));
	let service_key = Zeroizing::new(hmac_sha256(&region_key[..], service.as_bytes()));
	Zeroizing::new(hmac_sha256(&service_key[..], b"aws4_request"))
}

fn aws_dates(time: SystemTime) -> Result<(String, String), SigV4Error> {
	let seconds = time
		.duration_since(UNIX_EPOCH)
		.map_err(|_| SigV4Error::InvalidTime)?
		.as_secs();
	let days = i64::try_from(seconds / 86_400).map_err(|_| SigV4Error::InvalidTime)?;
	let seconds_of_day = seconds % 86_400;
	let (year, month, day) = civil_from_days(days);
	let hour = seconds_of_day / 3_600;
	let minute = seconds_of_day % 3_600 / 60;
	let second = seconds_of_day % 60;
	let short = format!("{year:04}{month:02}{day:02}");
	Ok((format!("{short}T{hour:02}{minute:02}{second:02}Z"), short))
}

const fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
	let days = days_since_epoch + 719_468;
	let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
	let day_of_era = days - era * 146_097;
	let year_of_era =
		(day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
	let mut year = year_of_era + era * 400;
	let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
	let month_prime = (5 * day_of_year + 2) / 153;
	let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
	let month = month_prime + if month_prime < 10 { 3 } else { -9 };
	year += if month <= 2 { 1 } else { 0 };
	(year, month, day)
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use super::*;

	const ACCESS_KEY: &str = "AKIDEXAMPLE";
	const SECRET_KEY: &str = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
	const VECTOR_SECONDS: u64 = 1_440_938_160;

	fn credential(session_token: Option<&str>) -> AwsCredential {
		AwsCredential::new(
			SecretString::from(ACCESS_KEY.to_owned()),
			SecretString::from(SECRET_KEY.to_owned()),
			session_token.map(|token| SecretString::from(token.to_owned())),
		)
	}

	fn spec(unsigned_headers: Vec<omp_core::Str>) -> SigV4Spec {
		SigV4Spec { service: "service".into(), region: "us-east-1".into(), unsigned_headers }
	}

	#[test]
	fn dates_and_derived_signing_key_match_aws_vectors() {
		assert_eq!(
			aws_dates(UNIX_EPOCH + Duration::from_secs(VECTOR_SECONDS)).expect("valid date"),
			("20150830T123600Z".to_owned(), "20150830".to_owned())
		);
		let key = derive_signing_key(SECRET_KEY, "20150830", "us-east-1", "iam");
		assert_eq!(
			hex::encode(&key[..]).into_string(),
			"c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9"
		);
	}

	#[test]
	fn get_with_empty_body_matches_smithy_reference_bytes() {
		let mut request = Request::builder()
			.method("GET")
			.uri("https://example.amazonaws.com/")
			.body(Bytes::new())
			.expect("request");
		sign_request(
			&credential(None),
			&spec(Vec::new()),
			UNIX_EPOCH + Duration::from_secs(VECTOR_SECONDS),
			&mut request,
		)
		.expect("signature");

		assert_eq!(request.headers()[HOST], "example.amazonaws.com");
		assert_eq!(request.headers()["x-amz-date"], "20150830T123600Z");
		assert_eq!(
			request.headers()["x-amz-content-sha256"],
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
		);
		assert_eq!(
			request.headers()[AUTHORIZATION],
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, \
			 SignedHeaders=host;x-amz-content-sha256;x-amz-date, \
			 Signature=726c5c4879a6b4ccbbd3b24edbd6b8826d34f87450fbbf4e85546fc7ba9c1642"
		);

		let first = request.headers()[AUTHORIZATION].clone();
		sign_request(
			&credential(None),
			&spec(Vec::new()),
			UNIX_EPOCH + Duration::from_secs(VECTOR_SECONDS),
			&mut request,
		)
		.expect("repeat signature");
		assert_eq!(request.headers()[AUTHORIZATION], first);
	}

	#[test]
	fn post_with_json_body_matches_smithy_reference_bytes() {
		let mut request = Request::builder()
			.method("POST")
			.uri("https://example.amazonaws.com/")
			.header("content-type", "application/json")
			.body(Bytes::from_static(br#"{"hello":"world"}"#))
			.expect("request");
		sign_request(
			&credential(None),
			&spec(Vec::new()),
			UNIX_EPOCH + Duration::from_secs(VECTOR_SECONDS),
			&mut request,
		)
		.expect("signature");

		assert_eq!(
			request.headers()["x-amz-content-sha256"],
			"93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588"
		);
		assert_eq!(
			request.headers()[AUTHORIZATION],
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, \
			 SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, \
			 Signature=e9744044f72be2a6e5082cdcebb673e0a1daf890c82cc130d46abd3769ca15e0"
		);
	}

	#[test]
	fn session_token_is_signer_owned_signed_and_redacted() {
		let session = "AQoDYXdzEJr...";
		let credential = credential(Some(session));
		let mut request = Request::builder()
			.method("GET")
			.uri("https://example.amazonaws.com/")
			.header(HOST, "caller.example")
			.header(AUTHORIZATION, "Bearer caller-secret")
			.header("x-amz-date", "19990101T000000Z")
			.header("x-amz-content-sha256", "caller-hash")
			.header("x-amz-security-token", "caller-token")
			.body(Bytes::new())
			.expect("request");
		sign_request(
			&credential,
			&spec(vec![
				"host".into(),
				"x-amz-date".into(),
				"x-amz-content-sha256".into(),
				"x-amz-security-token".into(),
			]),
			UNIX_EPOCH + Duration::from_secs(VECTOR_SECONDS),
			&mut request,
		)
		.expect("signature");

		assert_eq!(request.headers()[HOST], "example.amazonaws.com");
		assert_eq!(request.headers()["x-amz-date"], "20150830T123600Z");
		assert_eq!(
			request.headers()["x-amz-content-sha256"],
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
		);
		assert_eq!(request.headers()["x-amz-security-token"], session);
		assert!(
			request.headers()[AUTHORIZATION]
				.to_str()
				.expect("authorization")
				.contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token")
		);
		let debug = format!("{credential:?} {request:?}");
		assert!(!debug.contains(SECRET_KEY));
		assert!(!debug.contains(session));
		assert!(!debug.contains("caller-secret"));
		assert!(!debug.contains("caller-token"));
	}

	#[test]
	fn absent_session_token_removes_a_caller_supplied_token() {
		let mut request = Request::builder()
			.method("GET")
			.uri("https://example.amazonaws.com/")
			.header("x-amz-security-token", "caller-token")
			.body(Bytes::new())
			.expect("request");
		sign_request(
			&credential(None),
			&spec(Vec::new()),
			UNIX_EPOCH + Duration::from_secs(VECTOR_SECONDS),
			&mut request,
		)
		.expect("signature");
		assert!(!request.headers().contains_key("x-amz-security-token"));
		assert!(
			!request.headers()[AUTHORIZATION]
				.to_str()
				.expect("authorization")
				.contains("x-amz-security-token")
		);
	}

	#[test]
	fn canonical_query_decodes_sorts_and_reencodes_like_javascript() {
		assert_eq!(
			canonical_query("z=last&a=+&a=/&empty&colon=:&lower=%2f&upper=%2F&a=")
				.expect("canonical query"),
			"a=&a=%2B&a=%2F&colon=%3A&empty=&lower=%2F&upper=%2F&z=last"
		);
		assert_eq!(
			canonical_query("%EE%80%80=b&%F0%90%80%80=a").expect("Unicode query"),
			"%F0%90%80%80=a&%EE%80%80=b"
		);
		assert_eq!(canonical_query("a=1&&b=2&").expect("empty pairs"), "a=1&b=2");
		assert_eq!(canonical_query("bad=%ZZ"), Err(SigV4Error::InvalidQueryEncoding));
		assert_eq!(canonical_query("bad=%E0%A4%A"), Err(SigV4Error::InvalidQueryEncoding));
	}

	#[test]
	fn canonical_path_preserves_segments_and_double_encodes_percent() {
		assert_eq!(canonical_path("/a//b/./c/../d:+/%2f/%2F"), "/a//b/./c/../d%3A%2B/%252f/%252F");
		assert_eq!(canonical_path("/model/a:b.c/converse-stream"), "/model/a%3Ab.c/converse-stream");
	}

	#[test]
	fn endpoint_scope_infers_standard_fips_china_and_api_aws_hosts() {
		assert_eq!(
			endpoint_scope("https://bedrock-runtime.eu-west-2.amazonaws.com/model/id"),
			Some(("bedrock", "eu-west-2")),
		);
		assert_eq!(
			endpoint_scope("https://bedrock-runtime-fips.cn-north-1.amazonaws.com.cn/model/id"),
			Some(("bedrock", "cn-north-1")),
		);
		assert_eq!(
			endpoint_scope("https://bedrock-mantle.us-east-2.api.aws/v1/responses"),
			Some(("bedrock-mantle", "us-east-2")),
		);
		assert_eq!(endpoint_scope("https://custom.example/v1"), None);
		assert_eq!(endpoint_scope("https://sts.amazonaws.com/"), None);
	}

	#[test]
	fn standard_transport_and_proxy_headers_are_never_signed() {
		for name in [
			"authorization",
			"cache-control",
			"connection",
			"expect",
			"from",
			"keep-alive",
			"max-forwards",
			"pragma",
			"referer",
			"te",
			"trailer",
			"transfer-encoding",
			"upgrade",
			"user-agent",
			"x-amzn-trace-id",
			"proxy-authorization",
			"sec-fetch-mode",
		] {
			assert!(default_unsigned_header(name), "{name}");
		}
		assert!(!default_unsigned_header("content-type"));
	}

	#[test]
	fn canonical_headers_collapse_whitespace_and_exclude_unsigned_values() {
		let mut baseline = Request::builder()
			.method("GET")
			.uri("https://example.amazonaws.com/")
			.header("x-custom", "one two")
			.header("x-ignored", "baseline")
			.body(Bytes::new())
			.expect("request");
		let mut noisy = Request::builder()
			.method("GET")
			.uri("https://example.amazonaws.com/")
			.header("x-custom", "one \t  two")
			.header("x-ignored", "changed")
			.header("cache-control", "no-cache")
			.header("user-agent", "caller")
			.header("proxy-authorization", "secret")
			.header("sec-fetch-mode", "cors")
			.body(Bytes::new())
			.expect("request");
		let spec = spec(vec!["x-ignored".into()]);
		sign_request(
			&credential(None),
			&spec,
			UNIX_EPOCH + Duration::from_secs(VECTOR_SECONDS),
			&mut baseline,
		)
		.expect("baseline signature");
		sign_request(
			&credential(None),
			&spec,
			UNIX_EPOCH + Duration::from_secs(VECTOR_SECONDS),
			&mut noisy,
		)
		.expect("noisy signature");
		assert_eq!(baseline.headers()[AUTHORIZATION], noisy.headers()[AUTHORIZATION]);
		assert!(
			baseline.headers()[AUTHORIZATION]
				.to_str()
				.expect("authorization")
				.contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-custom")
		);
	}

	#[test]
	fn malformed_input_errors_are_typed_redacted_and_atomic() {
		let mut missing_host = Request::builder()
			.method("GET")
			.uri("/")
			.header("x-amz-date", "caller-date")
			.header("x-amz-content-sha256", "caller-hash")
			.header("x-amz-security-token", "caller-token")
			.header(AUTHORIZATION, "Bearer caller-secret")
			.body(Bytes::new())
			.expect("request");
		let original_headers = missing_host.headers().clone();
		assert_eq!(
			sign_request(
				&credential(None),
				&spec(Vec::new()),
				UNIX_EPOCH + Duration::from_secs(VECTOR_SECONDS),
				&mut missing_host
			),
			Err(SigV4Error::MissingHost)
		);
		assert_eq!(missing_host.headers(), &original_headers);

		let mut invalid_query = Request::builder()
			.method("GET")
			.uri("https://example.amazonaws.com/?secret=%FF")
			.header("x-amz-date", "caller-date")
			.header("x-amz-content-sha256", "caller-hash")
			.header("x-amz-security-token", "caller-token")
			.header(AUTHORIZATION, "Bearer caller-secret")
			.body(Bytes::new())
			.expect("request");
		let original_headers = invalid_query.headers().clone();
		assert_eq!(
			sign_request(
				&credential(Some("session-secret")),
				&spec(Vec::new()),
				UNIX_EPOCH + Duration::from_secs(VECTOR_SECONDS),
				&mut invalid_query,
			),
			Err(SigV4Error::InvalidQueryEncoding),
		);
		assert_eq!(invalid_query.headers(), &original_headers);

		let secret_value = "secret\nheader";
		let bad_credential = credential(Some(secret_value));
		let mut invalid_header = Request::builder()
			.method("GET")
			.uri("https://example.amazonaws.com/")
			.body(Bytes::new())
			.expect("request");
		let error = sign_request(
			&bad_credential,
			&spec(Vec::new()),
			UNIX_EPOCH + Duration::from_secs(VECTOR_SECONDS),
			&mut invalid_header,
		)
		.expect_err("invalid token");
		assert_eq!(error, SigV4Error::InvalidHeaderValue);
		assert!(!format!("{error:?} {error}").contains(secret_value));
	}

	#[test]
	fn aws_published_iam_canonical_components_are_stable() {
		assert_eq!(canonical_path("/"), "/");
		assert_eq!(
			canonical_query("Version=2010-05-08&Action=ListUsers").expect("canonical query"),
			"Action=ListUsers&Version=2010-05-08"
		);
	}
}
