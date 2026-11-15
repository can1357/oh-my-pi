add_executable(
  bssl_shim

  async_bio.cc
  bssl_shim.cc
  handshake_util.cc
  mock_quic_transport.cc
  packeted_bio.cc
  settings_writer.cc
  test_config.cc
  test_state.cc
)
target_link_libraries(bssl_shim ssl crypto)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_executable(
    handshaker

    async_bio.cc
    handshake_util.cc
    handshaker.cc
    mock_quic_transport.cc
    packeted_bio.cc
    settings_writer.cc
    test_config.cc
    test_state.cc
  )
  target_link_libraries(handshaker ssl crypto)
else()
  # Declare a dummy target for run_tests to depend on.
  add_custom_target(handshaker)
endif()
