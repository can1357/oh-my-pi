// Copyright 2017 The BoringSSL Authors
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

#include <openssl/pkcs7.h>

#include <assert.h>
#include <limits.h>

#include <openssl/asn1.h>
#include <openssl/bytestring.h>
#include <openssl/cms.h>
#include <openssl/digest.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/pem.h>
#include <openssl/pool.h>
#include <openssl/stack.h>
#include <openssl/x509.h>

#include "../asn1/internal.h"
#include "../x509/internal.h"
#include "../internal.h"
#include "internal.h"


int PKCS7_get_certificates(STACK_OF(X509) *out_certs, CBS *cbs) {
  int ret = 0;
  const size_t initial_certs_len = sk_X509_num(out_certs);
  STACK_OF(CRYPTO_BUFFER) *raw = sk_CRYPTO_BUFFER_new_null();
  if (raw == nullptr || !PKCS7_get_raw_certificates(raw, cbs, nullptr)) {
    goto err;
  }

  for (size_t i = 0; i < sk_CRYPTO_BUFFER_num(raw); i++) {
    CRYPTO_BUFFER *buf = sk_CRYPTO_BUFFER_value(raw, i);
    X509 *x509 = X509_parse_from_buffer(buf);
    if (x509 == nullptr || !sk_X509_push(out_certs, x509)) {
      X509_free(x509);
      goto err;
    }
  }

  ret = 1;

err:
  sk_CRYPTO_BUFFER_pop_free(raw, CRYPTO_BUFFER_free);
  if (!ret) {
    while (sk_X509_num(out_certs) != initial_certs_len) {
      X509 *x509 = sk_X509_pop(out_certs);
      X509_free(x509);
    }
  }

  return ret;
}

int PKCS7_get_CRLs(STACK_OF(X509_CRL) *out_crls, CBS *cbs) {
  CBS signed_data, crls;
  uint8_t *der_bytes = nullptr;
  int ret = 0, has_crls;
  const size_t initial_crls_len = sk_X509_CRL_num(out_crls);

  // See https://tools.ietf.org/html/rfc2315#section-9.1
  if (!pkcs7_parse_header(&der_bytes, &signed_data, cbs) ||
      // Even if only CRLs are included, there may be an empty certificates
      // block. OpenSSL does this, for example.
      !CBS_get_optional_asn1(
          &signed_data, nullptr, nullptr,
          CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 0) ||
      !CBS_get_optional_asn1(
          &signed_data, &crls, &has_crls,
          CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 1)) {
    goto err;
  }

  if (!has_crls) {
    CBS_init(&crls, nullptr, 0);
  }

  while (CBS_len(&crls) > 0) {
    CBS crl_data;
    X509_CRL *crl;
    const uint8_t *inp;

    if (!CBS_get_asn1_element(&crls, &crl_data, CBS_ASN1_SEQUENCE)) {
      goto err;
    }

    if (CBS_len(&crl_data) > LONG_MAX) {
      goto err;
    }
    inp = CBS_data(&crl_data);
    crl = d2i_X509_CRL(nullptr, &inp, (long)CBS_len(&crl_data));
    if (!crl) {
      goto err;
    }

    assert(inp == CBS_data(&crl_data) + CBS_len(&crl_data));

    if (sk_X509_CRL_push(out_crls, crl) == 0) {
      X509_CRL_free(crl);
      goto err;
    }
  }

  ret = 1;

err:
  OPENSSL_free(der_bytes);

  if (!ret) {
    while (sk_X509_CRL_num(out_crls) != initial_crls_len) {
      X509_CRL_free(sk_X509_CRL_pop(out_crls));
    }
  }

  return ret;
}

