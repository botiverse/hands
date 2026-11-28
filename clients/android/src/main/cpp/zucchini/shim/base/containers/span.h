#ifndef SHIM_BASE_CONTAINERS_SPAN_H_
#define SHIM_BASE_CONTAINERS_SPAN_H_

#include <span>
#include <type_traits>
#include <array>
#include <algorithm>
#include <memory>
#include <cstring>
#include "base/check.h"
#include "base/numerics/safe_conversions.h"

namespace base {

template <typename T, size_t Extent = std::dynamic_extent>
class span {
 public:
  using element_type = T;
  using value_type = std::remove_cv_t<T>;
  using size_type = size_t;
  using difference_type = ptrdiff_t;
  using pointer = T*;
  using const_pointer = const T*;
  using reference = T&;
  using const_reference = const T&;
  using iterator = typename std::span<T, Extent>::iterator;
  using reverse_iterator = typename std::span<T, Extent>::reverse_iterator;

  constexpr span() noexcept : impl_() {}
  
  constexpr span(pointer ptr, size_type count) : impl_(ptr, count) {}
  
  constexpr span(pointer first, pointer last) : impl_(first, last) {}

  template <size_t N>
  constexpr span(T (&arr)[N]) noexcept : impl_(arr) {}

  template <typename U, size_t N>
  requires (std::is_convertible_v<U(*)[], T(*)[]>)
  constexpr span(std::array<U, N>& arr) noexcept : impl_(arr) {}

  template <typename U, size_t N>
  requires (std::is_convertible_v<const U(*)[], T(*)[]>)
  constexpr span(const std::array<U, N>& arr) noexcept : impl_(arr) {}

  template <typename U, size_t N>
  requires (std::is_convertible_v<U(*)[], T(*)[]>)
  constexpr span(const span<U, N>& other) noexcept : impl_(other.impl_) {}

  template <typename U, size_t N>
  requires (std::is_convertible_v<U(*)[], T(*)[]>)
  constexpr span(std::span<U, N> other) noexcept : impl_(other) {}

  constexpr span(std::span<T, Extent> s) noexcept : impl_(s) {}

  constexpr operator std::span<T, Extent>() const noexcept { return impl_; }

  constexpr pointer data() const noexcept { return impl_.data(); }
  constexpr size_type size() const noexcept { return impl_.size(); }
  constexpr size_type size_bytes() const noexcept { return impl_.size_bytes(); }
  [[nodiscard]] constexpr bool empty() const noexcept { return impl_.empty(); }

  // Hands: bounds are CHECKed like Chromium's base::span (a failed CHECK
  // throws, see base/logging.h) instead of being undefined behavior.
  constexpr reference operator[](size_type idx) const {
    CHECK_LT(idx, size());
    return impl_[idx];
  }

  constexpr iterator begin() const noexcept { return impl_.begin(); }
  constexpr iterator end() const noexcept { return impl_.end(); }

  constexpr iterator cbegin() const noexcept { return impl_.begin(); }
  constexpr iterator cend() const noexcept { return impl_.end(); }

  constexpr reverse_iterator rbegin() const noexcept { return impl_.rbegin(); }
  constexpr reverse_iterator rend() const noexcept { return impl_.rend(); }

  constexpr reverse_iterator crbegin() const noexcept { return impl_.rbegin(); }
  constexpr reverse_iterator crend() const noexcept { return impl_.rend(); }

  constexpr reference front() const {
    CHECK(!empty());
    return impl_.front();
  }
  constexpr reference back() const {
    CHECK(!empty());
    return impl_.back();
  }

  constexpr span<T, std::dynamic_extent> subspan(size_type offset, size_type count = std::dynamic_extent) const {
    CHECK_LE(offset, size());
    CHECK(count == std::dynamic_extent || count <= size() - offset);
    return span<T, std::dynamic_extent>(impl_.subspan(offset, count));
  }

  constexpr span<T, std::dynamic_extent> first(size_type count) const {
    CHECK_LE(count, size());
    return span<T, std::dynamic_extent>(impl_.first(count));
  }

  constexpr span<T, std::dynamic_extent> last(size_type count) const {
    CHECK_LE(count, size());
    return span<T, std::dynamic_extent>(impl_.last(count));
  }

  void copy_from_nonoverlapping(span<const T, Extent> source) {
    CHECK_GE(size(), source.size());
    if (source.size() > 0) {
      std::memcpy(data(), source.data(), source.size_bytes());
    }
  }

  void copy_prefix_from(span<const T, std::dynamic_extent> source) {
    CHECK_GE(size(), source.size());
    if (source.size() > 0) {
      std::memcpy(data(), source.data(), source.size_bytes());
    }
  }

  std::span<T, Extent> impl_;
};

template <typename T>
constexpr span<T> make_span(T* ptr, size_t count) noexcept {
  return span<T>(ptr, count);
}

template <typename T>
constexpr span<T> make_span(T* first, T* last) noexcept {
  return span<T>(first, last);
}

template <typename T, size_t Extent>
auto as_bytes(span<T, Extent> s) noexcept {
  return span<const uint8_t, std::dynamic_extent>(reinterpret_cast<const uint8_t*>(s.data()), s.size_bytes());
}

template <typename T, size_t Extent>
auto as_writable_bytes(span<T, Extent> s) noexcept {
  return span<uint8_t, std::dynamic_extent>(reinterpret_cast<uint8_t*>(s.data()), s.size_bytes());
}

template <typename T>
constexpr auto to_address(T* ptr) noexcept {
  return ptr;
}

template <typename T>
requires requires(T&& t) { std::forward<T>(t)._Unwrapped(); }
constexpr auto to_address(T&& ptr) noexcept {
  return std::forward<T>(ptr)._Unwrapped();
}

template <typename T>
requires (!requires(T&& t) { std::forward<T>(t)._Unwrapped(); })
constexpr auto to_address(T&& ptr) noexcept {
  return &*ptr;
}

template <typename T>
auto byte_span_from_ref(T& val) noexcept {
  return span<uint8_t, sizeof(T)>(reinterpret_cast<uint8_t*>(&val), sizeof(T));
}

template <typename T>
auto byte_span_from_ref(const T& val) noexcept {
  return span<const uint8_t, sizeof(T)>(reinterpret_cast<const uint8_t*>(&val), sizeof(T));
}

template <size_t N>
constexpr span<const char, N - 1> span_from_cstring(const char (&str)[N]) noexcept {
  return span<const char, N - 1>(str, N - 1);
}

template <typename T, size_t N>
span(T (&)[N]) -> span<T, N>;

template <typename T, size_t N>
span(std::array<T, N>&) -> span<T, N>;

template <typename T, size_t N>
span(const std::array<T, N>&) -> span<const T, N>;

template <typename Container>
span(Container&) -> span<typename Container::value_type>;

template <typename T, size_t L, typename U, size_t R>
bool operator==(span<T, L> lhs, span<U, R> rhs) {
  return std::equal(lhs.begin(), lhs.end(), rhs.begin(), rhs.end());
}

template <typename T, size_t L, typename U, size_t R>
bool operator!=(span<T, L> lhs, span<U, R> rhs) {
  return !(lhs == rhs);
}

}  // namespace base

#endif  // SHIM_BASE_CONTAINERS_SPAN_H_
