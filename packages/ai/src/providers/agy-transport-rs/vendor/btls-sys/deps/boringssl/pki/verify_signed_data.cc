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

#include "verify_signed_data.h"

#include <iterator>

#include <openssl/bytestring.h>
#include <openssl/digest.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/pki/signature_verify_cache.h>
#include <openssl/rsa.h>
#include <openssl/sha2.h>

#include "cert_errors.h"
#include "input.h"
#include "parse_values.h"
#include "parser.h"
#include "signature_algorithm.h"

BSSL_NAMESPACE_BEGIN

namespace {

bool SHA256UpdateWithLengthPrefixedData(SHA256_CTX *s_ctx, const uint8_t *data,
                                        uint64_t length) {
  return (SHA256_Update(s_ctx, reinterpret_cast<uint8_t *>(&length),
                        sizeof(length)) &&
          SHA256_Update(s_ctx, data, length));
}

// Increase to make incompatible changes in the computation of the
// cache key.
constexpr uint32_t VerifyCacheKeyVersion = 1;

std::string SignatureVerifyCacheKey(std::string_view algorithm_name,
                                    der::Input signed_data,
                                    der::Input signature_value_bytes,
                                    EVP_PKEY *public_key) {
  SHA256_CTX s_ctx;
  bssl::ScopedCBB public_key_cbb;
  uint8_t digest[SHA256_DIGEST_LENGTH];
  uint32_t version = VerifyCacheKeyVersion;
  if (CBB_init(public_key_cbb.get(), 128) &&
      EVP_marshal_public_key(public_key_cbb.get(), public_key) &&
      SHA256_Init(&s_ctx) &&
      SHA256_Update(&s_ctx, reinterpret_cast<uint8_t *>(&version),
                    sizeof(version)) &&
      SHA256UpdateWithLengthPrefixedData(
          &s_ctx, reinterpret_cast<const uint8_t *>(algorithm_name.data()),
          algorithm_name.length()) &&
      SHA256UpdateWithLengthPrefixedData(&s_ctx, CBB_data(public_key_cbb.get()),
                                         CBB_len(public_key_cbb.get())) &&
      SHA256UpdateWithLengthPrefixedData(&s_ctx, signature_value_bytes.data(),
                                         signature_value_bytes.size()) &&
      SHA256UpdateWithLengthPrefixedData(&s_ctx, signed_data.data(),
                                         signed_data.size()) &&
      SHA256_Final(digest, &s_ctx)) {
    return std::string(reinterpret_cast<char *>(digest), sizeof(digest));
  }
  return std::string();
}

// Place an instance of this class on the call stack to automatically clear
// the OpenSSL error stack on function exit.
// TODO(crbug.com/boringssl/38): Remove this when the library is more robust to
// leaving things in the error queue.
class OpenSSLErrStackTracer {
 public:
  ~OpenSSLErrStackTracer() { ERR_clear_error(); }
};

}  // namespace

