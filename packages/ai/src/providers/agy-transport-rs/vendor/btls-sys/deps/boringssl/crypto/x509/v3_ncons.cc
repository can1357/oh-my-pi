// Copyright 2003-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <stdio.h>
#include <string.h>

#include <openssl/asn1t.h>
#include <openssl/conf.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/x509.h>

#include "../internal.h"
#include "internal.h"


static void *v2i_NAME_CONSTRAINTS(const X509V3_EXT_METHOD *method,
                                  const X509V3_CTX *ctx,
                                  const STACK_OF(CONF_VALUE) *nval);
static int i2r_NAME_CONSTRAINTS(const X509V3_EXT_METHOD *method, void *a,
                                BIO *bp, int ind);
static int do_i2r_name_constraints(const X509V3_EXT_METHOD *method,
                                   const STACK_OF(GENERAL_SUBTREE) *trees,
                                   BIO *bp, int ind, const char *name);
static int print_nc_ipadd(BIO *bp, const ASN1_OCTET_STRING *ip);

static int nc_match(const GENERAL_NAME *gen, const NAME_CONSTRAINTS *nc);
static int nc_match_single(const GENERAL_NAME *sub, const GENERAL_NAME *gen);
static int nc_dn(const X509_NAME *sub, const X509_NAME *nm);
static int nc_dns(const ASN1_IA5STRING *sub, const ASN1_IA5STRING *dns);
static int nc_email(const ASN1_IA5STRING *sub, const ASN1_IA5STRING *eml);
static int nc_uri(const ASN1_IA5STRING *uri, const ASN1_IA5STRING *base);

const X509V3_EXT_METHOD v3_name_constraints = {
    NID_name_constraints,
    0,
    ASN1_ITEM_ref(NAME_CONSTRAINTS),
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    v2i_NAME_CONSTRAINTS,
    i2r_NAME_CONSTRAINTS,
    nullptr,
    nullptr,
};

ASN1_SEQUENCE(GENERAL_SUBTREE) = {
    ASN1_SIMPLE(GENERAL_SUBTREE, base, GENERAL_NAME),
    ASN1_IMP_OPT(GENERAL_SUBTREE, minimum, ASN1_INTEGER, 0),
    ASN1_IMP_OPT(GENERAL_SUBTREE, maximum, ASN1_INTEGER, 1),
} ASN1_SEQUENCE_END(GENERAL_SUBTREE)

ASN1_SEQUENCE(NAME_CONSTRAINTS) = {
    ASN1_IMP_SEQUENCE_OF_OPT(NAME_CONSTRAINTS, permittedSubtrees,
                             GENERAL_SUBTREE, 0),
    ASN1_IMP_SEQUENCE_OF_OPT(NAME_CONSTRAINTS, excludedSubtrees,
                             GENERAL_SUBTREE, 1),
} ASN1_SEQUENCE_END(NAME_CONSTRAINTS)


IMPLEMENT_ASN1_ALLOC_FUNCTIONS(GENERAL_SUBTREE)
IMPLEMENT_ASN1_ALLOC_FUNCTIONS(NAME_CONSTRAINTS)

