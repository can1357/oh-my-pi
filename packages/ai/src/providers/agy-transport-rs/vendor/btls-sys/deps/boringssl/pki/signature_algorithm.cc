// Copyright 2015 The Chromium Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include "signature_algorithm.h"

#include <openssl/bytestring.h>
#include <openssl/digest.h>
#include <openssl/nid.h>

#include "input.h"
#include "parse_values.h"
#include "parser.h"

BSSL_NAMESPACE_BEGIN

namespace {

// These OIDs do not reference libcrypto's OBJ table, as that table is very
// large and includes many more OIDs than we need. However, where OIDs are
// already in the table, we reuse the |OBJ_ENC_*| constants to avoid needing to
// specify them a second time.

// From RFC 5912:
//
//     sha1WithRSAEncryption OBJECT IDENTIFIER ::= {
//      iso(1) member-body(2) us(840) rsadsi(113549) pkcs(1)
//      pkcs-1(1) 5 }
//
// In dotted notation: 1.2.840.113549.1.1.5
const uint8_t kOidSha1WithRsaEncryption[] = {OBJ_ENC_sha1WithRSAEncryption};

// sha1WithRSASignature is a deprecated equivalent of
// sha1WithRSAEncryption.
//
// It originates from the NIST Open Systems Environment (OSE)
// Implementor's Workshop (OIW).
//
// It is supported for compatibility with Microsoft's certificate APIs and
// tools, particularly makecert.exe, which default(ed/s) to this OID for SHA-1.
//
// See also: https://bugzilla.mozilla.org/show_bug.cgi?id=1042479
//
// In dotted notation: 1.3.14.3.2.29
const uint8_t kOidSha1WithRsaSignature[] = {OBJ_ENC_sha1WithRSA};

// From RFC 5912:
//
//     pkcs-1  OBJECT IDENTIFIER  ::=
//         { iso(1) member-body(2) us(840) rsadsi(113549) pkcs(1) 1 }

// From RFC 5912:
//
//     sha256WithRSAEncryption  OBJECT IDENTIFIER  ::=  { pkcs-1 11 }
//
// In dotted notation: 1.2.840.113549.1.1.11
const uint8_t kOidSha256WithRsaEncryption[] = {OBJ_ENC_sha256WithRSAEncryption};

// From RFC 5912:
//
//     sha384WithRSAEncryption  OBJECT IDENTIFIER  ::=  { pkcs-1 12 }
//
// In dotted notation: 1.2.840.113549.1.1.11
const uint8_t kOidSha384WithRsaEncryption[] = {OBJ_ENC_sha384WithRSAEncryption};

// From RFC 5912:
//
//     sha512WithRSAEncryption  OBJECT IDENTIFIER  ::=  { pkcs-1 13 }
//
// In dotted notation: 1.2.840.113549.1.1.13
const uint8_t kOidSha512WithRsaEncryption[] = {OBJ_ENC_sha512WithRSAEncryption};

// From RFC 5912:
//
//     ecdsa-with-SHA1 OBJECT IDENTIFIER ::= {
//      iso(1) member-body(2) us(840) ansi-X9-62(10045)
//      signatures(4) 1 }
//
// In dotted notation: 1.2.840.10045.4.1
const uint8_t kOidEcdsaWithSha1[] = {OBJ_ENC_ecdsa_with_SHA1};

// From RFC 5912:
//
//     ecdsa-with-SHA256 OBJECT IDENTIFIER ::= {
//      iso(1) member-body(2) us(840) ansi-X9-62(10045) signatures(4)
//      ecdsa-with-SHA2(3) 2 }
//
// In dotted notation: 1.2.840.10045.4.3.2
const uint8_t kOidEcdsaWithSha256[] = {OBJ_ENC_ecdsa_with_SHA256};

// From RFC 5912:
//
//     ecdsa-with-SHA384 OBJECT IDENTIFIER ::= {
//      iso(1) member-body(2) us(840) ansi-X9-62(10045) signatures(4)
//      ecdsa-with-SHA2(3) 3 }
//
// In dotted notation: 1.2.840.10045.4.3.3
const uint8_t kOidEcdsaWithSha384[] = {OBJ_ENC_ecdsa_with_SHA384};

// From RFC 5912:
//
//     ecdsa-with-SHA512 OBJECT IDENTIFIER ::= {
//      iso(1) member-body(2) us(840) ansi-X9-62(10045) signatures(4)
//      ecdsa-with-SHA2(3) 4 }
//
// In dotted notation: 1.2.840.10045.4.3.4
const uint8_t kOidEcdsaWithSha512[] = {OBJ_ENC_ecdsa_with_SHA512};

// From RFC 5912:
//
//     id-RSASSA-PSS  OBJECT IDENTIFIER  ::=  { pkcs-1 10 }
//
// In dotted notation: 1.2.840.113549.1.1.10
const uint8_t kOidRsaSsaPss[] = {OBJ_ENC_rsassaPss};

// From RFC 5912:
//
//     id-mgf1  OBJECT IDENTIFIER  ::=  { pkcs-1 8 }
//
// In dotted notation: 1.2.840.113549.1.1.8
const uint8_t kOidMgf1[] = {OBJ_ENC_mgf1};

// Returns true if the entirety of the input is a NULL value.
[[nodiscard]] bool IsNull(der::Input input) {
  der::Parser parser(input);
  der::Input null_value;
  if (!parser.ReadTag(CBS_ASN1_NULL, &null_value)) {
    return false;
  }

  // NULL values are TLV encoded; the value is expected to be empty.
  if (!null_value.empty()) {
    return false;
  }

  // By definition of this function, the entire input must be a NULL.
  return !parser.HasMore();
}

[[nodiscard]] bool IsNullOrEmpty(der::Input input) {
  return IsNull(input) || input.empty();
}

// Parses a MaskGenAlgorithm as defined by RFC 5912:
//
//     MaskGenAlgorithm ::= AlgorithmIdentifier{ALGORITHM,
//                             {PKCS1MGFAlgorithms}}
//
//     mgf1SHA1 MaskGenAlgorithm ::= {
//         algorithm id-mgf1,
//         parameters HashAlgorithm : sha1Identifier
//     }
//
//     --
//     --  Define the set of mask generation functions
//     --
//     --  If the identifier is id-mgf1, any of the listed hash
//     --    algorithms may be used.
//     --
//
//     PKCS1MGFAlgorithms ALGORITHM ::= {
//         { IDENTIFIER id-mgf1 PARAMS TYPE HashAlgorithm ARE required },
//         ...
//     }
//
// Note that the possible mask gen algorithms is extensible. However at present
// the only function supported is MGF1, as that is the singular mask gen
// function defined by RFC 4055 / RFC 5912.
[[nodiscard]] bool ParseMaskGenAlgorithm(const der::Input input,
                                         DigestAlgorithm *mgf1_hash) {
  der::Input oid;
  der::Input params;
  if (!ParseAlgorithmIdentifier(input, &oid, &params)) {
    return false;
  }

  // MGF1 is the only supported mask generation algorithm.
  if (oid != der::Input(kOidMgf1)) {
    return false;
  }

  return ParseHashAlgorithm(params, mgf1_hash);
}

// Parses the parameters for an RSASSA-PSS signature algorithm, as defined by
// RFC 5912:
//
//     sa-rsaSSA-PSS SIGNATURE-ALGORITHM ::= {
//         IDENTIFIER id-RSASSA-PSS
//         PARAMS TYPE RSASSA-PSS-params ARE required
//         HASHES { mda-sha1 | mda-sha224 | mda-sha256 | mda-sha384
//                      | mda-sha512 }
//         PUBLIC-KEYS { pk-rsa | pk-rsaSSA-PSS }
//         SMIME-CAPS { IDENTIFIED BY id-RSASSA-PSS }
//     }
//
//     RSASSA-PSS-params  ::=  SEQUENCE  {
//         hashAlgorithm     [0] HashAlgorithm DEFAULT sha1Identifier,
//         maskGenAlgorithm  [1] MaskGenAlgorithm DEFAULT mgf1SHA1,
//         saltLength        [2] INTEGER DEFAULT 20,
//         trailerField      [3] INTEGER DEFAULT 1
//     }
//
// Which is to say the parameters MUST be present, and of type
// RSASSA-PSS-params. Additionally, we only support the RSA-PSS parameter
// combinations representable by TLS 1.3 (RFC 8446).
//
// Note also that DER encoding (ITU-T X.690 section 11.5) prohibits
// specifying default values explicitly. The parameter should instead be
// omitted to indicate a default value.
std::optional<SignatureAlgorithm> ParseRsaPss(der::Input params) {
  der::Parser parser(params);
  der::Parser params_parser;
  if (!parser.ReadSequence(&params_parser)) {
    return std::nullopt;
  }

  // There shouldn't be anything after the sequence (by definition the
  // parameters is a single sequence).
  if (parser.HasMore()) {
    return std::nullopt;
  }

  // The default values for hashAlgorithm, maskGenAlgorithm, and saltLength
  // correspond to SHA-1, which we do not support with RSA-PSS, so treat them as
  // required fields. Explicitly-specified defaults will be rejected later, when
  // we limit combinations. Additionally, as the trailerField is required to be
  // the default, we simply ignore it and reject it as any other trailing data.
  //
  //     hashAlgorithm     [0] HashAlgorithm DEFAULT sha1Identifier,
  //     maskGenAlgorithm  [1] MaskGenAlgorithm DEFAULT mgf1SHA1,
  //     saltLength        [2] INTEGER DEFAULT 20,
  //     trailerField      [3] INTEGER DEFAULT 1
  der::Input field;
  DigestAlgorithm hash, mgf1_hash;
  der::Parser salt_length_parser;
  uint64_t salt_length;
  if (!params_parser.ReadTag(
          CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 0, &field) ||
      !ParseHashAlgorithm(field, &hash) ||
      !params_parser.ReadTag(
          CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 1, &field) ||
      !ParseMaskGenAlgorithm(field, &mgf1_hash) ||
      !params_parser.ReadConstructed(
          CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 2,
          &salt_length_parser) ||
      !salt_length_parser.ReadUint64(&salt_length) ||
      salt_length_parser.HasMore() || params_parser.HasMore()) {
    return std::nullopt;
  }

  // Only combinations of RSASSA-PSS-params specified by TLS 1.3 (RFC 8446) are
  // supported.
  if (hash != mgf1_hash) {
    return std::nullopt;  // TLS 1.3 always matches MGF-1 and message hash.
  }
  if (hash == DigestAlgorithm::Sha256 && salt_length == 32) {
    return SignatureAlgorithm::kRsaPssSha256;
  }
  if (hash == DigestAlgorithm::Sha384 && salt_length == 48) {
    return SignatureAlgorithm::kRsaPssSha384;
  }
  if (hash == DigestAlgorithm::Sha512 && salt_length == 64) {
    return SignatureAlgorithm::kRsaPssSha512;
  }

  return std::nullopt;
}

}  // namespace