int PKCS7_get_PEM_certificates(STACK_OF(X509) *out_certs, BIO *pem_bio) {
  uint8_t *data;
  long len;
  int ret;

  // Even though we pass PEM_STRING_PKCS7 as the expected PEM type here, PEM
  // internally will actually allow several other values too, including
  // "CERTIFICATE".
  if (!PEM_bytes_read_bio(&data, &len, nullptr /* PEM type output */,
                          PEM_STRING_PKCS7, pem_bio,
                          nullptr /* password callback */,
                          nullptr /* password callback argument */)) {
    return 0;
  }

  CBS cbs;
  CBS_init(&cbs, data, len);
  ret = PKCS7_get_certificates(out_certs, &cbs);
  OPENSSL_free(data);
  return ret;
}

int PKCS7_get_PEM_CRLs(STACK_OF(X509_CRL) *out_crls, BIO *pem_bio) {
  uint8_t *data;
  long len;
  int ret;

  // Even though we pass PEM_STRING_PKCS7 as the expected PEM type here, PEM
  // internally will actually allow several other values too, including
  // "CERTIFICATE".
  if (!PEM_bytes_read_bio(&data, &len, nullptr /* PEM type output */,
                          PEM_STRING_PKCS7, pem_bio,
                          nullptr /* password callback */,
                          nullptr /* password callback argument */)) {
    return 0;
  }

  CBS cbs;
  CBS_init(&cbs, data, len);
  ret = PKCS7_get_CRLs(out_crls, &cbs);
  OPENSSL_free(data);
  return ret;
}

static int pkcs7_bundle_certificates_cb(CBB *out, void *arg) {
  auto *certs = static_cast<const STACK_OF(X509) *>(arg);
  size_t i;
  CBB certificates;

  // See https://tools.ietf.org/html/rfc2315#section-9.1
  if (!CBB_add_asn1(out, &certificates,
                    CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 0)) {
    return 0;
  }

  for (i = 0; i < sk_X509_num(certs); i++) {
    X509 *x509 = sk_X509_value(certs, i);
    uint8_t *buf;
    int len = i2d_X509(x509, nullptr);

    if (len < 0 || !CBB_add_space(&certificates, &buf, len) ||
        i2d_X509(x509, &buf) < 0) {
      return 0;
    }
  }

  // |certificates| is a implicitly-tagged SET OF.
  return CBB_flush_asn1_set_of(&certificates) && CBB_flush(out);
}

int PKCS7_bundle_certificates(CBB *out, const STACK_OF(X509) *certs) {
  return pkcs7_add_signed_data(
      out, /*signed_data_version=*/1,
      /*digest_algos_cb=*/nullptr, pkcs7_bundle_certificates_cb,
      /*signer_infos_cb=*/nullptr, const_cast<STACK_OF(X509) *>(certs));
}

static int pkcs7_bundle_crls_cb(CBB *out, void *arg) {
  auto *crls = static_cast<const STACK_OF(X509_CRL) *>(arg);
  size_t i;
  CBB crl_data;

  // See https://tools.ietf.org/html/rfc2315#section-9.1
  if (!CBB_add_asn1(out, &crl_data,
                    CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 1)) {
    return 0;
  }

  for (i = 0; i < sk_X509_CRL_num(crls); i++) {
    X509_CRL *crl = sk_X509_CRL_value(crls, i);
    uint8_t *buf;
    int len = i2d_X509_CRL(crl, nullptr);

    if (len < 0 || !CBB_add_space(&crl_data, &buf, len) ||
        i2d_X509_CRL(crl, &buf) < 0) {
      return 0;
    }
  }

  // |crl_data| is a implicitly-tagged SET OF.
  return CBB_flush_asn1_set_of(&crl_data) && CBB_flush(out);
}

int PKCS7_bundle_CRLs(CBB *out, const STACK_OF(X509_CRL) *crls) {
  return pkcs7_add_signed_data(
      out, /*signed_data_version=*/1,
      /*digest_algos_cb=*/nullptr, pkcs7_bundle_crls_cb,
      /*signer_infos_cb=*/nullptr, const_cast<STACK_OF(X509_CRL) *>(crls));
}

