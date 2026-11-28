#ifndef SHIM_BASE_STRINGS_STRING_VIEW_UTIL_H_
#define SHIM_BASE_STRINGS_STRING_VIEW_UTIL_H_

#include <string_view>
#include <iterator>

namespace base {

template <typename Container>
std::string_view as_string_view(const Container& c) noexcept {
  return std::string_view(reinterpret_cast<const char*>(std::data(c)), std::size(c));
}

}  // namespace base

#endif  // SHIM_BASE_STRINGS_STRING_VIEW_UTIL_H_
