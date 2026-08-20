cmake_minimum_required(VERSION 3.25)

# ─── Version ───
#
# Read from the repo's package.json rather than written here as well. There is
# exactly one place the version is authored; copying it into a second file is
# how a shell reporting 0.1.0 ends up inside an installer labelled 0.3.0.
#
# `project(VERSION)` accepts only numbers, so a semver prerelease
# (0.2.0-rc.1) is reduced to its release core here. The full string survives in
# OPENCLAW_VERSION_STRING and reaches the Windows resource and the installer,
# which are the two places a human reads it.
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/../package.json" _openclaw_pkg)
string(JSON OPENCLAW_VERSION_STRING GET "${_openclaw_pkg}" version)
if (NOT OPENCLAW_VERSION_STRING MATCHES "^([0-9]+)\.([0-9]+)\.([0-9]+)")
  message(FATAL_ERROR "shell: package.json version is not semver: ${OPENCLAW_VERSION_STRING}")
endif()
set(OPENCLAW_VERSION_CORE "${CMAKE_MATCH_1}.${CMAKE_MATCH_2}.${CMAKE_MATCH_3}")

project(openclaw-shell LANGUAGES CXX VERSION ${OPENCLAW_VERSION_CORE})

# The fourth component of the Windows FILEVERSION. 0 for a local build; CI
# passes its run number so two builds of the same version are distinguishable
# and the newer one actually compares as newer.
set(OPENCLAW_BUILD_NUMBER "0" CACHE STRING "Fourth component of the Windows FILEVERSION")

set(OPENCLAW_PRODUCT_NAME  "OpenClaw UI")
set(OPENCLAW_INTERNAL_NAME "openclaw-shell")
set(OPENCLAW_COMPANY       "OpenClaw")
set(OPENCLAW_DESCRIPTION   "OpenClaw UI — desktop interface for the OpenClaw CLI")
set(OPENCLAW_COPYRIGHT     "Copyright (C) OpenClaw contributors. MIT licensed.")

message(STATUS "shell: version ${OPENCLAW_VERSION_STRING} (build ${OPENCLAW_BUILD_NUMBER})")

# GUI subsystem means no console window — but it also means std::println goes
# nowhere, which hides startup failures. Build with -Dshell_console=ON to get a
# console back while debugging.
option(shell_console "Build as a console app so stdout is visible" OFF)

if (shell_console)
  add_executable(${PROJECT_NAME})
else()
  # /ENTRY keeps a plain `int main()` rather than forcing WinMain.
  add_executable(${PROJECT_NAME} WIN32)
  if (MSVC)
    target_link_options(${PROJECT_NAME} PRIVATE "/ENTRY:mainCRTStartup")
  endif()
endif()

target_sources(${PROJECT_NAME} PRIVATE "src/main.cpp")

# ─── Windows version resource and icon ───
#
# Without this the executable carries no version information at all: Explorer's
# Details tab is blank, and an installer comparing versions to decide whether it
# is upgrading has nothing to read.
if (WIN32)
  set(OPENCLAW_VERSION_QUAD
      "${PROJECT_VERSION_MAJOR},${PROJECT_VERSION_MINOR},${PROJECT_VERSION_PATCH},${OPENCLAW_BUILD_NUMBER}")

  # The .rc is preprocessed by the resource compiler, which treats a backslash
  # in a quoted string as an escape. Forward slashes are accepted on Windows and
  # sidestep the whole question.
  file(TO_CMAKE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/../resources/icon.ico" OPENCLAW_ICON_RC_PATH)
  if (NOT EXISTS "${OPENCLAW_ICON_RC_PATH}")
    message(FATAL_ERROR
            "shell: ${OPENCLAW_ICON_RC_PATH} is missing. Generate it with: pwsh -File scripts/make-ico.ps1")
  endif()

  configure_file("${CMAKE_CURRENT_SOURCE_DIR}/src/version.rc.in"
                 "${CMAKE_CURRENT_BINARY_DIR}/version.rc" @ONLY)
  target_sources(${PROJECT_NAME} PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/version.rc")
endif()

# saucer requires C++23 and enforces MSVC >= 19.44 at configure time.
target_compile_features(${PROJECT_NAME} PRIVATE cxx_std_23)
set_target_properties(${PROJECT_NAME} PROPERTIES
  CXX_STANDARD 23
  CXX_EXTENSIONS OFF
  CXX_STANDARD_REQUIRED ON
)

include(FetchContent)

# Built from source deliberately. The vcpkg port is pinned to 6.0.1, which
# predates window::set_background — without it there is no transparent
# window, and a transparent window is the whole premise of this launcher.
#
# saucer bootstraps its own dependency graph (CPM, coco, glaze, ...) and
# downloads nuget.exe plus the WebView2 SDK during configure, so the first
# configure needs network access and takes ~1 minute.
FetchContent_Declare(
  saucer
  GIT_REPOSITORY "https://github.com/saucer/saucer"
  GIT_TAG        v8.0.5
)
FetchContent_MakeAvailable(saucer)

target_link_libraries(${PROJECT_NAME} PRIVATE saucer::saucer)

# Native file dialogs and GDI+ screen capture.
if (WIN32)
  target_link_libraries(${PROJECT_NAME} PRIVATE comdlg32 shell32 ole32 gdiplus)
endif()

# Reaching window->native().hwnd means including saucer's WebView2 backend
# header, which includes WebView2.h. saucer links the SDK privately, so its
# include directory is not propagated — pull it from the NuGet package saucer
# downloaded during configure.
if (WIN32)
  file(GLOB _webview2_inc
       "${CMAKE_BINARY_DIR}/_deps/saucer-build/nuget/packages/Microsoft.Web.WebView2.*/build/native/include")
  if (_webview2_inc)
    list(GET _webview2_inc 0 _webview2_inc_dir)
    target_include_directories(${PROJECT_NAME} PRIVATE "${_webview2_inc_dir}")
    message(STATUS "shell: WebView2 headers at ${_webview2_inc_dir}")
  else()
    message(FATAL_ERROR "shell: could not locate the WebView2 SDK headers")
  endif()
endif()

add_custom_command(
  TARGET ${PROJECT_NAME} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory
          "${CMAKE_CURRENT_SOURCE_DIR}/web"
          "$<TARGET_FILE_DIR:${PROJECT_NAME}>"
  COMMAND ${CMAKE_COMMAND} -E copy_directory
          "${CMAKE_CURRENT_SOURCE_DIR}/sidecar"
          "$<TARGET_FILE_DIR:${PROJECT_NAME}>/sidecar"
  COMMAND ${CMAKE_COMMAND} -E copy_directory
          "${CMAKE_CURRENT_SOURCE_DIR}/../resources"
          "$<TARGET_FILE_DIR:${PROJECT_NAME}>/resources"
)

# node-pty is a native module and stays external to the sidecar bundle, so it
# has to be resolvable from the sidecar's own directory at runtime — Node walks
# up from the requiring file looking for node_modules.
set(_node_pty "${CMAKE_CURRENT_SOURCE_DIR}/../node_modules/node-pty")
if (EXISTS "${_node_pty}")
  add_custom_command(
    TARGET ${PROJECT_NAME} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${_node_pty}"
            "$<TARGET_FILE_DIR:${PROJECT_NAME}>/sidecar/node_modules/node-pty"
  )
else()
  message(WARNING "shell: node-pty not found at ${_node_pty}; PTY channels will fail at runtime")
endif()
