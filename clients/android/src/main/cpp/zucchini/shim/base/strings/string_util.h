#ifndef SHIM_BASE_STRINGS_STRING_UTIL_H_
#define SHIM_BASE_STRINGS_STRING_UTIL_H_

namespace base {

inline bool IsAsciiDigit(char c) {
  return c >= '0' && c <= '9';
}

}  // namespace base

#endif  // SHIM_BASE_STRINGS_STRING_UTIL_H_