static void *v2i_NAME_CONSTRAINTS(const X509V3_EXT_METHOD *method,
                                  const X509V3_CTX *ctx,
                                  const STACK_OF(CONF_VALUE) *nval) {
  STACK_OF(GENERAL_SUBTREE) **ptree = nullptr;
  NAME_CONSTRAINTS *ncons = nullptr;
  GENERAL_SUBTREE *sub = nullptr;
  ncons = NAME_CONSTRAINTS_new();
  if (!ncons) {
    goto err;
  }
  for (size_t i = 0; i < sk_CONF_VALUE_num(nval); i++) {
    const CONF_VALUE *val = sk_CONF_VALUE_value(nval, i);
    CONF_VALUE tval;
    if (!strncmp(val->name, "permitted", 9) && val->name[9]) {
      ptree = &ncons->permittedSubtrees;
      tval.name = val->name + 10;
    } else if (!strncmp(val->name, "excluded", 8) && val->name[8]) {
      ptree = &ncons->excludedSubtrees;
      tval.name = val->name + 9;
    } else {
      OPENSSL_PUT_ERROR(X509V3, X509V3_R_INVALID_SYNTAX);
      goto err;
    }
    tval.value = val->value;
    sub = GENERAL_SUBTREE_new();
    if (!v2i_GENERAL_NAME_ex(sub->base, method, ctx, &tval, 1)) {
      goto err;
    }
    if (!*ptree) {
      *ptree = sk_GENERAL_SUBTREE_new_null();
    }
    if (!*ptree || !sk_GENERAL_SUBTREE_push(*ptree, sub)) {
      goto err;
    }
    sub = nullptr;
  }

  return ncons;

err:
  NAME_CONSTRAINTS_free(ncons);
  GENERAL_SUBTREE_free(sub);
  return nullptr;
}

static int i2r_NAME_CONSTRAINTS(const X509V3_EXT_METHOD *method, void *a,
                                BIO *bp, int ind) {
  NAME_CONSTRAINTS *ncons = reinterpret_cast<NAME_CONSTRAINTS *>(a);
  do_i2r_name_constraints(method, ncons->permittedSubtrees, bp, ind,
                          "Permitted");
  do_i2r_name_constraints(method, ncons->excludedSubtrees, bp, ind, "Excluded");
  return 1;
}

static int do_i2r_name_constraints(const X509V3_EXT_METHOD *method,
                                   const STACK_OF(GENERAL_SUBTREE) *trees,
                                   BIO *bp, int ind, const char *name) {
  if (sk_GENERAL_SUBTREE_num(trees) > 0) {
    BIO_printf(bp, "%*s%s:\n", ind, "", name);
  }
  for (const GENERAL_SUBTREE *tree : trees) {
    BIO_printf(bp, "%*s", ind + 2, "");
    if (tree->base->type == GEN_IPADD) {
      print_nc_ipadd(bp, tree->base->d.ip);
    } else {
      GENERAL_NAME_print(bp, tree->base);
    }
    BIO_puts(bp, "\n");
  }
  return 1;
}

static int print_nc_ipadd(BIO *bp, const ASN1_OCTET_STRING *ip) {
  int i, len;
  unsigned char *p;
  p = ip->data;
  len = ip->length;
  BIO_puts(bp, "IP:");
  if (len == 8) {
    BIO_printf(bp, "%d.%d.%d.%d/%d.%d.%d.%d", p[0], p[1], p[2], p[3], p[4],
               p[5], p[6], p[7]);
  } else if (len == 32) {
    for (i = 0; i < 16; i++) {
      uint16_t v = ((uint16_t)p[0] << 8) | p[1];
      BIO_printf(bp, "%X", v);
      p += 2;
      if (i == 7) {
        BIO_puts(bp, "/");
      } else if (i != 15) {
        BIO_puts(bp, ":");
      }
    }
  } else {
    BIO_printf(bp, "IP Address:<invalid>");
  }
  return 1;
}

//-
// Check a certificate conforms to a specified set of constraints.
// Return values:
//   X509_V_OK: All constraints obeyed.
//   X509_V_ERR_PERMITTED_VIOLATION: Permitted subtree violation.
//   X509_V_ERR_EXCLUDED_VIOLATION: Excluded subtree violation.
//   X509_V_ERR_SUBTREE_MINMAX: Min or max values present and matching type.
//   X509_V_ERR_UNSPECIFIED: Unspecified error.
//   X509_V_ERR_UNSUPPORTED_CONSTRAINT_TYPE: Unsupported constraint type.
//   X509_V_ERR_UNSUPPORTED_CONSTRAINT_SYNTAX: Bad or unsupported constraint
//     syntax.
//   X509_V_ERR_UNSUPPORTED_NAME_SYNTAX: Bad or unsupported syntax of name.

