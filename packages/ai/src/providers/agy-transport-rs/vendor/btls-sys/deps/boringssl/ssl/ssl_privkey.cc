// Copyright 1995-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/ssl.h>

#include <assert.h>
#include <limits.h>

#include <algorithm>

#include <openssl/ec.h>
#include <openssl/ec_key.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/mem.h>
#include <openssl/span.h>

#include "../crypto/internal.h"
#include "internal.h"


BSSL_NAMESPACE_BEGIN

bool ssl_is_key_type_supported(int key_type) {
  return key_type == EVP_PKEY_RSA || key_type == EVP_PKEY_EC ||
         key_type == EVP_PKEY_ED25519;
}

typedef struct {
  uint16_t sigalg;
  int pkey_type;
  int curve;
  const EVP_MD *(*digest_func)(void);
  bool is_rsa_pss;
  bool tls12_ok;
  bool tls13_ok;
  bool client_only;
} SSL_SIGNATURE_ALGORITHM;

static const SSL_SIGNATURE_ALGORITHM kSignatureAlgorithms[] = {
    // PKCS#1 v1.5 code points are only allowed in TLS 1.2.
    {SSL_SIGN_RSA_PKCS1_MD5_SHA1, EVP_PKEY_RSA, NID_undef, &EVP_md5_sha1,
     /*is_rsa_pss=*/false, /*tls12_ok=*/true, /*tls13_ok=*/false,
     /*client_only=*/false},
    {SSL_SIGN_RSA_PKCS1_SHA1, EVP_PKEY_RSA, NID_undef, &EVP_sha1,
     /*is_rsa_pss=*/false, /*tls12_ok=*/true, /*tls13_ok=*/false,
     /*client_only=*/false},
    {SSL_SIGN_RSA_PKCS1_SHA256, EVP_PKEY_RSA, NID_undef, &EVP_sha256,
     /*is_rsa_pss=*/false, /*tls12_ok=*/true, /*tls13_ok=*/false,
     /*client_only=*/false},
    {SSL_SIGN_RSA_PKCS1_SHA384, EVP_PKEY_RSA, NID_undef, &EVP_sha384,
     /*is_rsa_pss=*/false, /*tls12_ok=*/true, /*tls13_ok=*/false,
     /*client_only=*/false},
    {SSL_SIGN_RSA_PKCS1_SHA512, EVP_PKEY_RSA, NID_undef, &EVP_sha512,
     /*is_rsa_pss=*/false, /*tls12_ok=*/true, /*tls13_ok=*/false,
     /*client_only=*/false},

    // Legacy PKCS#1 v1.5 code points are only allowed in TLS 1.3 and
    // client-only. See draft-ietf-tls-tls13-pkcs1-00.
    {SSL_SIGN_RSA_PKCS1_SHA256_LEGACY, EVP_PKEY_RSA, NID_undef, &EVP_sha256,
     /*is_rsa_pss=*/false, /*tls12_ok=*/false, /*tls13_ok=*/true,
     /*client_only=*/true},

    {SSL_SIGN_RSA_PSS_RSAE_SHA256, EVP_PKEY_RSA, NID_undef, &EVP_sha256,
     /*is_rsa_pss=*/true, /*tls12_ok=*/true, /*tls13_ok=*/true,
     /*client_only=*/false},
    {SSL_SIGN_RSA_PSS_RSAE_SHA384, EVP_PKEY_RSA, NID_undef, &EVP_sha384,
     /*is_rsa_pss=*/true, /*tls12_ok=*/true, /*tls13_ok=*/true,
     /*client_only=*/false},
    {SSL_SIGN_RSA_PSS_RSAE_SHA512, EVP_PKEY_RSA, NID_undef, &EVP_sha512,
     /*is_rsa_pss=*/true, /*tls12_ok=*/true, /*tls13_ok=*/true,
     /*client_only=*/false},

    {SSL_SIGN_ECDSA_SHA1, EVP_PKEY_EC, NID_undef, &EVP_sha1,
     /*is_rsa_pss=*/false, /*tls12_ok=*/true, /*tls13_ok=*/false,
     /*client_only=*/false},
    {SSL_SIGN_ECDSA_SECP256R1_SHA256, EVP_PKEY_EC, NID_X9_62_prime256v1,
     &EVP_sha256, /*is_rsa_pss=*/false, /*tls12_ok=*/true, /*tls13_ok=*/true,
     /*client_only=*/false},
    {SSL_SIGN_ECDSA_SECP384R1_SHA384, EVP_PKEY_EC, NID_secp384r1, &EVP_sha384,
     /*is_rsa_pss=*/false, /*tls12_ok=*/true, /*tls13_ok=*/true,
     /*client_only=*/false},
    {SSL_SIGN_ECDSA_SECP521R1_SHA512, EVP_PKEY_EC, NID_secp521r1, &EVP_sha512,
     /*is_rsa_pss=*/false, /*tls12_ok=*/true, /*tls13_ok=*/true,
     /*client_only=*/false},

    {SSL_SIGN_ED25519, EVP_PKEY_ED25519, NID_undef, nullptr,
     /*is_rsa_pss=*/false, /*tls12_ok=*/true, /*tls13_ok=*/true,
     /*client_only=*/false},
};

