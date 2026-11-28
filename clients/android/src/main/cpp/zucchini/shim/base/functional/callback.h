#ifndef SHIM_BASE_FUNCTIONAL_CALLBACK_H_
#define SHIM_BASE_FUNCTIONAL_CALLBACK_H_

#include <functional>
#include <type_traits>

namespace base {

template <typename Signature>
class RepeatingCallback;

template <typename R, typename... Args>
class RepeatingCallback<R(Args...)> {
 public:
  RepeatingCallback() = default;
  RepeatingCallback(const RepeatingCallback&) = default;
  RepeatingCallback(RepeatingCallback&&) noexcept = default;
  RepeatingCallback& operator=(const RepeatingCallback&) = default;
  RepeatingCallback& operator=(RepeatingCallback&&) noexcept = default;

  RepeatingCallback(std::function<R(Args...)> cb) : cb_(std::move(cb)) {}
  
  template <typename F>
  requires (!std::is_same_v<std::decay_t<F>, RepeatingCallback>)
  RepeatingCallback(F&& f) : cb_(std::forward<F>(f)) {}

  R Run(Args... args) const {
    return cb_(std::forward<Args>(args)...);
  }

  explicit operator bool() const { return static_cast<bool>(cb_); }

 private:
  std::function<R(Args...)> cb_;
};

template <typename Signature>
class OnceCallback;

template <typename R, typename... Args>
class OnceCallback<R(Args...)> {
 public:
  OnceCallback() = default;
  OnceCallback(const OnceCallback&) = default;
  OnceCallback(OnceCallback&&) noexcept = default;
  OnceCallback& operator=(const OnceCallback&) = default;
  OnceCallback& operator=(OnceCallback&&) noexcept = default;

  OnceCallback(std::function<R(Args...)> cb) : cb_(std::move(cb)) {}
  
  template <typename F>
  requires (!std::is_same_v<std::decay_t<F>, OnceCallback>)
  OnceCallback(F&& f) : cb_(std::forward<F>(f)) {}

  R Run(Args... args) && {
    return cb_(std::forward<Args>(args)...);
  }

  explicit operator bool() const { return static_cast<bool>(cb_); }

 private:
  std::function<R(Args...)> cb_;
};

}  // namespace base

#endif  // SHIM_BASE_FUNCTIONAL_CALLBACK_H_