[[nodiscard]] bool ParseAlgorithmIdentifier(der::Input input,
                                            der::Input *algorithm,
                                            der::Input *parameters) {
  der::Parser parser(input);

  der::Parser algorithm_identifier_parser;
  if (!parser.ReadSequence(&algorithm_identifier_parser)) {
    return false;
  }

  // There shouldn't be anything after the sequence. This is by definition,
  // as the input to this function is expected to be a single
  // AlgorithmIdentifier.
  if (parser.HasMore()) {
    return false;
  }

  if (!algorithm_identifier_parser.ReadTag(CBS_ASN1_OBJECT, algorithm)) {
    return false;
  }

  // Read the optional parameters to a der::Input. The parameters can be at
  // most one TLV (for instance NULL or a sequence).
  //
  // Note that nothing is allowed after the single optional "parameters" TLV.
  // This is because RFC 5912's notation for AlgorithmIdentifier doesn't
  // explicitly list an extension point after "parameters".
  *parameters = der::Input();
  if (algorithm_identifier_parser.HasMore() &&
      !algorithm_identifier_parser.ReadRawTLV(parameters)) {
    return false;
  }
  return !algorithm_identifier_parser.HasMore();
}

[[nodiscard]] bool ParseHashAlgorithm(der::Input input, DigestAlgorithm *out) {
  CBS cbs;
  CBS_init(&cbs, input.data(), input.size());
  const EVP_MD *md = EVP_parse_digest_algorithm(&cbs);

  if (md == EVP_sha1()) {
    *out = DigestAlgorithm::Sha1;
  } else if (md == EVP_sha256()) {
    *out = DigestAlgorithm::Sha256;
  } else if (md == EVP_sha384()) {
    *out = DigestAlgorithm::Sha384;
  } else if (md == EVP_sha512()) {
    *out = DigestAlgorithm::Sha512;
  } else {
    // TODO(eroman): Support MD2, MD4, MD5 for completeness?
    // Unsupported digest algorithm.
    return false;
  }

  return true;
}

