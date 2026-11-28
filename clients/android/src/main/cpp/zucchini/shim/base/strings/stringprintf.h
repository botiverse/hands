#ifndef SHIM_BASE_STRINGS_STRINGPRINTF_H_
#define SHIM_BASE_STRINGS_STRINGPRINTF_H_

#include <string>
#include <vector>
#include <cstdio>
#include <cstdarg>

namespace base {

inline std::string StringPrintf(const char* format, ...) {
  va_list args;
  va_start(args, format);
  va_list args_copy;
  va_copy(args_copy, args);
  
  int len = std::vsnprintf(nullptr, 0, format, args_copy);
  va_end(args_copy);
  
  if (len < 0) {
    va_end(args);
    return "";
  }
  
  std::vector<char> buf(len + 1);
  std::vsnprintf(buf.data(), buf.size(), format, args);
  va_end(args);
  
  return std::string(buf.data(), len);
}

}  // namespace base

#endif  // SHIM_BASE_STRINGS_STRINGPRINTF_H_
