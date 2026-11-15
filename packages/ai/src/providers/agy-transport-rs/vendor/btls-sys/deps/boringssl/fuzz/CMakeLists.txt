# TODO(crbug.com/42290412): Flatten this build up a layer. Between
# crbug.com/42290128, crbug.com/42290508 and crbug.com/42290554, there is enough
# churn that we've left it alone for now.
foreach(fuzzer ${FUZZ_SOURCES})
  cmake_path(GET fuzzer STEM name)
  add_executable(${name} ../${fuzzer})
  target_compile_options(${name} PRIVATE "-Wno-missing-prototypes")
  target_link_libraries(${name} ssl pki crypto)
  if(LIBFUZZER_FROM_DEPS)
    set_target_properties(${name} PROPERTIES LINK_FLAGS "-fsanitize=fuzzer-no-link")
    target_link_libraries(${name} Fuzzer)
  else()
    set_target_properties(${name} PROPERTIES LINK_FLAGS "-fsanitize=fuzzer")
  endif()
  set_target_properties(
    ${name}
    PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED YES)
endforeach()
