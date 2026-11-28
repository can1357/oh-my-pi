typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;

extern napi_value omp_napi_register_module_v1(napi_env env, napi_value exports);

/* Bun looks up this standard Node-API symbol on the executable's loader handle. */
#if !defined(_WIN32)
__attribute__((visibility("default")))
#endif
napi_value napi_register_module_v1(napi_env env, napi_value exports) {
	return omp_napi_register_module_v1(env, exports);
}

#if defined(__linux__)
#include <string.h>

extern void *__real_dlopen(const char *filename, int flags);

/* glibc and musl reject dlopen of an executable by path. Only the self load
 * requests the main-program handle; other addons retain normal lookup and errors. */
void *__wrap_dlopen(const char *filename, int flags) {
	if (filename && strcmp(filename, "/proc/self/exe") == 0) filename = NULL;
	return __real_dlopen(filename, flags);
}
#endif