static PKCS7 *pkcs7_new(CBS *cbs) {
  CBS copy = *cbs, copy2 = *cbs;
  PKCS7 *ret = reinterpret_cast<PKCS7 *>(OPENSSL_zalloc(sizeof(PKCS7)));
  if (ret == nullptr) {
    return nullptr;
  }
  ret->type = OBJ_nid2obj(NID_pkcs7_signed);
  ret->d.sign =
      reinterpret_cast<PKCS7_SIGNED *>(OPENSSL_malloc(sizeof(PKCS7_SIGNED)));
  if (ret->d.sign == nullptr) {
    goto err;
  }
  ret->d.sign->cert = sk_X509_new_null();
  ret->d.sign->crl = sk_X509_CRL_new_null();
  if (ret->d.sign->cert == nullptr || ret->d.sign->crl == nullptr ||
      !PKCS7_get_certificates(ret->d.sign->cert, &copy) ||
      !PKCS7_get_CRLs(ret->d.sign->crl, cbs)) {
    goto err;
  }

  if (sk_X509_num(ret->d.sign->cert) == 0) {
    sk_X509_free(ret->d.sign->cert);
    ret->d.sign->cert = nullptr;
  }

  if (sk_X509_CRL_num(ret->d.sign->crl) == 0) {
    sk_X509_CRL_free(ret->d.sign->crl);
    ret->d.sign->crl = nullptr;
  }

  ret->ber_len = CBS_len(&copy2) - CBS_len(cbs);
  ret->ber_bytes = reinterpret_cast<uint8_t *>(
      OPENSSL_memdup(CBS_data(&copy2), ret->ber_len));
  if (ret->ber_bytes == nullptr) {
    goto err;
  }

  return ret;

err:
  PKCS7_free(ret);
  return nullptr;
}

PKCS7 *d2i_PKCS7(PKCS7 **out, const uint8_t **inp, size_t len) {
  CBS cbs;
  CBS_init(&cbs, *inp, len);
  PKCS7 *ret = pkcs7_new(&cbs);
  if (ret == nullptr) {
    return nullptr;
  }
  *inp = CBS_data(&cbs);
  if (out != nullptr) {
    PKCS7_free(*out);
    *out = ret;
  }
  return ret;
}

PKCS7 *d2i_PKCS7_bio(BIO *bio, PKCS7 **out) {
  // Use a generous bound, to allow for PKCS#7 files containing large root sets.
  static const size_t kMaxSize = 4 * 1024 * 1024;
  uint8_t *data;
  size_t len;
  if (!BIO_read_asn1(bio, &data, &len, kMaxSize)) {
    return nullptr;
  }

  CBS cbs;
  CBS_init(&cbs, data, len);
  PKCS7 *ret = pkcs7_new(&cbs);
  OPENSSL_free(data);
  if (out != nullptr && ret != nullptr) {
    PKCS7_free(*out);
    *out = ret;
  }
  return ret;
}

int i2d_PKCS7(const PKCS7 *p7, uint8_t **out) {
  if (p7->ber_len > INT_MAX) {
    OPENSSL_PUT_ERROR(PKCS8, ERR_R_OVERFLOW);
    return -1;
  }

  if (out == nullptr) {
    return (int)p7->ber_len;
  }

  if (*out == nullptr) {
    *out =
        reinterpret_cast<uint8_t *>(OPENSSL_memdup(p7->ber_bytes, p7->ber_len));
    if (*out == nullptr) {
      return -1;
    }
  } else {
    OPENSSL_memcpy(*out, p7->ber_bytes, p7->ber_len);
    *out += p7->ber_len;
  }
  return (int)p7->ber_len;
}

int i2d_PKCS7_bio(BIO *bio, const PKCS7 *p7) {
  return BIO_write_all(bio, p7->ber_bytes, p7->ber_len);
}

