// Copyright 2000-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <assert.h>

#include <openssl/asn1t.h>
#include <openssl/mem.h>

#include "internal.h"

// Free up an ASN1 structure

void ASN1_item_free(ASN1_VALUE *val, const ASN1_ITEM *it) {
  ASN1_item_ex_free(&val, it);
}

void ASN1_item_ex_free(ASN1_VALUE **pval, const ASN1_ITEM *it) {
  if (!pval) {
    return;
  }
  if ((it->itype != ASN1_ITYPE_PRIMITIVE) && !*pval) {
    return;
  }

  switch (it->itype) {
    case ASN1_ITYPE_PRIMITIVE:
      if (it->templates) {
        ASN1_template_free(pval, it->templates);
      } else {
        ASN1_primitive_free(pval, it);
      }
      break;

    case ASN1_ITYPE_MSTRING:
      ASN1_primitive_free(pval, it);
      break;

    case ASN1_ITYPE_CHOICE: {
      const ASN1_AUX *aux = reinterpret_cast<const ASN1_AUX *>(it->funcs);
      ASN1_aux_cb *asn1_cb = aux != nullptr ? aux->asn1_cb : nullptr;
      if (asn1_cb) {
        if (asn1_cb(ASN1_OP_FREE_PRE, pval, it, nullptr) == 2) {
          return;
        }
      }
      int i = asn1_get_choice_selector(pval, it);
      if ((i >= 0) && (i < it->tcount)) {
        const ASN1_TEMPLATE *tt = it->templates + i;
        ASN1_VALUE **pchval = asn1_get_field_ptr(pval, tt);
        ASN1_template_free(pchval, tt);
      }
      if (asn1_cb) {
        asn1_cb(ASN1_OP_FREE_POST, pval, it, nullptr);
      }
      OPENSSL_free(*pval);
      *pval = nullptr;
      break;
    }

    case ASN1_ITYPE_EXTERN: {
      const ASN1_EXTERN_FUNCS *ef =
          reinterpret_cast<const ASN1_EXTERN_FUNCS *>(it->funcs);
      if (ef && ef->asn1_ex_free) {
        ef->asn1_ex_free(pval, it);
      }
      break;
    }

    case ASN1_ITYPE_SEQUENCE: {
      if (!asn1_refcount_dec_and_test_zero(pval, it)) {
        return;
      }
      const ASN1_AUX *aux = reinterpret_cast<const ASN1_AUX *>(it->funcs);
      ASN1_aux_cb *asn1_cb = aux != nullptr ? aux->asn1_cb : nullptr;
      if (asn1_cb) {
        if (asn1_cb(ASN1_OP_FREE_PRE, pval, it, nullptr) == 2) {
          return;
        }
      }
      asn1_enc_free(pval, it);
      // If we free up as normal we will invalidate any ANY DEFINED BY
      // field and we won't be able to determine the type of the field it
      // defines. So free up in reverse order.
      for (int i = it->tcount - 1; i >= 0; i--) {
        const ASN1_TEMPLATE *seqtt = asn1_do_adb(pval, &it->templates[i], 0);
        if (!seqtt) {
          continue;
        }
        ASN1_VALUE **pseqval = asn1_get_field_ptr(pval, seqtt);
        ASN1_template_free(pseqval, seqtt);
      }
      if (asn1_cb) {
        asn1_cb(ASN1_OP_FREE_POST, pval, it, nullptr);
      }
      OPENSSL_free(*pval);
      *pval = nullptr;
      break;
    }
  }
}

void ASN1_template_free(ASN1_VALUE **pval, const ASN1_TEMPLATE *tt) {
  if (tt->flags & ASN1_TFLG_SK_MASK) {
    STACK_OF(ASN1_VALUE) *sk = (STACK_OF(ASN1_VALUE) *)*pval;
    for (size_t i = 0; i < sk_ASN1_VALUE_num(sk); i++) {
      ASN1_VALUE *vtmp = sk_ASN1_VALUE_value(sk, i);
      ASN1_item_ex_free(&vtmp, ASN1_ITEM_ptr(tt->item));
    }
    sk_ASN1_VALUE_free(sk);
    *pval = nullptr;
  } else {
    ASN1_item_ex_free(pval, ASN1_ITEM_ptr(tt->item));
  }
}

void ASN1_primitive_free(ASN1_VALUE **pval, const ASN1_ITEM *it) {
  // Historically, |it->funcs| for primitive types contained an
  // |ASN1_PRIMITIVE_FUNCS| table of callbacks.
  assert(it->funcs == nullptr);

  int utype = it->itype == ASN1_ITYPE_MSTRING ? -1 : it->utype;
  switch (utype) {
    case V_ASN1_OBJECT:
      ASN1_OBJECT_free((ASN1_OBJECT *)*pval);
      break;

    case V_ASN1_BOOLEAN:
      if (it) {
        *(ASN1_BOOLEAN *)pval = (ASN1_BOOLEAN)it->size;
      } else {
        *(ASN1_BOOLEAN *)pval = ASN1_BOOLEAN_NONE;
      }
      return;

    case V_ASN1_NULL:
      break;

    case V_ASN1_ANY:
      if (*pval != nullptr) {
        asn1_type_cleanup((ASN1_TYPE *)*pval);
        OPENSSL_free(*pval);
      }
      break;

    default:
      ASN1_STRING_free((ASN1_STRING *)*pval);
      *pval = nullptr;
      break;
  }
  *pval = nullptr;
}
