cmake_minimum_required(VERSION 3.10.2)
project(bridge)

set(NODE_DIR ${CMAKE_SOURCE_DIR}/../../../../third_party/nodejs-mobile)

add_library(native-lib SHARED native-lib.cpp)
target_include_directories(native-lib PRIVATE ${NODE_DIR}/include/node)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION ${NODE_DIR}/bin/${ANDROID_ABI}/libnode.so)

target_link_libraries(native-lib libnode log)