std::optional<SignatureAlgorithm> ParseSignatureAlgorithm(
    der::Input algorithm_identifier) {
  der::Input oid;
  der::Input params;
  if (!ParseAlgorithmIdentifier(algorithm_identifier, &oid, &params)) {
    return std::nullopt;
  }

  // TODO(eroman): Each OID is tested for equality in order, which is not
  // particularly efficient.

  // RFC 5912 requires that the parameters for RSA PKCS#1 v1.5 algorithms be
  // NULL ("PARAMS TYPE NULL ARE required"), however an empty parameter is also
  // allowed for compatibility with non-compliant OCSP responders.
  //
  // TODO(svaldez): Add warning about non-strict parsing.
  if (oid == der::Input(kOidSha1WithRsaEncryption) && IsNullOrEmpty(params)) {
    return SignatureAlgorithm::kRsaPkcs1Sha1;
  }
  if (oid == der::Input(kOidSha256WithRsaEncryption) && IsNullOrEmpty(params)) {
    return SignatureAlgorithm::kRsaPkcs1Sha256;
  }
  if (oid == der::Input(kOidSha384WithRsaEncryption) && IsNullOrEmpty(params)) {
    return SignatureAlgorithm::kRsaPkcs1Sha384;
  }
  if (oid == der::Input(kOidSha512WithRsaEncryption) && IsNullOrEmpty(params)) {
    return SignatureAlgorithm::kRsaPkcs1Sha512;
  }
  if (oid == der::Input(kOidSha1WithRsaSignature) && IsNullOrEmpty(params)) {
    return SignatureAlgorithm::kRsaPkcs1Sha1;
  }

  // RFC 5912 requires that the parameters for ECDSA algorithms be absent
  // ("PARAMS TYPE NULL ARE absent"):
  if (oid == der::Input(kOidEcdsaWithSha1) && params.empty()) {
    return SignatureAlgorithm::kEcdsaSha1;
  }
  if (oid == der::Input(kOidEcdsaWithSha256) && params.empty()) {
    return SignatureAlgorithm::kEcdsaSha256;
  }
  if (oid == der::Input(kOidEcdsaWithSha384) && params.empty()) {
    return SignatureAlgorithm::kEcdsaSha384;
  }
  if (oid == der::Input(kOidEcdsaWithSha512) && params.empty()) {
    return SignatureAlgorithm::kEcdsaSha512;
  }

  if (oid == der::Input(kOidRsaSsaPss)) {
    return ParseRsaPss(params);
  }

  // Unknown signature algorithm.
  return std::nullopt;
}