static const SSL_SIGNATURE_ALGORITHM *get_signature_algorithm(uint16_t sigalg) {
  for (const auto &alg : kSignatureAlgorithms) {
    if (alg.sigalg == sigalg) {
      return &alg;
    }
  }
  return nullptr;
}

bssl::UniquePtr<EVP_PKEY> ssl_parse_peer_subject_public_key_info(
    Span<const uint8_t> spki) {
  // Ideally the set of reachable algorithms would flow from |SSL_CTX| for dead
  // code elimination, but for now we just specify every algorithm that might be
  // reachable from libssl.
  const EVP_PKEY_ALG *const algs[] = {
      EVP_pkey_rsa(),     EVP_pkey_ec_p256(), EVP_pkey_ec_p384(),
      EVP_pkey_ec_p521(), EVP_pkey_ed25519(),
  };
  return bssl::UniquePtr<EVP_PKEY>(EVP_PKEY_from_subject_public_key_info(
      spki.data(), spki.size(), algs, std::size(algs)));
}

bool ssl_pkey_supports_algorithm(const SSL *ssl, EVP_PKEY *pkey,
                                 uint16_t sigalg, bool is_verify) {
  const SSL_SIGNATURE_ALGORITHM *alg = get_signature_algorithm(sigalg);
  if (alg == nullptr || EVP_PKEY_id(pkey) != alg->pkey_type) {
    return false;
  }

  // Ensure the RSA key is large enough for the hash. RSASSA-PSS requires that
  // emLen be at least hLen + sLen + 2. Both hLen and sLen are the size of the
  // hash in TLS. Reasonable RSA key sizes are large enough for the largest
  // defined RSASSA-PSS algorithm, but 1024-bit RSA is slightly too small for
  // SHA-512. 1024-bit RSA is sometimes used for test credentials, so check the
  // size so that we can fall back to another algorithm in that case.
  if (alg->is_rsa_pss &&
      (size_t)EVP_PKEY_size(pkey) < 2 * EVP_MD_size(alg->digest_func()) + 2) {
    return false;
  }

  if (ssl_protocol_version(ssl) < TLS1_2_VERSION) {
    // TLS 1.0 and 1.1 do not negotiate algorithms and always sign one of two
    // hardcoded algorithms.
    return sigalg == SSL_SIGN_RSA_PKCS1_MD5_SHA1 ||
           sigalg == SSL_SIGN_ECDSA_SHA1;
  }

  // |SSL_SIGN_RSA_PKCS1_MD5_SHA1| is not a real SignatureScheme for TLS 1.2 and
  // higher. It is an internal value we use to represent TLS 1.0/1.1's MD5/SHA1
  // concatenation.
  if (sigalg == SSL_SIGN_RSA_PKCS1_MD5_SHA1) {
    return false;
  }

  if (ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
    if (!alg->tls13_ok) {
      return false;
    }

    bool is_client_sign = ssl->server == is_verify;
    if (alg->client_only && !is_client_sign) {
      return false;
    }

    // EC keys have a curve requirement.
    if (alg->pkey_type == EVP_PKEY_EC &&
        (alg->curve == NID_undef ||
         EVP_PKEY_get_ec_curve_nid(pkey) != alg->curve)) {
      return false;
    }
  } else if (!alg->tls12_ok) {
    return false;
  }

  return true;
}

