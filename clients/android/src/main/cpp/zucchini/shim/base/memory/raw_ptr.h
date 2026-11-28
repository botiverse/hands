#ifndef SHIM_BASE_MEMORY_RAW_PTR_H_
#define SHIM_BASE_MEMORY_RAW_PTR_H_

#include <utility>
#include <cstddef>

namespace base {

template <typename T, typename Tag = void>
class raw_ptr {
 public:
  constexpr raw_ptr() noexcept : ptr_(nullptr) {}
  constexpr raw_ptr(std::nullptr_t) noexcept : ptr_(nullptr) {}
  constexpr raw_ptr(T* ptr) noexcept : ptr_(ptr) {}
  
  template <typename U>
  constexpr raw_ptr(const raw_ptr<U>& other) noexcept : ptr_(other.get()) {}

  constexpr raw_ptr& operator=(T* ptr) noexcept {
    ptr_ = ptr;
    return *this;
  }

  template <typename U>
  constexpr raw_ptr& operator=(const raw_ptr<U>& other) noexcept {
    ptr_ = other.get();
    return *this;
  }

  constexpr T* get() const noexcept { return ptr_; }
  constexpr T& operator*() const noexcept { return *ptr_; }
  constexpr T* operator->() const noexcept { return ptr_; }

  constexpr explicit operator bool() const noexcept { return ptr_ != nullptr; }
  constexpr operator T*() const noexcept { return ptr_; }

  constexpr T& operator[](std::ptrdiff_t index) const noexcept { return ptr_[index]; }
  
  constexpr raw_ptr operator+(std::ptrdiff_t offset) const noexcept { return raw_ptr(ptr_ + offset); }
  constexpr raw_ptr operator-(std::ptrdiff_t offset) const noexcept { return raw_ptr(ptr_ - offset); }
  
  friend constexpr raw_ptr operator+(std::ptrdiff_t offset, raw_ptr rhs) noexcept { return raw_ptr(offset + rhs.ptr_); }

  friend constexpr bool operator==(raw_ptr lhs, raw_ptr rhs) noexcept { return lhs.ptr_ == rhs.ptr_; }
  friend constexpr bool operator!=(raw_ptr lhs, raw_ptr rhs) noexcept { return lhs.ptr_ != rhs.ptr_; }
  friend constexpr bool operator==(raw_ptr lhs, T* rhs) noexcept { return lhs.ptr_ == rhs; }
  friend constexpr bool operator!=(raw_ptr lhs, T* rhs) noexcept { return lhs.ptr_ != rhs; }
  friend constexpr bool operator==(T* lhs, raw_ptr rhs) noexcept { return lhs == rhs.ptr_; }
  friend constexpr bool operator!=(T* lhs, raw_ptr rhs) noexcept { return lhs != rhs.ptr_; }
  friend constexpr bool operator==(raw_ptr lhs, std::nullptr_t) noexcept { return lhs.ptr_ == nullptr; }
  friend constexpr bool operator!=(raw_ptr lhs, std::nullptr_t) noexcept { return lhs.ptr_ != nullptr; }
  friend constexpr bool operator==(std::nullptr_t, raw_ptr rhs) noexcept { return nullptr == rhs.ptr_; }
  friend constexpr bool operator!=(std::nullptr_t, raw_ptr rhs) noexcept { return nullptr != rhs.ptr_; }

  friend constexpr bool operator<(raw_ptr lhs, raw_ptr rhs) noexcept { return lhs.ptr_ < rhs.ptr_; }

 private:
  T* ptr_;
};

struct CtnExperimental {};
struct AllowPtrArithmetic {};

#define RAW_PTR_EXCLUSION

}  // namespace base

using base::raw_ptr;
using base::CtnExperimental;
using base::AllowPtrArithmetic;

#endif  // SHIM_BASE_MEMORY_RAW_PTR_H_
