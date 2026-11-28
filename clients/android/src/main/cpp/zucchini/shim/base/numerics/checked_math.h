#ifndef SHIM_BASE_NUMERICS_CHECKED_MATH_H_
#define SHIM_BASE_NUMERICS_CHECKED_MATH_H_

#include <type_traits>
#include <limits>
#include <utility>
#include "base/check.h"
#include "base/numerics/safe_conversions.h"

namespace base {
namespace internal {

template <typename T, typename U>
struct CheckedCommonType {
  using Natural = decltype(std::declval<T>() + std::declval<U>());
  
  static constexpr bool is_mixed = std::is_signed_v<T> != std::is_signed_v<U>;
  
  // Mix of signed/unsigned: Promote to a signed type that fits the size of the larger type.
  using type = std::conditional_t<
    is_mixed,
    std::conditional_t<
      (sizeof(T) >= 8 || sizeof(U) >= 8),
      int64_t,
      std::conditional_t<
        (sizeof(T) >= 4 || sizeof(U) >= 4),
        int64_t,
        std::conditional_t<
          (sizeof(T) >= 2 || sizeof(U) >= 2),
          int32_t,
          int16_t
        >
      >
    >,
    Natural
  >;
};

}  // namespace internal

template <typename T, typename U>
using CheckedCommonType_t = typename internal::CheckedCommonType<T, U>::type;

template <typename T>
class CheckedNumeric {
 public:
  constexpr CheckedNumeric() : value_(0), is_valid_(true) {}
  constexpr CheckedNumeric(T value) : value_(value), is_valid_(true) {}
  
  template <typename U>
  constexpr CheckedNumeric(const CheckedNumeric<U>& other)
      : value_(static_cast<T>(other.value_)), is_valid_(other.is_valid_) {
    if (is_valid_) {
      if (!IsValueInRangeForNumericType<T>(other.value_)) {
        is_valid_ = false;
      }
    }
  }

  constexpr bool IsValid() const { return is_valid_; }

  constexpr T ValueOrDie() const {
    CHECK(is_valid_);
    return value_;
  }

  constexpr T ValueOrDefault(T default_val) const {
    return is_valid_ ? value_ : default_val;
  }

  template <typename U>
  constexpr bool AssignIfValid(U* limit) const {
    if (is_valid_ && IsValueInRangeForNumericType<U>(value_)) {
      *limit = static_cast<U>(value_);
      return true;
    }
    return false;
  }

  template <typename U>
  constexpr CheckedNumeric& operator+=(U rhs) {
    *this = *this + rhs;
    return *this;
  }

  template <typename U>
  constexpr CheckedNumeric& operator-=(U rhs) {
    *this = *this - rhs;
    return *this;
  }

  // Operator +
  template <typename U>
  friend constexpr auto operator+(CheckedNumeric lhs, U rhs) {
    using CommonType = CheckedCommonType_t<T, U>;
    CheckedNumeric<CommonType> res;
    if (!lhs.is_valid_) {
      res.is_valid_ = false;
      return res;
    }
    CommonType a = static_cast<CommonType>(lhs.value_);
    CommonType b = static_cast<CommonType>(rhs);
    CommonType sum = a + b;
    
    // Check overflow
    if constexpr (std::is_signed_v<CommonType>) {
      if ((a > 0 && b > 0 && sum <= 0) || (a < 0 && b < 0 && sum >= 0)) {
        res.is_valid_ = false;
      }
    } else {
      if (sum < a) {
        res.is_valid_ = false;
      }
    }
    res.value_ = sum;
    return res;
  }

  template <typename U>
  friend constexpr auto operator+(CheckedNumeric lhs, CheckedNumeric<U> rhs) {
    if (!rhs.is_valid_) {
      using CommonType = CheckedCommonType_t<T, U>;
      CheckedNumeric<CommonType> res;
      res.is_valid_ = false;
      return res;
    }
    return lhs + rhs.value_;
  }

  // Operator -
  template <typename U>
  friend constexpr auto operator-(CheckedNumeric lhs, U rhs) {
    using CommonType = CheckedCommonType_t<T, U>;
    CheckedNumeric<CommonType> res;
    if (!lhs.is_valid_) {
      res.is_valid_ = false;
      return res;
    }
    CommonType a = static_cast<CommonType>(lhs.value_);
    CommonType b = static_cast<CommonType>(rhs);
    CommonType diff = a - b;

    // Check overflow
    if constexpr (std::is_signed_v<CommonType>) {
      if ((b > 0 && a < std::numeric_limits<CommonType>::min() + b) ||
          (b < 0 && a > std::numeric_limits<CommonType>::max() + b)) {
        res.is_valid_ = false;
      }
    } else {
      if (a < b) {
        res.is_valid_ = false;
      }
    }
    res.value_ = diff;
    return res;
  }

  template <typename U>
  friend constexpr auto operator-(CheckedNumeric lhs, CheckedNumeric<U> rhs) {
    if (!rhs.is_valid_) {
      using CommonType = CheckedCommonType_t<T, U>;
      CheckedNumeric<CommonType> res;
      res.is_valid_ = false;
      return res;
    }
    return lhs - rhs.value_;
  }

 public:
  T value_;
  bool is_valid_;

  template <typename U>
  friend class CheckedNumeric;
};

template <typename T, typename U>
constexpr CheckedNumeric<CheckedCommonType_t<T, U>> CheckAdd(T lhs, U rhs) {
  return CheckedNumeric<T>(lhs) + rhs;
}

}  // namespace base

#endif  // SHIM_BASE_NUMERICS_CHECKED_MATH_H_
