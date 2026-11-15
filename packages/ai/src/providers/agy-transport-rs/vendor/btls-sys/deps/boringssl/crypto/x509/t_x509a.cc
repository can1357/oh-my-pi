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

#include <openssl/asn1.h>
#include <openssl/bio.h>
#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/x509.h>

#include "internal.h"


// X509_CERT_AUX and string set routines

int X509_CERT_AUX_print(BIO *out, X509_CERT_AUX *aux, int indent) {
  char oidstr[80], first;
  size_t i;
  int j;
  if (!aux) {
    return 1;
  }
  if (aux->trust) {
    first = 1;
    BIO_printf(out, "%*sTrusted Uses:\n%*s", indent, "", indent + 2, "");
    for (i = 0; i < sk_ASN1_OBJECT_num(aux->trust); i++) {
      if (!first) {
        BIO_puts(out, ", ");
      } else {
        first = 0;
      }
      OBJ_obj2txt(oidstr, sizeof oidstr, sk_ASN1_OBJECT_value(aux->trust, i),
                  0);
      BIO_puts(out, oidstr);
    }
    BIO_puts(out, "\n");
  } else {
    BIO_printf(out, "%*sNo Trusted Uses.\n", indent, "");
  }
  if (aux->reject) {
    first = 1;
    BIO_printf(out, "%*sRejected Uses:\n%*s", indent, "", indent + 2, "");
    for (i = 0; i < sk_ASN1_OBJECT_num(aux->reject); i++) {
      if (!first) {
        BIO_puts(out, ", ");
      } else {
        first = 0;
      }
      OBJ_obj2txt(oidstr, sizeof oidstr, sk_ASN1_OBJECT_value(aux->reject, i),
                  0);
      BIO_puts(out, oidstr);
    }
    BIO_puts(out, "\n");
  } else {
    BIO_printf(out, "%*sNo Rejected Uses.\n", indent, "");
  }
  if (aux->alias) {
    BIO_printf(out, "%*sAlias: %.*s\n", indent, "", aux->alias->length,
               aux->alias->data);
  }
  if (aux->keyid) {
    BIO_printf(out, "%*sKey Id: ", indent, "");
    for (j = 0; j < aux->keyid->length; j++) {
      BIO_printf(out, "%s%02X", j ? ":" : "", aux->keyid->data[j]);
    }
    BIO_write(out, "\n", 1);
  }
  return 1;
}
