// Copyright 1999-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/asn1.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/x509.h>


int X509_CRL_print_fp(FILE *fp, const X509_CRL *x) {
  BIO *b = BIO_new_fp(fp, BIO_NOCLOSE);
  if (b == nullptr) {
    OPENSSL_PUT_ERROR(X509, ERR_R_BUF_LIB);
    return 0;
  }
  int ret = X509_CRL_print(b, x);
  BIO_free(b);
  return ret;
}

int X509_CRL_print(BIO *out, const X509_CRL *x) {
  long version = X509_CRL_get_version(x);
  assert(X509_CRL_VERSION_1 <= version && version <= X509_CRL_VERSION_2);
  const X509_ALGOR *sig_alg;
  const ASN1_BIT_STRING *signature;
  X509_CRL_get0_signature(x, &signature, &sig_alg);
  if (BIO_printf(out, "Certificate Revocation List (CRL):\n") <= 0 ||
      BIO_printf(out, "%8sVersion %ld (0x%lx)\n", "", version + 1,
                 (unsigned long)version) <= 0 ||
      // Note this and the other |X509_signature_print| call both print the
      // outer signature algorithm, rather than printing the inner and outer
      // ones separately. This matches OpenSSL, though it was probably a bug.
      !X509_signature_print(out, sig_alg, nullptr)) {
    return 0;
  }

  char *issuer = X509_NAME_oneline(X509_CRL_get_issuer(x), nullptr, 0);
  int ok =
      issuer != nullptr && BIO_printf(out, "%8sIssuer: %s\n", "", issuer) > 0;
  OPENSSL_free(issuer);
  if (!ok) {
    return 0;
  }

  if (BIO_printf(out, "%8sLast Update: ", "") <= 0 ||
      !ASN1_TIME_print(out, X509_CRL_get0_lastUpdate(x)) ||
      BIO_printf(out, "\n%8sNext Update: ", "") <= 0) {
    return 0;
  }
  if (X509_CRL_get0_nextUpdate(x)) {
    if (!ASN1_TIME_print(out, X509_CRL_get0_nextUpdate(x))) {
      return 0;
    }
  } else {
    if (BIO_printf(out, "NONE") <= 0) {
      return 0;
    }
  }

  if (BIO_printf(out, "\n") <= 0 ||
      !X509V3_extensions_print(out, "CRL extensions",
                               X509_CRL_get0_extensions(x), 0, 8)) {
    return 0;
  }

  // TODO(crbug.com/442860745): |X509_CRL_get_REVOKED| is not const-correct.
  const STACK_OF(X509_REVOKED) *rev =
      X509_CRL_get_REVOKED(const_cast<X509_CRL *>(x));
  if (sk_X509_REVOKED_num(rev) > 0) {
    if (BIO_printf(out, "Revoked Certificates:\n") <= 0) {
      return 0;
    }
  } else {
    if (BIO_printf(out, "No Revoked Certificates.\n") <= 0) {
      return 0;
    }
  }

  for (size_t i = 0; i < sk_X509_REVOKED_num(rev); i++) {
    const X509_REVOKED *r = sk_X509_REVOKED_value(rev, i);
    if (BIO_printf(out, "    Serial Number: ") <= 0 ||
        i2a_ASN1_INTEGER(out, X509_REVOKED_get0_serialNumber(r)) <= 0 ||
        BIO_printf(out, "\n        Revocation Date: ") <= 0 ||
        !ASN1_TIME_print(out, X509_REVOKED_get0_revocationDate(r)) ||
        BIO_printf(out, "\n") <= 0 ||
        !X509V3_extensions_print(out, "CRL entry extensions",
                                 X509_REVOKED_get0_extensions(r), 0, 8)) {
    }
  }

  return X509_signature_print(out, sig_alg, signature);
}