// Parses an RSA public key or EC public key from SPKI to an EVP_PKEY. Returns
// true on success.
//
// This function only recognizes the "pk-rsa" (rsaEncryption) flavor of RSA
// public key from RFC 5912.
//
//     pk-rsa PUBLIC-KEY ::= {
//      IDENTIFIER rsaEncryption
//      KEY RSAPublicKey
//      PARAMS TYPE NULL ARE absent
//      -- Private key format not in this module --
//      CERT-KEY-USAGE {digitalSignature, nonRepudiation,
//      keyEncipherment, dataEncipherment, keyCertSign, cRLSign}
//     }
//
// COMPATIBILITY NOTE: RFC 5912 and RFC 3279 are in disagreement on the value
// of parameters for rsaEncryption. Whereas RFC 5912 says they must be absent,
// RFC 3279 says they must be NULL:
//
//     The rsaEncryption OID is intended to be used in the algorithm field
//     of a value of type AlgorithmIdentifier.  The parameters field MUST
//     have ASN.1 type NULL for this algorithm identifier.
//
// Following RFC 3279 in this case.
//
// In the case of parsing EC keys, RFC 5912 describes all the ECDSA
// signature algorithms as requiring a public key of type "pk-ec":
//
//     pk-ec PUBLIC-KEY ::= {
//      IDENTIFIER id-ecPublicKey
//      KEY ECPoint
//      PARAMS TYPE ECParameters ARE required
//      -- Private key format not in this module --
//      CERT-KEY-USAGE { digitalSignature, nonRepudiation, keyAgreement,
//                           keyCertSign, cRLSign }
//     }
//
// Moreover RFC 5912 stipulates what curves are allowed. The ECParameters
// MUST NOT use an implicitCurve or specificCurve for PKIX:
//
//     ECParameters ::= CHOICE {
//      namedCurve      CURVE.&id({NamedCurve})
//      -- implicitCurve   NULL
//        -- implicitCurve MUST NOT be used in PKIX
//      -- specifiedCurve  SpecifiedCurve
//        -- specifiedCurve MUST NOT be used in PKIX
//        -- Details for specifiedCurve can be found in [X9.62]
//        -- Any future additions to this CHOICE should be coordinated
//        -- with ANSI X.9.
//     }
//     -- If you need to be able to decode ANSI X.9 parameter structures,
//     -- uncomment the implicitCurve and specifiedCurve above, and also
//     -- uncomment the following:
//     --(WITH COMPONENTS {namedCurve PRESENT})
//
// The namedCurves are extensible. The ones described by RFC 5912 are:
//
//     NamedCurve CURVE ::= {
//     { ID secp192r1 } | { ID sect163k1 } | { ID sect163r2 } |
//     { ID secp224r1 } | { ID sect233k1 } | { ID sect233r1 } |
//     { ID secp256r1 } | { ID sect283k1 } | { ID sect283r1 } |
//     { ID secp384r1 } | { ID sect409k1 } | { ID sect409r1 } |
//     { ID secp521r1 } | { ID sect571k1 } | { ID sect571r1 },
//     ... -- Extensible
//     }
bool ParsePublicKey(der::Input public_key_spki,
                    bssl::UniquePtr<EVP_PKEY> *public_key) {
  // Parse the SPKI to an EVP_PKEY.
  OpenSSLErrStackTracer err_tracer;
  const EVP_PKEY_ALG *const algs[] = {
      EVP_pkey_rsa(),
      EVP_pkey_ec_p256(),
      EVP_pkey_ec_p384(),
      // TODO(davidben): Remove P-521 from here, or let callers configure this.
      // We don't advertise it in TLS.
      EVP_pkey_ec_p521(),
  };
  public_key->reset(EVP_PKEY_from_subject_public_key_info(
      public_key_spki.data(), public_key_spki.size(), algs, std::size(algs)));
  return *public_key != nullptr;
}