static bool setup_ctx(SSL *ssl, EVP_MD_CTX *ctx, EVP_PKEY *pkey,
                      uint16_t sigalg, bool is_verify) {
  if (!ssl_pkey_supports_algorithm(ssl, pkey, sigalg, is_verify)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_WRONG_SIGNATURE_TYPE);
    return false;
  }

  const SSL_SIGNATURE_ALGORITHM *alg = get_signature_algorithm(sigalg);
  const EVP_MD *digest =
      alg->digest_func != nullptr ? alg->digest_func() : nullptr;
  EVP_PKEY_CTX *pctx;
  if (is_verify) {
    if (!EVP_DigestVerifyInit(ctx, &pctx, digest, nullptr, pkey)) {
      return false;
    }
  } else if (!EVP_DigestSignInit(ctx, &pctx, digest, nullptr, pkey)) {
    return false;
  }

  if (alg->is_rsa_pss) {
    if (!EVP_PKEY_CTX_set_rsa_padding(pctx, RSA_PKCS1_PSS_PADDING) ||
        !EVP_PKEY_CTX_set_rsa_pss_saltlen(pctx, RSA_PSS_SALTLEN_DIGEST)) {
      return false;
    }
  }

  return true;
}

enum ssl_private_key_result_t ssl_private_key_sign(
    SSL_HANDSHAKE *hs, uint8_t *out, size_t *out_len, size_t max_out,
    uint16_t sigalg, Span<const uint8_t> in) {
  SSL *const ssl = hs->ssl;
  const SSL_CREDENTIAL *const cred = hs->credential.get();
  SSL_HANDSHAKE_HINTS *const hints = hs->hints.get();
  Array<uint8_t> spki;
  if (hints) {
    ScopedCBB spki_cbb;
    if (!CBB_init(spki_cbb.get(), 64) ||
        !EVP_marshal_public_key(spki_cbb.get(), cred->pubkey.get()) ||
        !CBBFinishArray(spki_cbb.get(), &spki)) {
      ssl_send_alert(ssl, SSL3_AL_FATAL, SSL_AD_INTERNAL_ERROR);
      return ssl_private_key_failure;
    }
  }

  // Replay the signature from handshake hints if available.
  if (hints && !hs->hints_requested &&         //
      sigalg == hints->signature_algorithm &&  //
      in == hints->signature_input &&          //
      Span(spki) == hints->signature_spki &&   //
      !hints->signature.empty() &&             //
      hints->signature.size() <= max_out) {
    // Signature algorithm and input both match. Reuse the signature from hints.
    *out_len = hints->signature.size();
    OPENSSL_memcpy(out, hints->signature.data(), hints->signature.size());
    return ssl_private_key_success;
  }

  const SSL_PRIVATE_KEY_METHOD *key_method = cred->key_method;
  EVP_PKEY *privkey = cred->privkey.get();
  assert(!hs->can_release_private_key);

  if (key_method != nullptr) {
    enum ssl_private_key_result_t ret;
    if (hs->pending_private_key_op) {
      ret = key_method->complete(ssl, out, out_len, max_out);
    } else {
      ret = key_method->sign(ssl, out, out_len, max_out, sigalg, in.data(),
                             in.size());
    }
    if (ret == ssl_private_key_failure) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_PRIVATE_KEY_OPERATION_FAILED);
    }
    hs->pending_private_key_op = ret == ssl_private_key_retry;
    if (ret != ssl_private_key_success) {
      return ret;
    }
  } else {
    *out_len = max_out;
    ScopedEVP_MD_CTX ctx;
    if (!setup_ctx(ssl, ctx.get(), privkey, sigalg, false /* sign */) ||
        !EVP_DigestSign(ctx.get(), out, out_len, in.data(), in.size())) {
      return ssl_private_key_failure;
    }
  }

  // Save the hint if applicable.
  if (hints && hs->hints_requested) {
    hints->signature_algorithm = sigalg;
    hints->signature_spki = std::move(spki);
    if (!hints->signature_input.CopyFrom(in) ||
        !hints->signature.CopyFrom(Span(out, *out_len))) {
      return ssl_private_key_failure;
    }
  }
  return ssl_private_key_success;
}

bool ssl_public_key_verify(SSL *ssl, Span<const uint8_t> signature,
                           uint16_t sigalg, EVP_PKEY *pkey,
                           Span<const uint8_t> in) {
  ScopedEVP_MD_CTX ctx;
  if (!setup_ctx(ssl, ctx.get(), pkey, sigalg, true /* verify */)) {
    return false;
  }
  bool ok = EVP_DigestVerify(ctx.get(), signature.data(), signature.size(),
                             in.data(), in.size());
  if (CRYPTO_fuzzer_mode_enabled()) {
    ok = true;
    ERR_clear_error();
  }
  return ok;
}

