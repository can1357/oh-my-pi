// Copyright 2004-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <string.h>

#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/stack.h>
#include <openssl/x509.h>

#include "../internal.h"
#include "internal.h"


// X509_VERIFY_PARAM functions

#define SET_HOST 0
#define ADD_HOST 1

static void str_free(char *s) { OPENSSL_free(s); }

static int int_x509_param_set_hosts(X509_VERIFY_PARAM *param, int mode,
                                    const char *name, size_t namelen) {
  char *copy;

  if (name == nullptr || namelen == 0) {
    // Unlike OpenSSL, we reject trying to set or add an empty name.
    return 0;
  }

  // Refuse names with embedded NUL bytes.
  // XXX: Do we need to push an error onto the error stack?
  if (name && OPENSSL_memchr(name, '\0', namelen)) {
    return 0;
  }

  if (mode == SET_HOST && param->hosts) {
    sk_OPENSSL_STRING_pop_free(param->hosts, str_free);
    param->hosts = nullptr;
  }

  copy = OPENSSL_strndup(name, namelen);
  if (copy == nullptr) {
    return 0;
  }

  if (param->hosts == nullptr &&
      (param->hosts = sk_OPENSSL_STRING_new_null()) == nullptr) {
    OPENSSL_free(copy);
    return 0;
  }

  if (!sk_OPENSSL_STRING_push(param->hosts, copy)) {
    OPENSSL_free(copy);
    if (sk_OPENSSL_STRING_num(param->hosts) == 0) {
      sk_OPENSSL_STRING_free(param->hosts);
      param->hosts = nullptr;
    }
    return 0;
  }

  return 1;
}

X509_VERIFY_PARAM *X509_VERIFY_PARAM_new(void) {
  X509_VERIFY_PARAM *param = reinterpret_cast<X509_VERIFY_PARAM *>(
      OPENSSL_zalloc(sizeof(X509_VERIFY_PARAM)));
  if (!param) {
    return nullptr;
  }
  param->depth = -1;
  return param;
}

void X509_VERIFY_PARAM_free(X509_VERIFY_PARAM *param) {
  if (param == nullptr) {
    return;
  }
  sk_ASN1_OBJECT_pop_free(param->policies, ASN1_OBJECT_free);
  sk_OPENSSL_STRING_pop_free(param->hosts, str_free);
  OPENSSL_free(param->email);
  OPENSSL_free(param->ip);
  OPENSSL_free(param);
}

static int should_copy(int dest_is_set, int src_is_set, int prefer_src) {
  if (prefer_src) {
    // We prefer the source, so as long as there is a value to copy, copy it.
    return src_is_set;
  }

  // We prefer the destination, so only copy if the destination is unset.
  return src_is_set && !dest_is_set;
}

static void copy_int_param(int *dest, const int *src, int default_val,
                           int prefer_src) {
  if (should_copy(*dest != default_val, *src != default_val, prefer_src)) {
    *dest = *src;
  }
}

// x509_verify_param_copy copies fields from |src| to |dest|. If both |src| and
// |dest| have some field set, |prefer_src| determines whether |src| or |dest|'s
// version is used.
static int x509_verify_param_copy(X509_VERIFY_PARAM *dest,
                                  const X509_VERIFY_PARAM *src,
                                  int prefer_src) {
  if (src == nullptr) {
    return 1;
  }

  copy_int_param(&dest->purpose, &src->purpose, /*default_val=*/0, prefer_src);
  copy_int_param(&dest->trust, &src->trust, /*default_val=*/0, prefer_src);
  copy_int_param(&dest->depth, &src->depth, /*default_val=*/-1, prefer_src);

  // |check_time|, unlike all other parameters, does not honor |prefer_src|.
  // This means |X509_VERIFY_PARAM_set1| will not overwrite it. This behavior
  // comes from OpenSSL but may have been a bug.
  if (!(dest->flags & X509_V_FLAG_USE_CHECK_TIME)) {
    dest->check_time = src->check_time;
    // The source |X509_V_FLAG_USE_CHECK_TIME| flag, if set, is copied below.
  }

  dest->flags |= src->flags;

  if (should_copy(dest->policies != nullptr, src->policies != nullptr,
                  prefer_src)) {
    if (!X509_VERIFY_PARAM_set1_policies(dest, src->policies)) {
      return 0;
    }
  }

  if (should_copy(dest->hosts != nullptr, src->hosts != nullptr, prefer_src)) {
    sk_OPENSSL_STRING_pop_free(dest->hosts, str_free);
    dest->hosts = nullptr;
    if (src->hosts) {
      dest->hosts =
          sk_OPENSSL_STRING_deep_copy(src->hosts, OPENSSL_strdup, str_free);
      if (dest->hosts == nullptr) {
        return 0;
      }
      // Copy the host flags if and only if we're copying the host list. Note
      // this means mechanisms like |X509_STORE_CTX_set_default| cannot be used
      // to set host flags. E.g. we cannot change the defaults using
      // |kDefaultParam| below.
      dest->hostflags = src->hostflags;
    }
  }

  if (should_copy(dest->email != nullptr, src->email != nullptr, prefer_src)) {
    if (!X509_VERIFY_PARAM_set1_email(dest, src->email, src->emaillen)) {
      return 0;
    }
  }

  if (should_copy(dest->ip != nullptr, src->ip != nullptr, prefer_src)) {
    if (!X509_VERIFY_PARAM_set1_ip(dest, src->ip, src->iplen)) {
      return 0;
    }
  }

  dest->poison = src->poison;
  return 1;
}

