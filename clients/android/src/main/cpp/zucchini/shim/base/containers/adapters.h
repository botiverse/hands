#ifndef SHIM_BASE_CONTAINERS_ADAPTERS_H_
#define SHIM_BASE_CONTAINERS_ADAPTERS_H_

#include <ranges>

namespace base {

template <typename T>
auto Reversed(T&& container) {
  return std::views::reverse(std::forward<T>(container));
}

}  // namespace base

#endif  // SHIM_BASE_CONTAINERS_ADAPTERS_H_