void PKCS7_free(PKCS7 *p7) {
  if (p7 == nullptr) {
    return;
  }

  OPENSSL_free(p7->ber_bytes);
  ASN1_OBJECT_free(p7->type);
  // We only supported signed data.
  if (p7->d.sign != nullptr) {
    sk_X509_pop_free(p7->d.sign->cert, X509_free);
    sk_X509_CRL_pop_free(p7->d.sign->crl, X509_CRL_free);
    OPENSSL_free(p7->d.sign);
  }
  OPENSSL_free(p7);
}

// We only support signed data, so these getters are no-ops.
int PKCS7_type_is_data(const PKCS7 *p7) { return 0; }
int PKCS7_type_is_digest(const PKCS7 *p7) { return 0; }
int PKCS7_type_is_encrypted(const PKCS7 *p7) { return 0; }
int PKCS7_type_is_enveloped(const PKCS7 *p7) { return 0; }
int PKCS7_type_is_signed(const PKCS7 *p7) { return 1; }
int PKCS7_type_is_signedAndEnveloped(const PKCS7 *p7) { return 0; }

static bool digest_sign_update(EVP_MD_CTX *ctx, BIO *data) {
  for (;;) {
    uint8_t buf[4096];
    const int n = BIO_read(data, buf, sizeof(buf));
    if (n == 0) {
      return true;
    } else if (n < 0 || !EVP_DigestSignUpdate(ctx, buf, n)) {
      return false;
    }
  }
}

namespace {
struct signer_info_data {
  X509 *sign_cert = nullptr;
  bssl::ScopedEVP_MD_CTX sign_ctx;
  bool use_key_id = false;
};
}  // namespace

static int write_signer_digest_algos(CBB *digest_algos_set, void *arg) {
  auto *si_data = static_cast<struct signer_info_data *>(arg);
  // https://www.rfc-editor.org/rfc/rfc5754.html#section-2
  // "Implementations MUST generate SHA2 AlgorithmIdentifiers with absent
  //  parameters."
  return EVP_marshal_digest_algorithm_no_params(
      digest_algos_set, EVP_MD_CTX_get0_md(si_data->sign_ctx.get()));
}