enum ssl_private_key_result_t ssl_private_key_decrypt(SSL_HANDSHAKE *hs,
                                                      uint8_t *out,
                                                      size_t *out_len,
                                                      size_t max_out,
                                                      Span<const uint8_t> in) {
  SSL *const ssl = hs->ssl;
  const SSL_CREDENTIAL *const cred = hs->credential.get();
  assert(!hs->can_release_private_key);
  if (cred->key_method != nullptr) {
    enum ssl_private_key_result_t ret;
    if (hs->pending_private_key_op) {
      ret = cred->key_method->complete(ssl, out, out_len, max_out);
    } else {
      ret = cred->key_method->decrypt(ssl, out, out_len, max_out, in.data(),
                                      in.size());
    }
    if (ret == ssl_private_key_failure) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_PRIVATE_KEY_OPERATION_FAILED);
    }
    hs->pending_private_key_op = ret == ssl_private_key_retry;
    return ret;
  }

  RSA *rsa = EVP_PKEY_get0_RSA(cred->privkey.get());
  if (rsa == nullptr) {
    // Decrypt operations are only supported for RSA keys.
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    return ssl_private_key_failure;
  }

  // Decrypt with no padding. PKCS#1 padding will be removed as part of the
  // timing-sensitive code by the caller.
  if (!RSA_decrypt(rsa, out_len, out, max_out, in.data(), in.size(),
                   RSA_NO_PADDING)) {
    return ssl_private_key_failure;
  }
  return ssl_private_key_success;
}

BSSL_NAMESPACE_END

using namespace bssl;

int SSL_use_RSAPrivateKey(SSL *ssl, RSA *rsa) {
  if (rsa == nullptr || ssl->config == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_PASSED_NULL_PARAMETER);
    return 0;
  }

  UniquePtr<EVP_PKEY> pkey(EVP_PKEY_new());
  if (!pkey ||  //
      !EVP_PKEY_set1_RSA(pkey.get(), rsa)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_EVP_LIB);
    return 0;
  }

  return SSL_use_PrivateKey(ssl, pkey.get());
}

int SSL_use_RSAPrivateKey_ASN1(SSL *ssl, const uint8_t *der, size_t der_len) {
  UniquePtr<RSA> rsa(RSA_private_key_from_bytes(der, der_len));
  if (!rsa) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_ASN1_LIB);
    return 0;
  }

  return SSL_use_RSAPrivateKey(ssl, rsa.get());
}

int SSL_use_PrivateKey(SSL *ssl, EVP_PKEY *pkey) {
  if (pkey == nullptr || ssl->config == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_PASSED_NULL_PARAMETER);
    return 0;
  }

  return SSL_CREDENTIAL_set1_private_key(
      ssl->config->cert->legacy_credential.get(), pkey);
}

int SSL_use_PrivateKey_ASN1(int type, SSL *ssl, const uint8_t *der,
                            size_t der_len) {
  if (der_len > LONG_MAX) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_OVERFLOW);
    return 0;
  }

  const uint8_t *p = der;
  UniquePtr<EVP_PKEY> pkey(d2i_PrivateKey(type, nullptr, &p, (long)der_len));
  if (!pkey || p != der + der_len) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_ASN1_LIB);
    return 0;
  }

  return SSL_use_PrivateKey(ssl, pkey.get());
}

int SSL_CTX_use_RSAPrivateKey(SSL_CTX *ctx, RSA *rsa) {
  if (rsa == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_PASSED_NULL_PARAMETER);
    return 0;
  }

  UniquePtr<EVP_PKEY> pkey(EVP_PKEY_new());
  if (!pkey || !EVP_PKEY_set1_RSA(pkey.get(), rsa)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_EVP_LIB);
    return 0;
  }

  return SSL_CTX_use_PrivateKey(ctx, pkey.get());
}

int SSL_CTX_use_RSAPrivateKey_ASN1(SSL_CTX *ctx, const uint8_t *der,
                                   size_t der_len) {
  UniquePtr<RSA> rsa(RSA_private_key_from_bytes(der, der_len));
  if (!rsa) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_ASN1_LIB);
    return 0;
  }

  return SSL_CTX_use_RSAPrivateKey(ctx, rsa.get());
}

int SSL_CTX_use_PrivateKey(SSL_CTX *ctx, EVP_PKEY *pkey) {
  if (pkey == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_PASSED_NULL_PARAMETER);
    return 0;
  }

  return SSL_CREDENTIAL_set1_private_key(ctx->cert->legacy_credential.get(),
                                         pkey);
}

