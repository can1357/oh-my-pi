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

/* X509 v3 extension utilities */

#include <assert.h>
#include <stdio.h>

#include <openssl/conf.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/x509.h>

#include "internal.h"

DEFINE_STACK_OF(X509V3_EXT_METHOD)

static STACK_OF(X509V3_EXT_METHOD) *ext_list = nullptr;

static int ext_stack_cmp(const X509V3_EXT_METHOD *const *a,
                         const X509V3_EXT_METHOD *const *b) {
  return ((*a)->ext_nid - (*b)->ext_nid);
}

int X509V3_EXT_add(X509V3_EXT_METHOD *ext) {
  // We only support |ASN1_ITEM|-based extensions.
  assert(ext->it != nullptr);

  // TODO(davidben): This should be locked. Also check for duplicates.
  if (!ext_list && !(ext_list = sk_X509V3_EXT_METHOD_new(ext_stack_cmp))) {
    return 0;
  }
  if (!sk_X509V3_EXT_METHOD_push(ext_list, ext)) {
    return 0;
  }
  sk_X509V3_EXT_METHOD_sort(ext_list);
  return 1;
}

const X509V3_EXT_METHOD *X509V3_EXT_get_nid(int nid) {
  if (nid < 0) {
    return nullptr;
  }

  switch (nid) {
    case NID_netscape_cert_type:
      return &v3_nscert;
    case NID_netscape_base_url:
      return &v3_netscape_base_url;
    case NID_netscape_revocation_url:
      return &v3_netscape_revocation_url;
    case NID_netscape_ca_revocation_url:
      return &v3_netscape_ca_revocation_url;
    case NID_netscape_renewal_url:
      return &v3_netscape_renewal_url;
    case NID_netscape_ca_policy_url:
      return &v3_netscape_ca_policy_url;
    case NID_netscape_ssl_server_name:
      return &v3_netscape_ssl_server_name;
    case NID_netscape_comment:
      return &v3_netscape_comment;
    case NID_subject_key_identifier:
      return &v3_skey_id;
    case NID_key_usage:
      return &v3_key_usage;
    case NID_subject_alt_name:
      return &v3_subject_alt_name;
    case NID_issuer_alt_name:
      return &v3_issuer_alt_name;
    case NID_certificate_issuer:
      return &v3_certificate_issuer;
    case NID_basic_constraints:
      return &v3_bcons;
    case NID_crl_number:
      return &v3_crl_num;
    case NID_certificate_policies:
      return &v3_cpols;
    case NID_authority_key_identifier:
      return &v3_akey_id;
    case NID_crl_distribution_points:
      return &v3_crld;
    case NID_ext_key_usage:
      return &v3_ext_ku;
    case NID_delta_crl:
      return &v3_delta_crl;
    case NID_crl_reason:
      return &v3_crl_reason;
    case NID_invalidity_date:
      return &v3_crl_invdate;
    case NID_info_access:
      return &v3_info;
    case NID_id_pkix_OCSP_noCheck:
      return &v3_ocsp_nocheck;
    case NID_sinfo_access:
      return &v3_sinfo;
    case NID_policy_constraints:
      return &v3_policy_constraints;
    case NID_name_constraints:
      return &v3_name_constraints;
    case NID_policy_mappings:
      return &v3_policy_mappings;
    case NID_inhibit_any_policy:
      return &v3_inhibit_anyp;
    case NID_issuing_distribution_point:
      return &v3_idp;
    case NID_freshest_crl:
      return &v3_freshest_crl;
  }

  X509V3_EXT_METHOD tmp;
  tmp.ext_nid = nid;
  size_t idx;
  if (ext_list == nullptr || !sk_X509V3_EXT_METHOD_find(ext_list, &idx, &tmp)) {
    return nullptr;
  }
  return sk_X509V3_EXT_METHOD_value(ext_list, idx);
}

const X509V3_EXT_METHOD *X509V3_EXT_get(const X509_EXTENSION *ext) {
  int nid;
  if ((nid = OBJ_obj2nid(ext->object)) == NID_undef) {
    return nullptr;
  }
  return X509V3_EXT_get_nid(nid);
}

int X509V3_EXT_free(int nid, void *ext_data) {
  const X509V3_EXT_METHOD *ext_method = X509V3_EXT_get_nid(nid);
  if (ext_method == nullptr) {
    OPENSSL_PUT_ERROR(X509V3, X509V3_R_CANNOT_FIND_FREE_FUNCTION);
    return 0;
  }

  ASN1_item_free(reinterpret_cast<ASN1_VALUE *>(ext_data),
                 ASN1_ITEM_ptr(ext_method->it));
  return 1;
}

int X509V3_EXT_add_alias(int nid_to, int nid_from) {
  OPENSSL_BEGIN_ALLOW_DEPRECATED
  const X509V3_EXT_METHOD *ext;
  X509V3_EXT_METHOD *tmpext;

  if (!(ext = X509V3_EXT_get_nid(nid_from))) {
    OPENSSL_PUT_ERROR(X509V3, X509V3_R_EXTENSION_NOT_FOUND);
    return 0;
  }
  if (!(tmpext =
            (X509V3_EXT_METHOD *)OPENSSL_malloc(sizeof(X509V3_EXT_METHOD)))) {
    return 0;
  }
  *tmpext = *ext;
  tmpext->ext_nid = nid_to;
  if (!X509V3_EXT_add(tmpext)) {
    OPENSSL_free(tmpext);
    return 0;
  }
  return 1;
  OPENSSL_END_ALLOW_DEPRECATED
}

