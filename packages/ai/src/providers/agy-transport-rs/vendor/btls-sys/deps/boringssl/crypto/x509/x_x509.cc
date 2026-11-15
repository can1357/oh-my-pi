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

#include <assert.h>
#include <limits.h>
#include <stdio.h>

#include <openssl/asn1.h>
#include <openssl/asn1t.h>
#include <openssl/bytestring.h>
#include <openssl/evp.h>
#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/pool.h>
#include <openssl/x509.h>

#include "../asn1/internal.h"
#include "../bytestring/internal.h"
#include "../evp/internal.h"
#include "../internal.h"
#include "internal.h"

static CRYPTO_EX_DATA_CLASS g_ex_data_class = CRYPTO_EX_DATA_CLASS_INIT;

static constexpr CBS_ASN1_TAG kVersionTag =
    CBS_ASN1_CONSTRUCTED | CBS_ASN1_CONTEXT_SPECIFIC | 0;
static constexpr CBS_ASN1_TAG kIssuerUIDTag = CBS_ASN1_CONTEXT_SPECIFIC | 1;
static constexpr CBS_ASN1_TAG kSubjectUIDTag = CBS_ASN1_CONTEXT_SPECIFIC | 2;
static constexpr CBS_ASN1_TAG kExtensionsTag =
    CBS_ASN1_CONSTRUCTED | CBS_ASN1_CONTEXT_SPECIFIC | 3;

X509 *X509_new(void) {
  bssl::UniquePtr<X509> ret(
      reinterpret_cast<X509 *>(OPENSSL_zalloc(sizeof(X509))));
  if (ret == nullptr) {
    return nullptr;
  }

  ret->references = 1;
  ret->ex_pathlen = -1;
  ret->version = X509_VERSION_1;
  asn1_string_init(&ret->serialNumber, V_ASN1_INTEGER);
  x509_algor_init(&ret->tbs_sig_alg);
  x509_name_init(&ret->issuer);
  asn1_string_init(&ret->notBefore, -1);
  asn1_string_init(&ret->notAfter, -1);
  x509_name_init(&ret->subject);
  x509_pubkey_init(&ret->key);
  x509_algor_init(&ret->sig_alg);
  asn1_string_init(&ret->signature, V_ASN1_BIT_STRING);
  CRYPTO_new_ex_data(&ret->ex_data);
  CRYPTO_MUTEX_init(&ret->lock);
  return ret.release();
}

void X509_free(X509 *x509) {
  if (x509 == nullptr ||
      !CRYPTO_refcount_dec_and_test_zero(&x509->references)) {
    return;
  }

  CRYPTO_free_ex_data(&g_ex_data_class, &x509->ex_data);

  asn1_string_cleanup(&x509->serialNumber);
  x509_algor_cleanup(&x509->tbs_sig_alg);
  x509_name_cleanup(&x509->issuer);
  asn1_string_cleanup(&x509->notBefore);
  asn1_string_cleanup(&x509->notAfter);
  x509_name_cleanup(&x509->subject);
  x509_pubkey_cleanup(&x509->key);
  ASN1_BIT_STRING_free(x509->issuerUID);
  ASN1_BIT_STRING_free(x509->subjectUID);
  sk_X509_EXTENSION_pop_free(x509->extensions, X509_EXTENSION_free);
  x509_algor_cleanup(&x509->sig_alg);
  asn1_string_cleanup(&x509->signature);
  CRYPTO_BUFFER_free(x509->buf);
  ASN1_OCTET_STRING_free(x509->skid);
  AUTHORITY_KEYID_free(x509->akid);
  CRL_DIST_POINTS_free(x509->crldp);
  GENERAL_NAMES_free(x509->altname);
  NAME_CONSTRAINTS_free(x509->nc);
  X509_CERT_AUX_free(x509->aux);
  CRYPTO_MUTEX_cleanup(&x509->lock);

  OPENSSL_free(x509);
}