int NAME_CONSTRAINTS_check(const X509 *x, const NAME_CONSTRAINTS *nc) {
  const X509_NAME *nm = X509_get_subject_name(x);

  // Guard against certificates with an excessive number of names or
  // constraints causing a computationally expensive name constraints
  // check.
  size_t name_count =
      X509_NAME_entry_count(nm) + sk_GENERAL_NAME_num(x->altname);
  size_t constraint_count = sk_GENERAL_SUBTREE_num(nc->permittedSubtrees) +
                            sk_GENERAL_SUBTREE_num(nc->excludedSubtrees);
  size_t check_count = constraint_count * name_count;
  if (name_count < (size_t)X509_NAME_entry_count(nm) ||
      constraint_count < sk_GENERAL_SUBTREE_num(nc->permittedSubtrees) ||
      (constraint_count && check_count / constraint_count != name_count) ||
      check_count > 1 << 20) {
    return X509_V_ERR_UNSPECIFIED;
  }

  if (X509_NAME_entry_count(nm) > 0) {
    GENERAL_NAME gntmp;
    gntmp.type = GEN_DIRNAME;
    gntmp.d.directoryName = const_cast<X509_NAME*>(nm);

    int r = nc_match(&gntmp, nc);
    if (r != X509_V_OK) {
      return r;
    }

    gntmp.type = GEN_EMAIL;

    // Process any email address attributes in subject name
    for (int i = -1;;) {
      i = X509_NAME_get_index_by_NID(nm, NID_pkcs9_emailAddress, i);
      if (i == -1) {
        break;
      }
      const X509_NAME_ENTRY *ne = X509_NAME_get_entry(nm, i);
      gntmp.d.rfc822Name = X509_NAME_ENTRY_get_data(ne);
      if (gntmp.d.rfc822Name->type != V_ASN1_IA5STRING) {
        return X509_V_ERR_UNSUPPORTED_NAME_SYNTAX;
      }

      r = nc_match(&gntmp, nc);
      if (r != X509_V_OK) {
        return r;
      }
    }
  }

  for (const GENERAL_NAME *gen : x->altname) {
    int r = nc_match(gen, nc);
    if (r != X509_V_OK) {
      return r;
    }
  }

  return X509_V_OK;
}

static int nc_match(const GENERAL_NAME *gen, const NAME_CONSTRAINTS *nc) {
  // Permitted subtrees: if any subtrees exist of matching the type at
  // least one subtree must match.
  int match = 0;
  for (const GENERAL_SUBTREE *sub : nc->permittedSubtrees) {
    if (gen->type != sub->base->type) {
      continue;
    }
    if (sub->minimum || sub->maximum) {
      return X509_V_ERR_SUBTREE_MINMAX;
    }
    // If we already have a match don't bother trying any more
    if (match == 2) {
      continue;
    }
    if (match == 0) {
      match = 1;
    }
    int r = nc_match_single(gen, sub->base);
    if (r == X509_V_OK) {
      match = 2;
    } else if (r != X509_V_ERR_PERMITTED_VIOLATION) {
      return r;
    }
  }

  if (match == 1) {
    return X509_V_ERR_PERMITTED_VIOLATION;
  }

  // Excluded subtrees: must not match any of these
  for (const GENERAL_SUBTREE *sub : nc->excludedSubtrees) {
    if (gen->type != sub->base->type) {
      continue;
    }
    if (sub->minimum || sub->maximum) {
      return X509_V_ERR_SUBTREE_MINMAX;
    }

    int r = nc_match_single(gen, sub->base);
    if (r == X509_V_OK) {
      return X509_V_ERR_EXCLUDED_VIOLATION;
    } else if (r != X509_V_ERR_PERMITTED_VIOLATION) {
      return r;
    }
  }

  return X509_V_OK;
}