int SSL_CTX_use_PrivateKey_ASN1(int type, SSL_CTX *ctx, const uint8_t *der,
                                size_t der_len) {
  if (der_len > LONG_MAX) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_OVERFLOW);
    return 0;
  }

  const uint8_t *p = der;
  UniquePtr<EVP_PKEY> pkey(d2i_PrivateKey(type, nullptr, &p, (long)der_len));
  if (!pkey || p != der + der_len) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_ASN1_LIB);
    return 0;
  }

  return SSL_CTX_use_PrivateKey(ctx, pkey.get());
}

void SSL_set_private_key_method(SSL *ssl,
                                const SSL_PRIVATE_KEY_METHOD *key_method) {
  if (!ssl->config) {
    return;
  }
  BSSL_CHECK(SSL_CREDENTIAL_set_private_key_method(
      ssl->config->cert->legacy_credential.get(), key_method));
}

void SSL_CTX_set_private_key_method(SSL_CTX *ctx,
                                    const SSL_PRIVATE_KEY_METHOD *key_method) {
  BSSL_CHECK(SSL_CREDENTIAL_set_private_key_method(
      ctx->cert->legacy_credential.get(), key_method));
}

static constexpr size_t kMaxSignatureAlgorithmNameLen = 24;

struct SignatureAlgorithmName {
  uint16_t signature_algorithm;
  const char name[kMaxSignatureAlgorithmNameLen];
};

// This was "constexpr" rather than "const", but that triggered a bug in MSVC
// where it didn't pad the strings to the correct length.
static const SignatureAlgorithmName kSignatureAlgorithmNames[] = {
    {SSL_SIGN_RSA_PKCS1_MD5_SHA1, "rsa_pkcs1_md5_sha1"},
    {SSL_SIGN_RSA_PKCS1_SHA1, "rsa_pkcs1_sha1"},
    {SSL_SIGN_RSA_PKCS1_SHA256, "rsa_pkcs1_sha256"},
    {SSL_SIGN_RSA_PKCS1_SHA256_LEGACY, "rsa_pkcs1_sha256_legacy"},
    {SSL_SIGN_RSA_PKCS1_SHA384, "rsa_pkcs1_sha384"},
    {SSL_SIGN_RSA_PKCS1_SHA512, "rsa_pkcs1_sha512"},
    {SSL_SIGN_ECDSA_SHA1, "ecdsa_sha1"},
    {SSL_SIGN_ECDSA_SECP256R1_SHA256, "ecdsa_secp256r1_sha256"},
    {SSL_SIGN_ECDSA_SECP384R1_SHA384, "ecdsa_secp384r1_sha384"},
    {SSL_SIGN_ECDSA_SECP521R1_SHA512, "ecdsa_secp521r1_sha512"},
    {SSL_SIGN_RSA_PSS_RSAE_SHA256, "rsa_pss_rsae_sha256"},
    {SSL_SIGN_RSA_PSS_RSAE_SHA384, "rsa_pss_rsae_sha384"},
    {SSL_SIGN_RSA_PSS_RSAE_SHA512, "rsa_pss_rsae_sha512"},
    {SSL_SIGN_ED25519, "ed25519"},
};

const char *SSL_get_signature_algorithm_name(uint16_t sigalg,
                                             int include_curve) {
  if (!include_curve) {
    switch (sigalg) {
      case SSL_SIGN_ECDSA_SECP256R1_SHA256:
        return "ecdsa_sha256";
      case SSL_SIGN_ECDSA_SECP384R1_SHA384:
        return "ecdsa_sha384";
      case SSL_SIGN_ECDSA_SECP521R1_SHA512:
        return "ecdsa_sha512";
        // If adding more here, also update
        // |SSL_get_all_signature_algorithm_names|.
    }
  }

  for (const auto &candidate : kSignatureAlgorithmNames) {
    if (candidate.signature_algorithm == sigalg) {
      return candidate.name;
    }
  }

  return nullptr;
}

size_t SSL_get_all_signature_algorithm_names(const char **out, size_t max_out) {
  const char *const kPredefinedNames[] = {"ecdsa_sha256", "ecdsa_sha384",
                                          "ecdsa_sha512"};
  return GetAllNames(out, max_out, Span(kPredefinedNames),
                     &SignatureAlgorithmName::name,
                     Span(kSignatureAlgorithmNames));
}

int SSL_get_signature_algorithm_key_type(uint16_t sigalg) {
  const SSL_SIGNATURE_ALGORITHM *alg = get_signature_algorithm(sigalg);
  return alg != nullptr ? alg->pkey_type : EVP_PKEY_NONE;
}