X509 *X509_parse_with_algorithms(CRYPTO_BUFFER *buf,
                                 const EVP_PKEY_ALG *const *algs,
                                 size_t num_algs) {
  bssl::UniquePtr<X509> ret(X509_new());
  if (ret == nullptr) {
    return nullptr;
  }

  // Save the buffer to cache the original encoding.
  ret->buf = bssl::UpRef(buf).release();

  // Parse the Certificate.
  CBS cbs, cert, tbs;
  CRYPTO_BUFFER_init_CBS(buf, &cbs);
  if (!CBS_get_asn1(&cbs, &cert, CBS_ASN1_SEQUENCE) ||  //
      CBS_len(&cbs) != 0 ||
      // Bound the length to comfortably fit in an int. Lengths in this
      // module often omit overflow checks.
      CBS_len(&cert) > INT_MAX / 2 ||
      !CBS_get_asn1(&cert, &tbs, CBS_ASN1_SEQUENCE) ||
      !x509_parse_algorithm(&cert, &ret->sig_alg) ||
      // For just the signature field, we accept non-minimal BER lengths, though
      // not indefinite-length encoding. See b/18228011.
      //
      // TODO(crbug.com/boringssl/354): Switch the affected callers to convert
      // the certificate before parsing and then remove this workaround.
      !asn1_parse_bit_string_with_bad_length(&cert, &ret->signature) ||
      CBS_len(&cert) != 0) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return nullptr;
  }

  // Parse the TBSCertificate.
  if (CBS_peek_asn1_tag(&tbs, kVersionTag)) {
    CBS wrapper;
    uint64_t version;
    if (!CBS_get_asn1(&tbs, &wrapper, kVersionTag) ||
        !CBS_get_asn1_uint64(&wrapper, &version) ||  //
        CBS_len(&wrapper) != 0) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
      return nullptr;
    }
    // The version must be one of v1(0), v2(1), or v3(2).
    // TODO(https://crbug.com/42290225): Also reject |X509_VERSION_1|. v1 is
    // DEFAULT, so DER requires it be omitted.
    if (version != X509_VERSION_1 && version != X509_VERSION_2 &&
        version != X509_VERSION_3) {
      OPENSSL_PUT_ERROR(X509, X509_R_INVALID_VERSION);
      return nullptr;
    }
    ret->version = static_cast<uint8_t>(version);
  } else {
    ret->version = X509_VERSION_1;
  }
  CBS validity;
  if (!asn1_parse_integer(&tbs, &ret->serialNumber, /*tag=*/0) ||
      !x509_parse_algorithm(&tbs, &ret->tbs_sig_alg) ||
      !x509_parse_name(&tbs, &ret->issuer) ||
      !CBS_get_asn1(&tbs, &validity, CBS_ASN1_SEQUENCE) ||
      !asn1_parse_time(&validity, &ret->notBefore,
                       /*allow_utc_timezone_offset=*/1) ||
      !asn1_parse_time(&validity, &ret->notAfter,
                       /*allow_utc_timezone_offset=*/1) ||
      CBS_len(&validity) != 0 ||  //
      !x509_parse_name(&tbs, &ret->subject) ||
      !x509_parse_public_key(&tbs, &ret->key, bssl::Span(algs, num_algs))) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return nullptr;
  }
  // Per RFC 5280, section 4.1.2.8, these fields require v2 or v3:
  if (ret->version >= X509_VERSION_2 &&
      CBS_peek_asn1_tag(&tbs, kIssuerUIDTag)) {
    ret->issuerUID = ASN1_BIT_STRING_new();
    if (ret->issuerUID == nullptr ||
        !asn1_parse_bit_string(&tbs, ret->issuerUID, kIssuerUIDTag)) {
      return nullptr;
    }
  }
  if (ret->version >= X509_VERSION_2 &&
      CBS_peek_asn1_tag(&tbs, kSubjectUIDTag)) {
    ret->subjectUID = ASN1_BIT_STRING_new();
    if (ret->subjectUID == nullptr ||
        !asn1_parse_bit_string(&tbs, ret->subjectUID, kSubjectUIDTag)) {
      return nullptr;
    }
  }
  // Per RFC 5280, section 4.1.2.9, extensions require v3:
  if (ret->version >= X509_VERSION_3 &&
      CBS_peek_asn1_tag(&tbs, kExtensionsTag)) {
    CBS wrapper;
    if (!CBS_get_asn1(&tbs, &wrapper, kExtensionsTag)) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
      return nullptr;
    }
    // TODO(crbug.com/442221114, crbug.com/42290219): Empty extension lists
    // should be rejected. Extensions is a SEQUENCE SIZE (1..MAX), so it cannot
    // be empty. An empty extensions list is encoded by omitting the OPTIONAL
    // field. libpki already rejects this.
    const uint8_t *p = CBS_data(&wrapper);
    ret->extensions = d2i_X509_EXTENSIONS(nullptr, &p, CBS_len(&wrapper));
    if (ret->extensions == nullptr ||
        p != CBS_data(&wrapper) + CBS_len(&wrapper)) {
      OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
      return nullptr;
    }
  }
  if (CBS_len(&tbs) != 0) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return nullptr;
  }

  return ret.release();
}

