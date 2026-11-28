#ifndef SHIM_BASE_FUNCTIONAL_BIND_H_
#define SHIM_BASE_FUNCTIONAL_BIND_H_

#include <utility>
#include <functional>
#include "base/functional/callback.h"

namespace base {

template <typename F, typename... Args>
auto BindRepeating(F&& f, Args&&... args) {
  return [f = std::forward<F>(f), ...args = std::forward<Args>(args)](auto&&... extra_args) mutable {
    return std::invoke(f, args..., std::forward<decltype(extra_args)>(extra_args)...);
  };
}

template <typename F, typename... Args>
auto BindOnce(F&& f, Args&&... args) {
  return [f = std::forward<F>(f), ...args = std::forward<Args>(args)](auto&&... extra_args) mutable {
    return std::invoke(f, args..., std::forward<decltype(extra_args)>(extra_args)...);
  };
}

template <typename T>
T* Unretained(T* ptr) {
  return ptr;
}

}  // namespace base

#endif  // SHIM_BASE_FUNCTIONAL_BIND_H_