const EVP_MD *SSL_get_signature_algorithm_digest(uint16_t sigalg) {
  const SSL_SIGNATURE_ALGORITHM *alg = get_signature_algorithm(sigalg);
  if (alg == nullptr || alg->digest_func == nullptr) {
    return nullptr;
  }
  return alg->digest_func();
}

int SSL_is_signature_algorithm_rsa_pss(uint16_t sigalg) {
  const SSL_SIGNATURE_ALGORITHM *alg = get_signature_algorithm(sigalg);
  return alg != nullptr && alg->is_rsa_pss;
}

static bool sigalgs_unique(Span<const uint16_t> in_sigalgs) {
  if (in_sigalgs.size() < 2) {
    return true;
  }

  Array<uint16_t> sigalgs;
  if (!sigalgs.CopyFrom(in_sigalgs)) {
    return false;
  }

  std::sort(sigalgs.begin(), sigalgs.end());
  for (size_t i = 1; i < sigalgs.size(); i++) {
    if (sigalgs[i - 1] == sigalgs[i]) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_DUPLICATE_SIGNATURE_ALGORITHM);
      return false;
    }
  }

  return true;
}

static bool set_sigalg_prefs(Array<uint16_t> *out, Span<const uint16_t> prefs) {
  if (!sigalgs_unique(prefs)) {
    return false;
  }

  // Check for invalid algorithms, and filter out |SSL_SIGN_RSA_PKCS1_MD5_SHA1|.
  Array<uint16_t> filtered;
  if (!filtered.InitForOverwrite(prefs.size())) {
    return false;
  }
  size_t added = 0;
  for (uint16_t pref : prefs) {
    if (pref == SSL_SIGN_RSA_PKCS1_MD5_SHA1) {
      // Though not intended to be used with this API, we treat
      // |SSL_SIGN_RSA_PKCS1_MD5_SHA1| as a real signature algorithm in
      // |SSL_PRIVATE_KEY_METHOD|. Not accepting it here makes for a confusing
      // abstraction.
      continue;
    }
    if (get_signature_algorithm(pref) == nullptr) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_SIGNATURE_ALGORITHM);
      return false;
    }
    filtered[added] = pref;
    added++;
  }
  filtered.Shrink(added);

  // This can happen if |prefs| contained only |SSL_SIGN_RSA_PKCS1_MD5_SHA1|.
  // Leaving it empty would revert to the default, so treat this as an error
  // condition.
  if (!prefs.empty() && filtered.empty()) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_SIGNATURE_ALGORITHM);
    return false;
  }

  *out = std::move(filtered);
  return true;
}

int SSL_CREDENTIAL_set1_signing_algorithm_prefs(SSL_CREDENTIAL *cred,
                                                const uint16_t *prefs,
                                                size_t num_prefs) {
  if (!cred->UsesPrivateKey()) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return 0;
  }

  // Delegated credentials are constrained to a single algorithm, so there is no
  // need to configure this.
  if (cred->type == SSLCredentialType::kDelegated) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return 0;
  }

  return set_sigalg_prefs(&cred->sigalgs, Span(prefs, num_prefs));
}

int SSL_CTX_set_signing_algorithm_prefs(SSL_CTX *ctx, const uint16_t *prefs,
                                        size_t num_prefs) {
  return SSL_CREDENTIAL_set1_signing_algorithm_prefs(
      ctx->cert->legacy_credential.get(), prefs, num_prefs);
}

int SSL_set_signing_algorithm_prefs(SSL *ssl, const uint16_t *prefs,
                                    size_t num_prefs) {
  if (!ssl->config) {
    return 0;
  }
  return SSL_CREDENTIAL_set1_signing_algorithm_prefs(
      ssl->config->cert->legacy_credential.get(), prefs, num_prefs);
}

static constexpr struct {
  int pkey_type;
  int hash_nid;
  uint16_t signature_algorithm;
} kSignatureAlgorithmsMapping[] = {
    {EVP_PKEY_RSA, NID_sha1, SSL_SIGN_RSA_PKCS1_SHA1},
    {EVP_PKEY_RSA, NID_sha256, SSL_SIGN_RSA_PKCS1_SHA256},
    {EVP_PKEY_RSA, NID_sha384, SSL_SIGN_RSA_PKCS1_SHA384},
    {EVP_PKEY_RSA, NID_sha512, SSL_SIGN_RSA_PKCS1_SHA512},
    {EVP_PKEY_RSA_PSS, NID_sha256, SSL_SIGN_RSA_PSS_RSAE_SHA256},
    {EVP_PKEY_RSA_PSS, NID_sha384, SSL_SIGN_RSA_PSS_RSAE_SHA384},
    {EVP_PKEY_RSA_PSS, NID_sha512, SSL_SIGN_RSA_PSS_RSAE_SHA512},
    {EVP_PKEY_EC, NID_sha1, SSL_SIGN_ECDSA_SHA1},
    {EVP_PKEY_EC, NID_sha256, SSL_SIGN_ECDSA_SECP256R1_SHA256},
    {EVP_PKEY_EC, NID_sha384, SSL_SIGN_ECDSA_SECP384R1_SHA384},
    {EVP_PKEY_EC, NID_sha512, SSL_SIGN_ECDSA_SECP521R1_SHA512},
    {EVP_PKEY_ED25519, NID_undef, SSL_SIGN_ED25519},
};