X509 *X509_parse_from_buffer(CRYPTO_BUFFER *buf) {
  auto algs = bssl::GetDefaultEVPAlgorithms();
  return X509_parse_with_algorithms(buf, algs.data(), algs.size());
}

static bssl::UniquePtr<X509> x509_parse(CBS *cbs) {
  CBS cert;
  if (!CBS_get_asn1_element(cbs, &cert, CBS_ASN1_SEQUENCE)) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return nullptr;
  }

  bssl::UniquePtr<CRYPTO_BUFFER> buf(CRYPTO_BUFFER_new_from_CBS(&cert, nullptr));
  if (buf == nullptr) {
    return nullptr;
  }
  return bssl::UniquePtr<X509>(X509_parse_from_buffer(buf.get()));
}

int x509_marshal_tbs_cert(CBB *cbb, const X509 *x509) {
  if (x509->buf != nullptr) {
    // Replay the saved TBSCertificate from the |CRYPTO_BUFFER|, to verify
    // exactly what we parsed. The |CRYPTO_BUFFER| contains the full
    // Certificate, so we need to find the TBSCertificate portion.
    CBS cbs, cert, tbs;
    CRYPTO_BUFFER_init_CBS(x509->buf, &cbs);
    if (!CBS_get_asn1(&cbs, &cert, CBS_ASN1_SEQUENCE) ||
        !CBS_get_asn1_element(&cert, &tbs, CBS_ASN1_SEQUENCE)) {
      // This should be impossible.
      OPENSSL_PUT_ERROR(X509, ERR_R_INTERNAL_ERROR);
      return 0;
    }
    return CBB_add_bytes(cbb, CBS_data(&tbs), CBS_len(&tbs));
  }

  // No saved TBSCertificate encoding. Encode it anew.
  CBB tbs, version, validity, extensions;
  if (!CBB_add_asn1(cbb, &tbs, CBS_ASN1_SEQUENCE)) {
    return 0;
  }
  if (x509->version != X509_VERSION_1) {
    if (!CBB_add_asn1(&tbs, &version, kVersionTag) ||
        !CBB_add_asn1_uint64(&version, x509->version)) {
      return 0;
    }
  }
  if (!asn1_marshal_integer(&tbs, &x509->serialNumber, /*tag=*/0) ||
      !x509_marshal_algorithm(&tbs, &x509->tbs_sig_alg) ||
      !x509_marshal_name(&tbs, &x509->issuer) ||
      !CBB_add_asn1(&tbs, &validity, CBS_ASN1_SEQUENCE) ||
      !asn1_marshal_time(&validity, &x509->notBefore) ||
      !asn1_marshal_time(&validity, &x509->notAfter) ||
      !x509_marshal_name(&tbs, &x509->subject) ||
      !x509_marshal_public_key(&tbs, &x509->key) ||
      (x509->issuerUID != nullptr &&
       !asn1_marshal_bit_string(&tbs, x509->issuerUID, kIssuerUIDTag)) ||
      (x509->subjectUID != nullptr &&
       !asn1_marshal_bit_string(&tbs, x509->subjectUID, kSubjectUIDTag))) {
    return 0;
  }
  if (x509->extensions != nullptr) {
    int len = i2d_X509_EXTENSIONS(x509->extensions, nullptr);
    uint8_t *out;
    if (len <= 0 ||  //
        !CBB_add_asn1(&tbs, &extensions, kExtensionsTag) ||
        !CBB_add_space(&extensions, &out, len) ||
        i2d_X509_EXTENSIONS(x509->extensions, &out) != len) {
      return 0;
    }
  }
  return CBB_flush(cbb);
}