int X509V3_add_standard_extensions(void) { return 1; }

// Return an extension internal structure

void *X509V3_EXT_d2i(const X509_EXTENSION *ext) {
  const X509V3_EXT_METHOD *method;
  const unsigned char *p;

  if (!(method = X509V3_EXT_get(ext))) {
    return nullptr;
  }
  p = ext->value->data;
  void *ret =
      ASN1_item_d2i(nullptr, &p, ext->value->length, ASN1_ITEM_ptr(method->it));
  if (ret == nullptr) {
    return nullptr;
  }
  // Check for trailing data.
  if (p != ext->value->data + ext->value->length) {
    ASN1_item_free(reinterpret_cast<ASN1_VALUE *>(ret),
                   ASN1_ITEM_ptr(method->it));
    OPENSSL_PUT_ERROR(X509V3, X509V3_R_TRAILING_DATA_IN_EXTENSION);
    return nullptr;
  }
  return ret;
}

void *X509V3_get_d2i(const STACK_OF(X509_EXTENSION) *extensions, int nid,
                     int *out_critical, int *out_idx) {
  int lastpos;
  X509_EXTENSION *ex, *found_ex = nullptr;
  if (!extensions) {
    if (out_idx) {
      *out_idx = -1;
    }
    if (out_critical) {
      *out_critical = -1;
    }
    return nullptr;
  }
  if (out_idx) {
    lastpos = *out_idx + 1;
  } else {
    lastpos = 0;
  }
  if (lastpos < 0) {
    lastpos = 0;
  }
  for (size_t i = lastpos; i < sk_X509_EXTENSION_num(extensions); i++) {
    ex = sk_X509_EXTENSION_value(extensions, i);
    if (OBJ_obj2nid(ex->object) == nid) {
      if (out_idx) {
        // TODO(https://crbug.com/boringssl/379): Consistently reject
        // duplicate extensions.
        *out_idx = (int)i;
        found_ex = ex;
        break;
      } else if (found_ex) {
        // Found more than one
        if (out_critical) {
          *out_critical = -2;
        }
        return nullptr;
      }
      found_ex = ex;
    }
  }
  if (found_ex) {
    // Found it
    if (out_critical) {
      *out_critical = X509_EXTENSION_get_critical(found_ex);
    }
    return X509V3_EXT_d2i(found_ex);
  }

  // Extension not found
  if (out_idx) {
    *out_idx = -1;
  }
  if (out_critical) {
    *out_critical = -1;
  }
  return nullptr;
}

// This function is a general extension append, replace and delete utility.
// The precise operation is governed by the 'flags' value. The 'crit' and
// 'value' arguments (if relevant) are the extensions internal structure.

int X509V3_add1_i2d(STACK_OF(X509_EXTENSION) **x, int nid, void *value,
                    int crit, unsigned long flags) {
  int errcode, extidx = -1;
  X509_EXTENSION *ext = nullptr, *extmp;
  STACK_OF(X509_EXTENSION) *ret = nullptr;
  unsigned long ext_op = flags & X509V3_ADD_OP_MASK;

  // If appending we don't care if it exists, otherwise look for existing
  // extension.
  if (ext_op != X509V3_ADD_APPEND) {
    extidx = X509v3_get_ext_by_NID(*x, nid, -1);
  }

  // See if extension exists
  if (extidx >= 0) {
    // If keep existing, nothing to do
    if (ext_op == X509V3_ADD_KEEP_EXISTING) {
      return 1;
    }
    // If default then its an error
    if (ext_op == X509V3_ADD_DEFAULT) {
      errcode = X509V3_R_EXTENSION_EXISTS;
      goto err;
    }
    // If delete, just delete it
    if (ext_op == X509V3_ADD_DELETE) {
      X509_EXTENSION *prev_ext = sk_X509_EXTENSION_delete(*x, extidx);
      if (prev_ext == nullptr) {
        return -1;
      }
      X509_EXTENSION_free(prev_ext);
      return 1;
    }
  } else {
    // If replace existing or delete, error since extension must exist
    if ((ext_op == X509V3_ADD_REPLACE_EXISTING) ||
        (ext_op == X509V3_ADD_DELETE)) {
      errcode = X509V3_R_EXTENSION_NOT_FOUND;
      goto err;
    }
  }

  // If we get this far then we have to create an extension: could have
  // some flags for alternative encoding schemes...

  ext = X509V3_EXT_i2d(nid, crit, value);

  if (!ext) {
    OPENSSL_PUT_ERROR(X509V3, X509V3_R_ERROR_CREATING_EXTENSION);
    return 0;
  }

  // If extension exists replace it..
  if (extidx >= 0) {
    extmp = sk_X509_EXTENSION_value(*x, extidx);
    X509_EXTENSION_free(extmp);
    if (!sk_X509_EXTENSION_set(*x, extidx, ext)) {
      return -1;
    }
    return 1;
  }

  if ((ret = *x) == nullptr &&
      (ret = sk_X509_EXTENSION_new_null()) == nullptr) {
    goto m_fail;
  }
  if (!sk_X509_EXTENSION_push(ret, ext)) {
    goto m_fail;
  }

  *x = ret;
  return 1;

m_fail:
  if (ret != *x) {
    sk_X509_EXTENSION_free(ret);
  }
  X509_EXTENSION_free(ext);
  return -1;

err:
  if (!(flags & X509V3_ADD_SILENT)) {
    OPENSSL_PUT_ERROR(X509V3, errcode);
  }
  return 0;
}
