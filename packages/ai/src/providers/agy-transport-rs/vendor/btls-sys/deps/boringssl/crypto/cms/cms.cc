// Copyright 2025 The BoringSSL Authors
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

#include <openssl/cms.h>

#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/mem.h>
#include <openssl/x509.h>

#include "../pkcs7/internal.h"


// TODO(davidben): Should we move the core PKCS#7 / CMS implementation into
// crypto/cms instead of crypto/pkcs7? CMS is getting new features while PKCS#7
// is not.
OPENSSL_DECLARE_ERROR_REASON(CMS, CERTIFICATE_HAS_NO_KEYID)

struct CMS_SignerInfo_st {
  X509 *signcert = nullptr;
  EVP_PKEY *pkey = nullptr;
  const EVP_MD *md = nullptr;
  bool use_key_id = false;
};

struct CMS_ContentInfo_st {
  bool has_signer_info = false;
  CMS_SignerInfo signer_info;
  uint8_t *der = nullptr;
  size_t der_len = 0;
};

CMS_ContentInfo *CMS_sign(X509 *signcert, EVP_PKEY *pkey, STACK_OF(X509) *certs,
                          BIO *data, uint32_t flags) {
  // We only support external signatures and do not support embedding
  // certificates in SignedData.
  if ((flags & CMS_DETACHED) == 0 || sk_X509_num(certs) != 0) {
    OPENSSL_PUT_ERROR(CMS, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return nullptr;
  }

  bssl::UniquePtr<CMS_ContentInfo> cms(
      static_cast<CMS_ContentInfo *>(OPENSSL_zalloc(sizeof(CMS_ContentInfo))));
  if (cms == nullptr) {
    return nullptr;
  }

  if (pkey != nullptr &&
      !CMS_add1_signer(cms.get(), signcert, pkey, /*md=*/nullptr, flags)) {
    return nullptr;
  }

  // We don't actually use streaming mode, but Linux passes |CMS_STREAM| to
  // |CMS_sign| and OpenSSL interprets it as an alias for |CMS_PARTIAL| in this
  // context.
  if ((flags & (CMS_PARTIAL | CMS_STREAM)) == 0 &&
      !CMS_final(cms.get(), data, nullptr, flags)) {
    return nullptr;
  }

  return cms.release();
}

void CMS_ContentInfo_free(CMS_ContentInfo *cms) {
  if (cms == nullptr) {
    return;
  }
  X509_free(cms->signer_info.signcert);
  EVP_PKEY_free(cms->signer_info.pkey);
  OPENSSL_free(cms->der);
  OPENSSL_free(cms);
}

CMS_SignerInfo *CMS_add1_signer(CMS_ContentInfo *cms, X509 *signcert,
                                EVP_PKEY *pkey, const EVP_MD *md,
                                uint32_t flags) {
  if (  // Already finalized.
      cms->der_len != 0 ||
      // We only support one signer.
      cms->has_signer_info ||
      // We do not support configuring a signer in multiple steps. (In OpenSSL,
      // this is used to configure attributes.
      (flags & CMS_PARTIAL) != 0 ||
      // We do not support embedding certificates in SignedData.
      (flags & CMS_NOCERTS) == 0 ||
      // We do not support attributes in SignedData.
      (flags & CMS_NOATTR) == 0) {
    OPENSSL_PUT_ERROR(CMS, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return nullptr;
  }

  if (signcert == nullptr || pkey == nullptr) {
    OPENSSL_PUT_ERROR(CMS, ERR_R_PASSED_NULL_PARAMETER);
    return nullptr;
  }

  if (!X509_check_private_key(signcert, pkey)) {
    OPENSSL_PUT_ERROR(CMS, CMS_R_PRIVATE_KEY_DOES_NOT_MATCH_CERTIFICATE);
    return nullptr;
  }

  // Default to SHA-256.
  if (md == nullptr) {
    md = EVP_sha256();
  }

  // Save information for later.
  cms->has_signer_info = true;
  cms->signer_info.signcert = bssl::UpRef(signcert).release();
  cms->signer_info.pkey = bssl::UpRef(pkey).release();
  cms->signer_info.md = md;
  cms->signer_info.use_key_id = (flags & CMS_USE_KEYID) != 0;
  return &cms->signer_info;
}

int CMS_final(CMS_ContentInfo *cms, BIO *data, BIO *dcont, uint32_t flags) {
  if (  // Already finalized.
      cms->der_len != 0 ||
      // Require a SignerInfo. We do not support signature-less SignedDatas.
      !cms->has_signer_info ||
      // We only support the straightforward passthrough mode, without S/MIME
      // translations.
      (flags & CMS_BINARY) == 0 ||
      // We do not support |dcont|. It is unclear what it does.
      dcont != nullptr) {
    OPENSSL_PUT_ERROR(CMS, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return 0;
  }

  bssl::ScopedCBB cbb;
  if (!CBB_init(cbb.get(), 2048) ||
      !pkcs7_add_external_signature(cbb.get(), cms->signer_info.signcert,
                                    cms->signer_info.pkey, cms->signer_info.md,
                                    data, cms->signer_info.use_key_id) ||
      !CBB_finish(cbb.get(), &cms->der, &cms->der_len)) {
    return 0;
  }

  return 1;
}

int i2d_CMS_bio(BIO *out, CMS_ContentInfo *cms) {
  if (cms->der_len == 0) {
    // Not yet finalized.
    OPENSSL_PUT_ERROR(CMS, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return 0;
  }

  return BIO_write_all(out, cms->der, cms->der_len);
}

int i2d_CMS_bio_stream(BIO *out, CMS_ContentInfo *cms, BIO *in, int flags) {
  // We do not support streaming mode.
  if ((flags & CMS_STREAM) != 0 || in != nullptr) {
    OPENSSL_PUT_ERROR(CMS, ERR_R_SHOULD_NOT_HAVE_BEEN_CALLED);
    return 0;
  }

  return i2d_CMS_bio(out, cms);
}