static int x509_marshal(CBB *cbb, const X509 *x509) {
  CBB cert;
  return CBB_add_asn1(cbb, &cert, CBS_ASN1_SEQUENCE) &&
         x509_marshal_tbs_cert(&cert, x509) &&
         x509_marshal_algorithm(&cert, &x509->sig_alg) &&
         asn1_marshal_bit_string(&cert, &x509->signature, /*tag=*/0) &&
         CBB_flush(cbb);
}

X509 *d2i_X509(X509 **out, const uint8_t **inp, long len) {
  return bssl::D2IFromCBS(out, inp, len, x509_parse);
}

int i2d_X509(const X509 *x509, uint8_t **outp) {
  if (x509 == nullptr) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_MISSING_VALUE);
    return -1;
  }

  return bssl::I2DFromCBB(
      /*initial_capacity=*/256, outp,
      [&](CBB *cbb) -> bool { return x509_marshal(cbb, x509); });
}

static int x509_new_cb(ASN1_VALUE **pval, const ASN1_ITEM *it) {
  *pval = (ASN1_VALUE *)X509_new();
  return *pval != nullptr;
}

static void x509_free_cb(ASN1_VALUE **pval, const ASN1_ITEM *it) {
  X509_free((X509 *)*pval);
  *pval = nullptr;
}

static int x509_parse_cb(ASN1_VALUE **pval, CBS *cbs, const ASN1_ITEM *it,
                         int opt) {
  if (opt && !CBS_peek_asn1_tag(cbs, CBS_ASN1_SEQUENCE)) {
    return 1;
  }

  bssl::UniquePtr<X509> ret = x509_parse(cbs);
  if (ret == nullptr) {
    return 0;
  }

  X509_free((X509 *)*pval);
  *pval = (ASN1_VALUE *)ret.release();
  return 1;
}

static int x509_i2d_cb(ASN1_VALUE **pval, unsigned char **out,
                       const ASN1_ITEM *it) {
  return i2d_X509((X509 *)*pval, out);
}

static const ASN1_EXTERN_FUNCS x509_extern_funcs = {x509_new_cb, x509_free_cb,
                                                    x509_parse_cb, x509_i2d_cb};
IMPLEMENT_EXTERN_ASN1(X509, x509_extern_funcs)

X509 *X509_dup(const X509 *x509) {
  uint8_t *der = nullptr;
  int len = i2d_X509(x509, &der);
  if (len < 0) {
    return nullptr;
  }

  const uint8_t *inp = der;
  X509 *ret = d2i_X509(nullptr, &inp, len);
  OPENSSL_free(der);
  return ret;
}

int X509_up_ref(X509 *x) {
  CRYPTO_refcount_inc(&x->references);
  return 1;
}

int X509_get_ex_new_index(long argl, void *argp, CRYPTO_EX_unused *unused,
                          CRYPTO_EX_dup *dup_unused,
                          CRYPTO_EX_free *free_func) {
  return CRYPTO_get_ex_new_index_ex(&g_ex_data_class, argl, argp, free_func);
}

int X509_set_ex_data(X509 *r, int idx, void *arg) {
  return (CRYPTO_set_ex_data(&r->ex_data, idx, arg));
}

void *X509_get_ex_data(X509 *r, int idx) {
  return (CRYPTO_get_ex_data(&r->ex_data, idx));
}

// X509_AUX ASN1 routines. X509_AUX is the name given to a certificate with
// extra info tagged on the end. Since these functions set how a certificate
// is trusted they should only be used when the certificate comes from a
// reliable source such as local storage.