static bool parse_sigalg_pairs(Array<uint16_t> *out, const int *values,
                               size_t num_values) {
  if ((num_values & 1) == 1) {
    return false;
  }

  const size_t num_pairs = num_values / 2;
  if (!out->InitForOverwrite(num_pairs)) {
    return false;
  }

  for (size_t i = 0; i < num_values; i += 2) {
    const int hash_nid = values[i];
    const int pkey_type = values[i + 1];

    bool found = false;
    for (const auto &candidate : kSignatureAlgorithmsMapping) {
      if (candidate.pkey_type == pkey_type && candidate.hash_nid == hash_nid) {
        (*out)[i / 2] = candidate.signature_algorithm;
        found = true;
        break;
      }
    }

    if (!found) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_SIGNATURE_ALGORITHM);
      ERR_add_error_dataf("unknown hash:%d pkey:%d", hash_nid, pkey_type);
      return false;
    }
  }

  return true;
}

int SSL_CTX_set1_sigalgs(SSL_CTX *ctx, const int *values, size_t num_values) {
  Array<uint16_t> sigalgs;
  if (!parse_sigalg_pairs(&sigalgs, values, num_values)) {
    return 0;
  }

  if (!SSL_CTX_set_signing_algorithm_prefs(ctx, sigalgs.data(),
                                           sigalgs.size()) ||
      !SSL_CTX_set_verify_algorithm_prefs(ctx, sigalgs.data(),
                                          sigalgs.size())) {
    return 0;
  }

  return 1;
}

int SSL_set1_sigalgs(SSL *ssl, const int *values, size_t num_values) {
  if (!ssl->config) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return 0;
  }

  Array<uint16_t> sigalgs;
  if (!parse_sigalg_pairs(&sigalgs, values, num_values)) {
    return 0;
  }

  if (!SSL_set_signing_algorithm_prefs(ssl, sigalgs.data(), sigalgs.size()) ||
      !SSL_set_verify_algorithm_prefs(ssl, sigalgs.data(), sigalgs.size())) {
    return 0;
  }

  return 1;
}