static int nc_match_single(const GENERAL_NAME *gen, const GENERAL_NAME *base) {
  switch (base->type) {
    case GEN_DIRNAME:
      return nc_dn(gen->d.directoryName, base->d.directoryName);

    case GEN_DNS:
      return nc_dns(gen->d.dNSName, base->d.dNSName);

    case GEN_EMAIL:
      return nc_email(gen->d.rfc822Name, base->d.rfc822Name);

    case GEN_URI:
      return nc_uri(gen->d.uniformResourceIdentifier,
                    base->d.uniformResourceIdentifier);

    default:
      return X509_V_ERR_UNSUPPORTED_CONSTRAINT_TYPE;
  }
}

// directoryName name constraint matching. The canonical encoding of
// X509_NAME makes this comparison easy. It is matched if the subtree is a
// subset of the name.

static int nc_dn(const X509_NAME *nm, const X509_NAME *base) {
  const X509_NAME_CACHE *nm_cache = x509_name_get_cache(nm);
  if (nm_cache == nullptr) {
    return X509_V_ERR_OUT_OF_MEM;
  }
  const X509_NAME_CACHE *base_cache = x509_name_get_cache(base);
  if (base_cache == nullptr) {
    return X509_V_ERR_OUT_OF_MEM;
  }
  if (base_cache->canon_len > nm_cache->canon_len) {
    return X509_V_ERR_PERMITTED_VIOLATION;
  }
  if (OPENSSL_memcmp(base_cache->canon, nm_cache->canon,
                     base_cache->canon_len)) {
    return X509_V_ERR_PERMITTED_VIOLATION;
  }
  return X509_V_OK;
}

static int starts_with(const CBS *cbs, uint8_t c) {
  return CBS_len(cbs) > 0 && CBS_data(cbs)[0] == c;
}

static int equal_case(const CBS *a, const CBS *b) {
  if (CBS_len(a) != CBS_len(b)) {
    return 0;
  }
  // Note we cannot use |OPENSSL_strncasecmp| because that would stop
  // iterating at NUL.
  const uint8_t *a_data = CBS_data(a), *b_data = CBS_data(b);
  for (size_t i = 0; i < CBS_len(a); i++) {
    if (OPENSSL_tolower(a_data[i]) != OPENSSL_tolower(b_data[i])) {
      return 0;
    }
  }
  return 1;
}

static int has_suffix_case(const CBS *a, const CBS *b) {
  if (CBS_len(a) < CBS_len(b)) {
    return 0;
  }
  CBS copy = *a;
  CBS_skip(&copy, CBS_len(a) - CBS_len(b));
  return equal_case(&copy, b);
}

static int nc_dns(const ASN1_IA5STRING *dns, const ASN1_IA5STRING *base) {
  CBS dns_cbs, base_cbs;
  CBS_init(&dns_cbs, dns->data, dns->length);
  CBS_init(&base_cbs, base->data, base->length);

  // Empty matches everything
  if (CBS_len(&base_cbs) == 0) {
    return X509_V_OK;
  }

  // If |base_cbs| begins with a '.', do a simple suffix comparison. This is
  // not part of RFC5280, but is part of OpenSSL's original behavior.
  if (starts_with(&base_cbs, '.')) {
    if (has_suffix_case(&dns_cbs, &base_cbs)) {
      return X509_V_OK;
    }
    return X509_V_ERR_PERMITTED_VIOLATION;
  }

  // Otherwise can add zero or more components on the left so compare RHS
  // and if dns is longer and expect '.' as preceding character.
  if (CBS_len(&dns_cbs) > CBS_len(&base_cbs)) {
    uint8_t dot;
    if (!CBS_skip(&dns_cbs, CBS_len(&dns_cbs) - CBS_len(&base_cbs) - 1) ||
        !CBS_get_u8(&dns_cbs, &dot) || dot != '.') {
      return X509_V_ERR_PERMITTED_VIOLATION;
    }
  }

  if (!equal_case(&dns_cbs, &base_cbs)) {
    return X509_V_ERR_PERMITTED_VIOLATION;
  }

  return X509_V_OK;
}