X509 *d2i_X509_AUX(X509 **a, const unsigned char **pp, long length) {
  const unsigned char *q = *pp;
  X509 *ret;
  int freeret = 0;

  if (!a || *a == nullptr) {
    freeret = 1;
  }
  ret = d2i_X509(a, &q, length);
  // If certificate unreadable then forget it
  if (!ret) {
    return nullptr;
  }
  // update length
  length -= q - *pp;
  // Parse auxiliary information if there is any.
  if (length > 0 && !d2i_X509_CERT_AUX(&ret->aux, &q, length)) {
    goto err;
  }
  *pp = q;
  return ret;
err:
  if (freeret) {
    X509_free(ret);
    if (a) {
      *a = nullptr;
    }
  }
  return nullptr;
}

// Serialize trusted certificate to *pp or just return the required buffer
// length if pp == NULL.  We ultimately want to avoid modifying *pp in the
// error path, but that depends on similar hygiene in lower-level functions.
// Here we avoid compounding the problem.
static int i2d_x509_aux_internal(const X509 *a, unsigned char **pp) {
  int length, tmplen;
  unsigned char *start = pp != nullptr ? *pp : nullptr;

  assert(pp == nullptr || *pp != nullptr);

  // This might perturb *pp on error, but fixing that belongs in i2d_X509()
  // not here.  It should be that if a == NULL length is zero, but we check
  // both just in case.
  length = i2d_X509(a, pp);
  if (length <= 0 || a == nullptr) {
    return length;
  }

  if (a->aux != nullptr) {
    tmplen = i2d_X509_CERT_AUX(a->aux, pp);
    if (tmplen < 0) {
      if (start != nullptr) {
        *pp = start;
      }
      return tmplen;
    }
    length += tmplen;
  }

  return length;
}

// Serialize trusted certificate to *pp, or just return the required buffer
// length if pp == NULL.
//
// When pp is not NULL, but *pp == NULL, we allocate the buffer, but since
// we're writing two ASN.1 objects back to back, we can't have i2d_X509() do
// the allocation, nor can we allow i2d_X509_CERT_AUX() to increment the
// allocated buffer.
int i2d_X509_AUX(const X509 *a, unsigned char **pp) {
  int length;
  unsigned char *tmp;

  // Buffer provided by caller
  if (pp == nullptr || *pp != nullptr) {
    return i2d_x509_aux_internal(a, pp);
  }

  // Obtain the combined length
  if ((length = i2d_x509_aux_internal(a, nullptr)) <= 0) {
    return length;
  }

  // Allocate requisite combined storage
  *pp = tmp = reinterpret_cast<uint8_t *>(OPENSSL_malloc(length));
  if (tmp == nullptr) {
    return -1;  // Push error onto error stack?
  }

  // Encode, but keep *pp at the originally malloced pointer
  length = i2d_x509_aux_internal(a, &tmp);
  if (length <= 0) {
    OPENSSL_free(*pp);
    *pp = nullptr;
  }
  return length;
}

int i2d_re_X509_tbs(X509 *x509, uint8_t **outp) {
  CRYPTO_BUFFER_free(x509->buf);
  x509->buf = nullptr;
  return i2d_X509_tbs(x509, outp);
}

int i2d_X509_tbs(const X509 *x509, uint8_t **outp) {
  return bssl::I2DFromCBB(/*initial_capacity=*/128, outp, [&](CBB *cbb) -> bool {
    return x509_marshal_tbs_cert(cbb, x509);
  });
}

int X509_set1_signature_algo(X509 *x509, const X509_ALGOR *algo) {
  return X509_ALGOR_copy(&x509->sig_alg, algo) &&
         X509_ALGOR_copy(&x509->tbs_sig_alg, algo);
}

int X509_set1_signature_value(X509 *x509, const uint8_t *sig, size_t sig_len) {
  if (!ASN1_STRING_set(&x509->signature, sig, sig_len)) {
    return 0;
  }
  x509->signature.flags &= ~(ASN1_STRING_FLAG_BITS_LEFT | 0x07);
  x509->signature.flags |= ASN1_STRING_FLAG_BITS_LEFT;
  return 1;
}

void X509_get0_signature(const ASN1_BIT_STRING **psig, const X509_ALGOR **palg,
                         const X509 *x) {
  if (psig) {
    *psig = &x->signature;
  }
  if (palg) {
    *palg = &x->sig_alg;
  }
}

int X509_get_signature_nid(const X509 *x) {
  return OBJ_obj2nid(x->sig_alg.algorithm);
}