// write_signer_info writes the SignerInfo structure from
// https://www.rfc-editor.org/rfc/rfc2315.html#section-9.2 and
// https://www.rfc-editor.org/rfc/rfc5652.html#section-5.3 to |out|. It returns
// one on success or zero on error.
static int write_signer_info(CBB *out, void *arg) {
  auto *si_data = static_cast<struct signer_info_data *>(arg);

  uint64_t version = si_data->use_key_id ? 3u : 1u;
  CBB seq, child, signing_algo, null, signature;
  if (!CBB_add_asn1(out, &seq, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1_uint64(&seq, version)) {
    return 0;
  }

  // Output the SignerIdentifier.
  if (si_data->use_key_id) {
    const ASN1_OCTET_STRING *skid =
        X509_get0_subject_key_id(si_data->sign_cert);
    if (skid == nullptr) {
      OPENSSL_PUT_ERROR(CMS, CMS_R_CERTIFICATE_HAS_NO_KEYID);
      return 0;
    }
    // subjectKeyIdentifier is implicitly-tagged.
    if (!CBB_add_asn1_element(&seq, CBS_ASN1_CONTEXT_SPECIFIC | 0,
                              ASN1_STRING_get0_data(skid),
                              ASN1_STRING_length(skid))) {
      return 0;
    }
  } else {
    if (!CBB_add_asn1(&seq, &child, CBS_ASN1_SEQUENCE) ||
        !x509_marshal_name(&child, X509_get_subject_name(si_data->sign_cert)) ||
        !asn1_marshal_integer(&child,
                              X509_get0_serialNumber(si_data->sign_cert),
                              /*tag=*/0)) {
      return 0;
    }
  }

  // Output the digest and signature algorithm. This cannot use X.509 signature
  // algorithms because CMS incorrectly decomposes signature algorithms into a
  // combination of digesting and "encrypting" the digest, then uses the plain
  // rsaEncryption OID instead of the hash-specific RSA OIDs. For now, we only
  // support RSA.
  EVP_PKEY *pkey = EVP_PKEY_CTX_get0_pkey(si_data->sign_ctx->pctx);
  if (EVP_PKEY_id(pkey) != EVP_PKEY_RSA) {
    OPENSSL_PUT_ERROR(PKCS7, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return 0;
  }
  if (!EVP_marshal_digest_algorithm_no_params(
          &seq, EVP_MD_CTX_get0_md(si_data->sign_ctx.get())) ||
      !CBB_add_asn1(&seq, &signing_algo, CBS_ASN1_SEQUENCE) ||
      !OBJ_nid2cbb(&signing_algo, NID_rsaEncryption) ||
      !CBB_add_asn1(&signing_algo, &null, CBS_ASN1_NULL)) {
    return 0;
  }

  // Output the signature.
  uint8_t *ptr;
  size_t sig_len;
  if (!EVP_DigestSignFinal(si_data->sign_ctx.get(), nullptr, &sig_len) ||
      !CBB_add_asn1(&seq, &signature, CBS_ASN1_OCTETSTRING) ||
      !CBB_reserve(&signature, &ptr, sig_len) ||
      !EVP_DigestSignFinal(si_data->sign_ctx.get(), ptr, &sig_len) ||
      !CBB_did_write(&signature, sig_len) ||  //
      !CBB_flush(out)) {
    return 0;
  }

  return 1;
}

int pkcs7_add_external_signature(CBB *out, X509 *sign_cert, EVP_PKEY *key,
                                 const EVP_MD *md, BIO *data, bool use_key_id) {
  signer_info_data si_data;
  si_data.use_key_id = use_key_id;
  si_data.sign_cert = sign_cert;

  // Set up the signature.
  if (!EVP_DigestSignInit(si_data.sign_ctx.get(), nullptr, md, nullptr, key) ||
      !digest_sign_update(si_data.sign_ctx.get(), data)) {
    return 0;
  }

  // See RFC 5652, Section 5.1. When no certificates are present, the version
  // comes from the highest SignerInfo version, which will be 3 (CMS) for a key
  // ID, and 1 (CMS or PKCS#7) for issuer and serial.
  uint64_t signed_data_version = use_key_id ? 3u : 1u;
  return pkcs7_add_signed_data(
      out, signed_data_version, write_signer_digest_algos,
      /*cert_crl_cb=*/nullptr, write_signer_info, &si_data);
}

PKCS7 *PKCS7_sign(X509 *sign_cert, EVP_PKEY *pkey, STACK_OF(X509) *certs,
                  BIO *data, int flags) {
  bssl::ScopedCBB cbb;
  if (!CBB_init(cbb.get(), 2048)) {
    return nullptr;
  }

  if (sign_cert == nullptr && pkey == nullptr && flags == PKCS7_DETACHED) {
    // Caller just wants to bundle certificates.
    if (!PKCS7_bundle_certificates(cbb.get(), certs)) {
      return nullptr;
    }
  } else if (sign_cert != nullptr && pkey != nullptr && certs == nullptr &&
             data != nullptr &&
             flags == (PKCS7_NOATTR | PKCS7_BINARY | PKCS7_NOCERTS |
                       PKCS7_DETACHED)) {
    // In OpenSSL, this API signs with some default hash. That default has been
    // SHA-256 since 2015.
    if (!pkcs7_add_external_signature(cbb.get(), sign_cert, pkey, EVP_sha256(),
                                      data, /*use_key_id=*/false)) {
      return nullptr;
    }
  } else {
    OPENSSL_PUT_ERROR(PKCS7, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return nullptr;
  }

  CBS cbs;
  CBS_init(&cbs, CBB_data(cbb.get()), CBB_len(cbb.get()));
  return pkcs7_new(&cbs);
}