static int nc_email(const ASN1_IA5STRING *eml, const ASN1_IA5STRING *base) {
  CBS eml_cbs, base_cbs;
  CBS_init(&eml_cbs, eml->data, eml->length);
  CBS_init(&base_cbs, base->data, base->length);

  // TODO(davidben): In OpenSSL 1.1.1, this switched from the first '@' to the
  // last one. Match them here, or perhaps do an actual parse. Looks like
  // multiple '@'s may be allowed in quoted strings.
  CBS eml_local, base_local;
  if (!CBS_get_until_first(&eml_cbs, &eml_local, '@')) {
    return X509_V_ERR_UNSUPPORTED_NAME_SYNTAX;
  }
  int base_has_at = CBS_get_until_first(&base_cbs, &base_local, '@');

  // Special case: initial '.' is RHS match
  if (!base_has_at && starts_with(&base_cbs, '.')) {
    if (has_suffix_case(&eml_cbs, &base_cbs)) {
      return X509_V_OK;
    }
    return X509_V_ERR_PERMITTED_VIOLATION;
  }

  // If we have anything before '@' match local part
  if (base_has_at) {
    // TODO(davidben): This interprets a constraint of "@example.com" as
    // "example.com", which is not part of RFC5280.
    if (CBS_len(&base_local) > 0) {
      // Case sensitive match of local part
      if (!CBS_mem_equal(&base_local, CBS_data(&eml_local),
                         CBS_len(&eml_local))) {
        return X509_V_ERR_PERMITTED_VIOLATION;
      }
    }
    // Position base after '@'
    assert(starts_with(&base_cbs, '@'));
    CBS_skip(&base_cbs, 1);
  }

  // Just have hostname left to match: case insensitive
  assert(starts_with(&eml_cbs, '@'));
  CBS_skip(&eml_cbs, 1);
  if (!equal_case(&base_cbs, &eml_cbs)) {
    return X509_V_ERR_PERMITTED_VIOLATION;
  }

  return X509_V_OK;
}

static int nc_uri(const ASN1_IA5STRING *uri, const ASN1_IA5STRING *base) {
  CBS uri_cbs, base_cbs;
  CBS_init(&uri_cbs, uri->data, uri->length);
  CBS_init(&base_cbs, base->data, base->length);

  // Check for foo:// and skip past it
  CBS scheme;
  uint8_t byte;
  if (!CBS_get_until_first(&uri_cbs, &scheme, ':') ||
      !CBS_skip(&uri_cbs, 1) ||  // Skip the colon
      !CBS_get_u8(&uri_cbs, &byte) || byte != '/' ||
      !CBS_get_u8(&uri_cbs, &byte) || byte != '/') {
    return X509_V_ERR_UNSUPPORTED_NAME_SYNTAX;
  }

  // Look for a port indicator as end of hostname first. Otherwise look for
  // trailing slash, or the end of the string.
  // TODO(davidben): This is not a correct URI parser and mishandles IPv6
  // literals.
  CBS host;
  if (!CBS_get_until_first(&uri_cbs, &host, ':') &&
      !CBS_get_until_first(&uri_cbs, &host, '/')) {
    host = uri_cbs;
  }

  if (CBS_len(&host) == 0) {
    return X509_V_ERR_UNSUPPORTED_NAME_SYNTAX;
  }

  // Special case: initial '.' is RHS match
  if (starts_with(&base_cbs, '.')) {
    if (has_suffix_case(&host, &base_cbs)) {
      return X509_V_OK;
    }
    return X509_V_ERR_PERMITTED_VIOLATION;
  }

  if (!equal_case(&base_cbs, &host)) {
    return X509_V_ERR_PERMITTED_VIOLATION;
  }

  return X509_V_OK;
}
