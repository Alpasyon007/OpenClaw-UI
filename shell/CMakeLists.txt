cmake_minimum_required(VERSION 3.25)
project(openclaw-shell LANGUAGES CXX VERSION 0.1.0)

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

add_custom_command(
  TARGET ${PROJECT_NAME} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          "${CMAKE_CURRENT_SOURCE_DIR}/web/index.html"
          "$<TARGET_FILE_DIR:${PROJECT_NAME}>/index.html"
)