bool VerifySignedData(SignatureAlgorithm algorithm, der::Input signed_data,
                      const der::BitString &signature_value,
                      EVP_PKEY *public_key, SignatureVerifyCache *cache) {
  int expected_pkey_id = 1;
  const EVP_MD *digest = nullptr;
  bool is_rsa_pss = false;
  std::string_view cache_algorithm_name;
  switch (algorithm) {
    case SignatureAlgorithm::kRsaPkcs1Sha1:
      expected_pkey_id = EVP_PKEY_RSA;
      digest = EVP_sha1();
      cache_algorithm_name = "RsaPkcs1Sha1";
      break;
    case SignatureAlgorithm::kRsaPkcs1Sha256:
      expected_pkey_id = EVP_PKEY_RSA;
      digest = EVP_sha256();
      cache_algorithm_name = "RsaPkcs1Sha256";
      break;
    case SignatureAlgorithm::kRsaPkcs1Sha384:
      expected_pkey_id = EVP_PKEY_RSA;
      digest = EVP_sha384();
      cache_algorithm_name = "RsaPkcs1Sha384";
      break;
    case SignatureAlgorithm::kRsaPkcs1Sha512:
      expected_pkey_id = EVP_PKEY_RSA;
      digest = EVP_sha512();
      cache_algorithm_name = "RsaPkcs1Sha512";
      break;

    case SignatureAlgorithm::kEcdsaSha1:
      expected_pkey_id = EVP_PKEY_EC;
      digest = EVP_sha1();
      cache_algorithm_name = "EcdsaSha1";
      break;
    case SignatureAlgorithm::kEcdsaSha256:
      expected_pkey_id = EVP_PKEY_EC;
      digest = EVP_sha256();
      cache_algorithm_name = "EcdsaSha256";
      break;
    case SignatureAlgorithm::kEcdsaSha384:
      expected_pkey_id = EVP_PKEY_EC;
      digest = EVP_sha384();
      cache_algorithm_name = "EcdsaSha384";
      break;
    case SignatureAlgorithm::kEcdsaSha512:
      expected_pkey_id = EVP_PKEY_EC;
      digest = EVP_sha512();
      cache_algorithm_name = "EcdsaSha512";
      break;

    case SignatureAlgorithm::kRsaPssSha256:
      expected_pkey_id = EVP_PKEY_RSA;
      digest = EVP_sha256();
      cache_algorithm_name = "RsaPssSha256";
      is_rsa_pss = true;
      break;
    case SignatureAlgorithm::kRsaPssSha384:
      expected_pkey_id = EVP_PKEY_RSA;
      digest = EVP_sha384();
      cache_algorithm_name = "RsaPssSha384";
      is_rsa_pss = true;
      break;
    case SignatureAlgorithm::kRsaPssSha512:
      expected_pkey_id = EVP_PKEY_RSA;
      digest = EVP_sha512();
      cache_algorithm_name = "RsaPssSha512";
      is_rsa_pss = true;
      break;
  }

  if (expected_pkey_id != EVP_PKEY_id(public_key)) {
    return false;
  }

  // For the supported algorithms the signature value must be a whole
  // number of bytes.
  if (signature_value.unused_bits() != 0) {
    return false;
  }
  der::Input signature_value_bytes = signature_value.bytes();

  std::string cache_key;
  if (cache) {
    cache_key = SignatureVerifyCacheKey(cache_algorithm_name, signed_data,
                                        signature_value_bytes, public_key);
    if (!cache_key.empty()) {
      switch (cache->Check(cache_key)) {
        case SignatureVerifyCache::Value::kValid:
          return true;
        case SignatureVerifyCache::Value::kInvalid:
          return false;
        case SignatureVerifyCache::Value::kUnknown:
          break;
      }
    }
  }

  OpenSSLErrStackTracer err_tracer;

  bssl::ScopedEVP_MD_CTX ctx;
  EVP_PKEY_CTX *pctx = nullptr;  // Owned by |ctx|.

  if (!EVP_DigestVerifyInit(ctx.get(), &pctx, digest, nullptr, public_key)) {
    return false;
  }

  if (is_rsa_pss) {
    // All supported RSASSA-PSS algorithms match signing and MGF-1 digest. They
    // also use the digest length as the salt length, which is specified with -1
    // in OpenSSL's API.
    if (!EVP_PKEY_CTX_set_rsa_padding(pctx, RSA_PKCS1_PSS_PADDING) ||
        !EVP_PKEY_CTX_set_rsa_pss_saltlen(pctx, RSA_PSS_SALTLEN_DIGEST)) {
      return false;
    }
  }

  bool ret = 1 == EVP_DigestVerify(ctx.get(), signature_value_bytes.data(),
                                   signature_value_bytes.size(),
                                   signed_data.data(), signed_data.size());
  if (!cache_key.empty()) {
    cache->Store(cache_key, ret ? SignatureVerifyCache::Value::kValid
                                : SignatureVerifyCache::Value::kInvalid);
  }

  return ret;
}

bool VerifySignedData(SignatureAlgorithm algorithm, der::Input signed_data,
                      const der::BitString &signature_value,
                      der::Input public_key_spki, SignatureVerifyCache *cache) {
  bssl::UniquePtr<EVP_PKEY> public_key;
  if (!ParsePublicKey(public_key_spki, &public_key)) {
    return false;
  }
  return VerifySignedData(algorithm, signed_data, signature_value,
                          public_key.get(), cache);
}

BSSL_NAMESPACE_END