int X509_VERIFY_PARAM_inherit(X509_VERIFY_PARAM *dest,
                              const X509_VERIFY_PARAM *src) {
  // Prefer the destination. That is, this function only changes unset
  // parameters in |dest|.
  return x509_verify_param_copy(dest, src, /*prefer_src=*/0);
}

int X509_VERIFY_PARAM_set1(X509_VERIFY_PARAM *to,
                           const X509_VERIFY_PARAM *from) {
  // Prefer the source. That is, values in |to| are only preserved if they were
  // unset in |from|.
  return x509_verify_param_copy(to, from, /*prefer_src=*/1);
}

static int int_x509_param_set1(char **pdest, size_t *pdestlen, const char *src,
                               size_t srclen) {
  void *tmp;
  if (src == nullptr || srclen == 0) {
    // Unlike OpenSSL, we do not allow an empty string to disable previously
    // configured checks.
    return 0;
  }

  tmp = OPENSSL_memdup(src, srclen);
  if (!tmp) {
    return 0;
  }

  if (*pdest) {
    OPENSSL_free(*pdest);
  }
  *pdest = reinterpret_cast<char *>(tmp);
  if (pdestlen) {
    *pdestlen = srclen;
  }
  return 1;
}

int X509_VERIFY_PARAM_set_flags(X509_VERIFY_PARAM *param, unsigned long flags) {
  param->flags |= flags;
  return 1;
}

int X509_VERIFY_PARAM_clear_flags(X509_VERIFY_PARAM *param,
                                  unsigned long flags) {
  param->flags &= ~flags;
  return 1;
}

unsigned long X509_VERIFY_PARAM_get_flags(const X509_VERIFY_PARAM *param) {
  return param->flags;
}

int X509_VERIFY_PARAM_set_purpose(X509_VERIFY_PARAM *param, int purpose) {
  if (X509_PURPOSE_get0(purpose) == nullptr) {
    OPENSSL_PUT_ERROR(X509V3, X509V3_R_INVALID_PURPOSE);
    return 0;
  }
  param->purpose = purpose;
  return 1;
}

int X509_VERIFY_PARAM_set_trust(X509_VERIFY_PARAM *param, int trust) {
  if (!X509_is_valid_trust_id(trust)) {
    OPENSSL_PUT_ERROR(X509, X509_R_UNKNOWN_TRUST_ID);
    return 0;
  }

  param->trust = trust;
  return 1;
}

void X509_VERIFY_PARAM_set_depth(X509_VERIFY_PARAM *param, int depth) {
  param->depth = depth;
}

void X509_VERIFY_PARAM_set_time_posix(X509_VERIFY_PARAM *param, int64_t t) {
  param->check_time = t;
  param->flags |= X509_V_FLAG_USE_CHECK_TIME;
}

void X509_VERIFY_PARAM_set_time(X509_VERIFY_PARAM *param, time_t t) {
  X509_VERIFY_PARAM_set_time_posix(param, t);
}

int X509_VERIFY_PARAM_add0_policy(X509_VERIFY_PARAM *param,
                                  ASN1_OBJECT *policy) {
  if (!param->policies) {
    param->policies = sk_ASN1_OBJECT_new_null();
    if (!param->policies) {
      return 0;
    }
  }
  if (!sk_ASN1_OBJECT_push(param->policies, policy)) {
    return 0;
  }
  return 1;
}

int X509_VERIFY_PARAM_set1_policies(X509_VERIFY_PARAM *param,
                                    const STACK_OF(ASN1_OBJECT) *policies) {
  if (!param) {
    return 0;
  }

  sk_ASN1_OBJECT_pop_free(param->policies, ASN1_OBJECT_free);
  if (!policies) {
    param->policies = nullptr;
    return 1;
  }

  param->policies =
      sk_ASN1_OBJECT_deep_copy(policies, OBJ_dup, ASN1_OBJECT_free);
  if (!param->policies) {
    return 0;
  }

  return 1;
}

