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

#include <openssl/x509.h>

#include <openssl/asn1.h>
#include <openssl/asn1t.h>
#include <openssl/digest.h>
#include <openssl/err.h>
#include <openssl/obj.h>
#include <openssl/mem.h>

#include "../asn1/internal.h"
#include "../bytestring/internal.h"
#include "../internal.h"
#include "../mem_internal.h"
#include "internal.h"


void x509_algor_init(X509_ALGOR *alg) {
  OPENSSL_memset(alg, 0, sizeof(X509_ALGOR));
  alg->algorithm = const_cast<ASN1_OBJECT *>(OBJ_get_undef());
}

void x509_algor_cleanup(X509_ALGOR *alg) {
  ASN1_OBJECT_free(alg->algorithm);
  ASN1_TYPE_free(alg->parameter);
}

X509_ALGOR *X509_ALGOR_new(void) {
  bssl::UniquePtr<X509_ALGOR> ret = bssl::MakeUnique<X509_ALGOR>();
  if (ret == nullptr) {
    return nullptr;
  }
  x509_algor_init(ret.get());
  return ret.release();
}

void X509_ALGOR_free(X509_ALGOR *alg) {
  if (alg != nullptr) {
    x509_algor_cleanup(alg);
    OPENSSL_free(alg);
  }
}

int x509_parse_algorithm(CBS *cbs, X509_ALGOR *out) {
  CBS seq;
  if (!CBS_get_asn1(cbs, &seq, CBS_ASN1_SEQUENCE)) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return 0;
  }

  bssl::UniquePtr<ASN1_OBJECT> obj(asn1_parse_object(&seq, /*tag=*/0));
  if (obj == nullptr) {
    return 0;
  }
  ASN1_OBJECT_free(out->algorithm);
  out->algorithm = obj.release();
  if (CBS_len(&seq) == 0) {
    ASN1_TYPE_free(out->parameter);
    out->parameter = nullptr;
  } else {
    if (out->parameter == nullptr) {
      out->parameter = ASN1_TYPE_new();
    }
    if (out->parameter == nullptr ||  //
        !asn1_parse_any(&seq, out->parameter)) {
      return 0;
    }
  }
  if (CBS_len(&seq) != 0) {
    OPENSSL_PUT_ERROR(ASN1, ASN1_R_DECODE_ERROR);
    return 0;
  }
  return 1;
}

int x509_marshal_algorithm(CBB *out, const X509_ALGOR *in) {
  CBB seq;
  return CBB_add_asn1(out, &seq, CBS_ASN1_SEQUENCE) &&
         asn1_marshal_object(&seq, in->algorithm, /*tag=*/0) &&
         (in->parameter == nullptr || asn1_marshal_any(&seq, in->parameter)) &&
         CBB_flush(out);
}

X509_ALGOR *d2i_X509_ALGOR(X509_ALGOR **out, const uint8_t **inp, long len) {
  return bssl::D2IFromCBS(
      out, inp, len, [](CBS *cbs) -> bssl::UniquePtr<X509_ALGOR> {
        bssl::UniquePtr<X509_ALGOR> ret(X509_ALGOR_new());
        if (ret == nullptr || !x509_parse_algorithm(cbs, ret.get())) {
          return nullptr;
        }
        return ret;
      });
}

int i2d_X509_ALGOR(const X509_ALGOR *in, uint8_t **outp) {
  return bssl::I2DFromCBB(/*initial_capacity=*/32, outp, [&](CBB *cbb) -> bool {
    return x509_marshal_algorithm(cbb, in);
  });
}

IMPLEMENT_EXTERN_ASN1_SIMPLE(X509_ALGOR, X509_ALGOR_new, X509_ALGOR_free,
                             CBS_ASN1_SEQUENCE, x509_parse_algorithm,
                             i2d_X509_ALGOR)

X509_ALGOR *X509_ALGOR_dup(const X509_ALGOR *alg) {
  bssl::UniquePtr<X509_ALGOR> copy(X509_ALGOR_new());
  if (copy == nullptr || !X509_ALGOR_copy(copy.get(), alg)) {
    return nullptr;
  }
  return copy.release();
}

int X509_ALGOR_copy(X509_ALGOR *dst, const X509_ALGOR *src) {
  bssl::UniquePtr<ASN1_OBJECT> algorithm(OBJ_dup(src->algorithm));
  if (algorithm == nullptr) {
    return 0;
  }
  bssl::UniquePtr<ASN1_TYPE> parameter;
  if (src->parameter != nullptr) {
    parameter.reset(ASN1_TYPE_new());
    if (parameter == nullptr ||
        !ASN1_TYPE_set1(parameter.get(), src->parameter->type,
                        asn1_type_value_as_pointer(src->parameter))) {
      return 0;
    }
  }
  ASN1_OBJECT_free(dst->algorithm);
  dst->algorithm = algorithm.release();
  ASN1_TYPE_free(dst->parameter);
  dst->parameter = parameter.release();
  return 1;
}

int X509_ALGOR_set0(X509_ALGOR *alg, ASN1_OBJECT *aobj, int ptype, void *pval) {
  if (!alg) {
    return 0;
  }
  if (ptype != V_ASN1_UNDEF) {
    if (alg->parameter == nullptr) {
      alg->parameter = ASN1_TYPE_new();
    }
    if (alg->parameter == nullptr) {
      return 0;
    }
  }
  if (alg) {
    ASN1_OBJECT_free(alg->algorithm);
    alg->algorithm = aobj;
  }
  if (ptype == 0) {
    return 1;
  }
  if (ptype == V_ASN1_UNDEF) {
    if (alg->parameter) {
      ASN1_TYPE_free(alg->parameter);
      alg->parameter = nullptr;
    }
  } else {
    ASN1_TYPE_set(alg->parameter, ptype, pval);
  }
  return 1;
}

void X509_ALGOR_get0(const ASN1_OBJECT **out_obj, int *out_param_type,
                     const void **out_param_value, const X509_ALGOR *alg) {
  if (out_obj != nullptr) {
    *out_obj = alg->algorithm;
  }
  if (out_param_type != nullptr) {
    int type = V_ASN1_UNDEF;
    const void *value = nullptr;
    if (alg->parameter != nullptr) {
      type = alg->parameter->type;
      value = asn1_type_value_as_pointer(alg->parameter);
    }
    *out_param_type = type;
    if (out_param_value != nullptr) {
      *out_param_value = value;
    }
  }
}

// Set up an X509_ALGOR DigestAlgorithmIdentifier from an EVP_MD

int X509_ALGOR_set_md(X509_ALGOR *alg, const EVP_MD *md) {
  int param_type;

  if (EVP_MD_flags(md) & EVP_MD_FLAG_DIGALGID_ABSENT) {
    param_type = V_ASN1_UNDEF;
  } else {
    param_type = V_ASN1_NULL;
  }

  return X509_ALGOR_set0(alg, OBJ_nid2obj(EVP_MD_type(md)), param_type,
                         nullptr);
}

// X509_ALGOR_cmp returns 0 if |a| and |b| are equal and non-zero otherwise.
int X509_ALGOR_cmp(const X509_ALGOR *a, const X509_ALGOR *b) {
  int rv;
  rv = OBJ_cmp(a->algorithm, b->algorithm);
  if (rv) {
    return rv;
  }
  if (!a->parameter && !b->parameter) {
    return 0;
  }
  return ASN1_TYPE_cmp(a->parameter, b->parameter);
}
