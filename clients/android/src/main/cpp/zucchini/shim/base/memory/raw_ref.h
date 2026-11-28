#ifndef SHIM_BASE_MEMORY_RAW_REF_H_
#define SHIM_BASE_MEMORY_RAW_REF_H_

#include <utility>

namespace base {

template <typename T, typename Tag = void>
class raw_ref {
 public:
  constexpr raw_ref(T& ref) noexcept : ptr_(&ref) {}
  
  template <typename U>
  constexpr raw_ref(const raw_ref<U>& other) noexcept : ptr_(other.operator->()) {}

  constexpr T& get() const noexcept { return *ptr_; }
  constexpr T& operator*() const noexcept { return *ptr_; }
  constexpr T* operator->() const noexcept { return ptr_; }

  friend constexpr bool operator==(raw_ref lhs, raw_ref rhs) noexcept { return lhs.ptr_ == rhs.ptr_; }
  friend constexpr bool operator!=(raw_ref lhs, raw_ref rhs) noexcept { return lhs.ptr_ != rhs.ptr_; }

 private:
  T* ptr_;
};

}  // namespace base

using base::raw_ref;

#endif  // SHIM_BASE_MEMORY_RAW_REF_H_