int X509_VERIFY_PARAM_set1_host(X509_VERIFY_PARAM *param, const char *name,
                                size_t namelen) {
  if (!int_x509_param_set_hosts(param, SET_HOST, name, namelen)) {
    param->poison = 1;
    return 0;
  }
  return 1;
}

int X509_VERIFY_PARAM_add1_host(X509_VERIFY_PARAM *param, const char *name,
                                size_t namelen) {
  if (!int_x509_param_set_hosts(param, ADD_HOST, name, namelen)) {
    param->poison = 1;
    return 0;
  }
  return 1;
}

void X509_VERIFY_PARAM_set_hostflags(X509_VERIFY_PARAM *param,
                                     unsigned int flags) {
  param->hostflags = flags;
}

int X509_VERIFY_PARAM_set1_email(X509_VERIFY_PARAM *param, const char *email,
                                 size_t emaillen) {
  if (OPENSSL_memchr(email, '\0', emaillen) != nullptr ||
      !int_x509_param_set1(&param->email, &param->emaillen, email, emaillen)) {
    param->poison = 1;
    return 0;
  }

  return 1;
}

int X509_VERIFY_PARAM_set1_ip(X509_VERIFY_PARAM *param, const unsigned char *ip,
                              size_t iplen) {
  if ((iplen != 4 && iplen != 16) ||
      !int_x509_param_set1((char **)&param->ip, &param->iplen, (char *)ip,
                           iplen)) {
    param->poison = 1;
    return 0;
  }

  return 1;
}

int X509_VERIFY_PARAM_set1_ip_asc(X509_VERIFY_PARAM *param, const char *ipasc) {
  unsigned char ipout[16];
  size_t iplen;

  iplen = (size_t)x509v3_a2i_ipadd(ipout, ipasc);
  if (iplen == 0) {
    return 0;
  }
  return X509_VERIFY_PARAM_set1_ip(param, ipout, iplen);
}

int X509_VERIFY_PARAM_get_depth(const X509_VERIFY_PARAM *param) {
  return param->depth;
}

static const X509_VERIFY_PARAM kDefaultParam = {
    /*check_time=*/0,
    /*flags=*/X509_V_FLAG_TRUSTED_FIRST,
    /*purpose=*/0,
    /*trust=*/0,
    /*depth=*/100,
    /*policies=*/nullptr,
    /*hosts=*/nullptr,
    /*hostflags=*/0,
    /*email=*/nullptr,
    /*emaillen=*/0,
    /*ip=*/nullptr,
    /*iplen=*/0,
    /*poison=*/0,
};

static const X509_VERIFY_PARAM kSMIMESignParam = {
    /*check_time=*/0,
    /*flags=*/0,
    /*purpose=*/X509_PURPOSE_SMIME_SIGN,
    /*trust=*/X509_TRUST_EMAIL,
    /*depth=*/-1,
    /*policies=*/nullptr,
    /*hosts=*/nullptr,
    /*hostflags=*/0,
    /*email=*/nullptr,
    /*emaillen=*/0,
    /*ip=*/nullptr,
    /*iplen=*/0,
    /*poison=*/0,
};

static const X509_VERIFY_PARAM kSSLClientParam = {
    /*check_time=*/0,
    /*flags=*/0,
    /*purpose=*/X509_PURPOSE_SSL_CLIENT,
    /*trust=*/X509_TRUST_SSL_CLIENT,
    /*depth=*/-1,
    /*policies=*/nullptr,
    /*hosts=*/nullptr,
    /*hostflags=*/0,
    /*email=*/nullptr,
    /*emaillen=*/0,
    /*ip=*/nullptr,
    /*iplen=*/0,
    /*poison=*/0,
};

static const X509_VERIFY_PARAM kSSLServerParam = {
    /*check_time=*/0,
    /*flags=*/0,
    /*purpose=*/X509_PURPOSE_SSL_SERVER,
    /*trust=*/X509_TRUST_SSL_SERVER,
    /*depth=*/-1,
    /*policies=*/nullptr,
    /*hosts=*/nullptr,
    /*hostflags=*/0,
    /*email=*/nullptr,
    /*emaillen=*/0,
    /*ip=*/nullptr,
    /*iplen=*/0,
    /*poison=*/0,
};

const X509_VERIFY_PARAM *X509_VERIFY_PARAM_lookup(const char *name) {
  if (strcmp(name, "default") == 0) {
    return &kDefaultParam;
  }
  if (strcmp(name, "pkcs7") == 0) {
    // PKCS#7 and S/MIME signing use the same defaults.
    return &kSMIMESignParam;
  }
  if (strcmp(name, "smime_sign") == 0) {
    return &kSMIMESignParam;
  }
  if (strcmp(name, "ssl_client") == 0) {
    return &kSSLClientParam;
  }
  if (strcmp(name, "ssl_server") == 0) {
    return &kSSLServerParam;
  }
  return nullptr;
}