static bool parse_sigalgs_list(Array<uint16_t> *out, const char *str) {
  // str looks like "RSA+SHA1:ECDSA+SHA256:ecdsa_secp256r1_sha256".

  // Count colons to give the number of output elements from any successful
  // parse.
  size_t num_elements = 1;
  size_t len = 0;
  for (const char *p = str; *p; p++) {
    len++;
    if (*p == ':') {
      num_elements++;
    }
  }

  if (!out->InitForOverwrite(num_elements)) {
    return false;
  }
  size_t out_i = 0;

  enum {
    pkey_or_name,
    hash_name,
  } state = pkey_or_name;

  char buf[kMaxSignatureAlgorithmNameLen];
  // buf_used is always < sizeof(buf). I.e. it's always safe to write
  // buf[buf_used] = 0.
  size_t buf_used = 0;

  int pkey_type = 0, hash_nid = 0;

  // Note that the loop runs to len+1, i.e. it'll process the terminating NUL.
  for (size_t offset = 0; offset < len + 1; offset++) {
    const unsigned char c = str[offset];

    switch (c) {
      case '+':
        if (state == hash_name) {
          OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_SIGNATURE_ALGORITHM);
          ERR_add_error_dataf("+ found in hash name at offset %zu", offset);
          return false;
        }
        if (buf_used == 0) {
          OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_SIGNATURE_ALGORITHM);
          ERR_add_error_dataf("empty public key type at offset %zu", offset);
          return false;
        }
        buf[buf_used] = 0;

        if (strcmp(buf, "RSA") == 0) {
          pkey_type = EVP_PKEY_RSA;
        } else if (strcmp(buf, "RSA-PSS") == 0 ||  //
                   strcmp(buf, "PSS") == 0) {
          pkey_type = EVP_PKEY_RSA_PSS;
        } else if (strcmp(buf, "ECDSA") == 0) {
          pkey_type = EVP_PKEY_EC;
        } else {
          OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_SIGNATURE_ALGORITHM);
          ERR_add_error_dataf("unknown public key type '%s'", buf);
          return false;
        }

        state = hash_name;
        buf_used = 0;
        break;

      case ':':
        [[fallthrough]];
      case 0:
        if (buf_used == 0) {
          OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_SIGNATURE_ALGORITHM);
          ERR_add_error_dataf("empty element at offset %zu", offset);
          return false;
        }

        buf[buf_used] = 0;

        if (state == pkey_or_name) {
          // No '+' was seen thus this is a TLS 1.3-style name.
          bool found = false;
          for (const auto &candidate : kSignatureAlgorithmNames) {
            if (strcmp(candidate.name, buf) == 0) {
              assert(out_i < num_elements);
              (*out)[out_i++] = candidate.signature_algorithm;
              found = true;
              break;
            }
          }

          if (!found) {
            OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_SIGNATURE_ALGORITHM);
            ERR_add_error_dataf("unknown signature algorithm '%s'", buf);
            return false;
          }
        } else {
          if (strcmp(buf, "SHA1") == 0) {
            hash_nid = NID_sha1;
          } else if (strcmp(buf, "SHA256") == 0) {
            hash_nid = NID_sha256;
          } else if (strcmp(buf, "SHA384") == 0) {
            hash_nid = NID_sha384;
          } else if (strcmp(buf, "SHA512") == 0) {
            hash_nid = NID_sha512;
          } else {
            OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_SIGNATURE_ALGORITHM);
            ERR_add_error_dataf("unknown hash function '%s'", buf);
            return false;
          }

          bool found = false;
          for (const auto &candidate : kSignatureAlgorithmsMapping) {
            if (candidate.pkey_type == pkey_type &&
                candidate.hash_nid == hash_nid) {
              assert(out_i < num_elements);
              (*out)[out_i++] = candidate.signature_algorithm;
              found = true;
              break;
            }
          }

          if (!found) {
            OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_SIGNATURE_ALGORITHM);
            ERR_add_error_dataf("unknown pkey:%d hash:%s", pkey_type, buf);
            return false;
          }
        }

        state = pkey_or_name;
        buf_used = 0;
        break;

      default:
        if (buf_used == sizeof(buf) - 1) {
          OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_SIGNATURE_ALGORITHM);
          ERR_add_error_dataf("substring too long at offset %zu", offset);
          return false;
        }

        if (OPENSSL_isalnum(c) || c == '-' || c == '_') {
          buf[buf_used++] = c;
        } else {
          OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_SIGNATURE_ALGORITHM);
          ERR_add_error_dataf("invalid character 0x%02x at offset %zu", c,
                              offset);
          return false;
        }
    }
  }

  assert(out_i == out->size());
  return true;
}

int SSL_CTX_set1_sigalgs_list(SSL_CTX *ctx, const char *str) {
  Array<uint16_t> sigalgs;
  if (!parse_sigalgs_list(&sigalgs, str)) {
    return 0;
  }

  if (!SSL_CTX_set_signing_algorithm_prefs(ctx, sigalgs.data(),
                                           sigalgs.size()) ||
      !SSL_CTX_set_verify_algorithm_prefs(ctx, sigalgs.data(),
                                          sigalgs.size())) {
    return 0;
  }

  return 1;
}

int SSL_set1_sigalgs_list(SSL *ssl, const char *str) {
  if (!ssl->config) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return 0;
  }

  Array<uint16_t> sigalgs;
  if (!parse_sigalgs_list(&sigalgs, str)) {
    return 0;
  }

  if (!SSL_set_signing_algorithm_prefs(ssl, sigalgs.data(), sigalgs.size()) ||
      !SSL_set_verify_algorithm_prefs(ssl, sigalgs.data(), sigalgs.size())) {
    return 0;
  }

  return 1;
}

int SSL_CTX_set_verify_algorithm_prefs(SSL_CTX *ctx, const uint16_t *prefs,
                                       size_t num_prefs) {
  return set_sigalg_prefs(&ctx->verify_sigalgs, Span(prefs, num_prefs));
}

int SSL_set_verify_algorithm_prefs(SSL *ssl, const uint16_t *prefs,
                                   size_t num_prefs) {
  if (!ssl->config) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return 0;
  }

  return set_sigalg_prefs(&ssl->config->verify_sigalgs, Span(prefs, num_prefs));
}