std::optional<DigestAlgorithm> GetTlsServerEndpointDigestAlgorithm(
    SignatureAlgorithm alg) {
  // See RFC 5929, section 4.1. RFC 5929 breaks the signature algorithm
  // abstraction by trying to extract individual digest algorithms. (While
  // common, this is not a universal property of signature algorithms.) We
  // implement this within the library, so callers do not need to condition over
  // all algorithms.
  switch (alg) {
    // If the single digest algorithm is SHA-1, use SHA-256.
    case SignatureAlgorithm::kRsaPkcs1Sha1:
    case SignatureAlgorithm::kEcdsaSha1:
      return DigestAlgorithm::Sha256;

    case SignatureAlgorithm::kRsaPkcs1Sha256:
    case SignatureAlgorithm::kEcdsaSha256:
      return DigestAlgorithm::Sha256;

    case SignatureAlgorithm::kRsaPkcs1Sha384:
    case SignatureAlgorithm::kEcdsaSha384:
      return DigestAlgorithm::Sha384;

    case SignatureAlgorithm::kRsaPkcs1Sha512:
    case SignatureAlgorithm::kEcdsaSha512:
      return DigestAlgorithm::Sha512;

    // It is ambiguous whether hash-matching RSASSA-PSS instantiations count as
    // using one or multiple digests, but the corresponding digest is the only
    // reasonable interpretation.
    case SignatureAlgorithm::kRsaPssSha256:
      return DigestAlgorithm::Sha256;
    case SignatureAlgorithm::kRsaPssSha384:
      return DigestAlgorithm::Sha384;
    case SignatureAlgorithm::kRsaPssSha512:
      return DigestAlgorithm::Sha512;
  }
  return std::nullopt;
}

BSSL_NAMESPACE_END
