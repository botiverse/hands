// JNI entry point for applying a Zucchini patch (the vendored applier in
// zucchini/, see zucchini/README.hands). Used by ZucchiniDeltaApplier to turn
// archive-patcher's delta-friendly old blob into the delta-friendly new blob.
//
// All three files are memory-mapped, so the blobs (tens of MB) never sit on
// the Java heap. Nothing here may take down the host app: every failure,
// including a failed internal CHECK (which the vendored logging shim turns
// into an exception), is returned as a status code and the caller falls back
// to the full APK.
#include <errno.h>
#include <fcntl.h>
#include <jni.h>
#include <stdint.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <exception>
#include <new>

#include "components/zucchini/zucchini_capi.h"

namespace {

// Status codes beyond zucchini_status_t (0..10).
constexpr jint kOpenOldFailed = -1;
constexpr jint kOpenPatchFailed = -2;
constexpr jint kBadPatchHeader = -3;
constexpr jint kNewTooLarge = -4;
constexpr jint kOpenOutFailed = -5;
constexpr jint kCheckFailed = -6;
constexpr jint kOutOfMemory = -7;
constexpr jint kSyncFailed = -8;

class Mapping {
 public:
  Mapping() = default;
  Mapping(const Mapping&) = delete;
  Mapping& operator=(const Mapping&) = delete;
  ~Mapping() {
    if (data_ != nullptr && data_ != MAP_FAILED) munmap(data_, size_);
    if (fd_ >= 0) close(fd_);
  }

  // Maps an existing file read-only. An empty file maps to (nullptr, 0).
  bool OpenRead(const char* path) {
    fd_ = open(path, O_RDONLY | O_CLOEXEC);
    if (fd_ < 0) return false;
    struct stat st;
    if (fstat(fd_, &st) != 0 || st.st_size < 0) return false;
    size_ = static_cast<size_t>(st.st_size);
    if (size_ == 0) return true;
    data_ = mmap(nullptr, size_, PROT_READ, MAP_PRIVATE, fd_, 0);
    return data_ != MAP_FAILED;
  }

  // Creates (or truncates) a file of exactly |size| bytes and maps it shared.
  bool OpenWrite(const char* path, size_t size) {
    fd_ = open(path, O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (fd_ < 0) return false;
    if (ftruncate(fd_, static_cast<off_t>(size)) != 0) return false;
    size_ = size;
    data_ = mmap(nullptr, size_, PROT_READ | PROT_WRITE, MAP_SHARED, fd_, 0);
    return data_ != MAP_FAILED;
  }

  bool Sync() { return msync(data_, size_, MS_SYNC) == 0; }

  uint8_t* data() const {
    return data_ == MAP_FAILED ? nullptr : static_cast<uint8_t*>(data_);
  }
  size_t size() const { return size_; }

 private:
  int fd_ = -1;
  void* data_ = nullptr;
  size_t size_ = 0;
};

class Utf {
 public:
  Utf(JNIEnv* env, jstring s) : env_(env), s_(s), chars_(env->GetStringUTFChars(s, nullptr)) {}
  ~Utf() {
    if (chars_ != nullptr) env_->ReleaseStringUTFChars(s_, chars_);
  }
  const char* get() const { return chars_; }

 private:
  JNIEnv* env_;
  jstring s_;
  const char* chars_;
};

jint Apply(const char* old_path, const char* patch_path, const char* out_path, jlong max_new_size) {
  Mapping old_file;
  if (!old_file.OpenRead(old_path)) return kOpenOldFailed;
  Mapping patch;
  if (!patch.OpenRead(patch_path) || patch.size() == 0) return kOpenPatchFailed;

  size_t new_size = zucchini_get_new_size(patch.data(), patch.size());
  if (new_size == 0) return kBadPatchHeader;
  if (max_new_size <= 0 || new_size > static_cast<uint64_t>(max_new_size)) return kNewTooLarge;

  Mapping out;
  if (!out.OpenWrite(out_path, new_size)) return kOpenOutFailed;
  int status = zucchini_apply_patch(old_file.data(), old_file.size(), patch.data(), patch.size(),
                                    out.data(), out.size());
  if (status != ZUCCHINI_STATUS_SUCCESS) return status;
  if (!out.Sync()) return kSyncFailed;
  return ZUCCHINI_STATUS_SUCCESS;
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_build_hands_update_internal_ZucchiniNative_nativeApply(
    JNIEnv* env, jclass, jstring old_path, jstring patch_path, jstring out_path, jlong max_new_size) {
  if (old_path == nullptr || patch_path == nullptr || out_path == nullptr) {
    return ZUCCHINI_STATUS_INVALID_PARAM;
  }
  Utf old_utf(env, old_path);
  Utf patch_utf(env, patch_path);
  Utf out_utf(env, out_path);
  if (old_utf.get() == nullptr || patch_utf.get() == nullptr || out_utf.get() == nullptr) {
    return kOutOfMemory;
  }
  try {
    return Apply(old_utf.get(), patch_utf.get(), out_utf.get(), max_new_size);
  } catch (const std::bad_alloc&) {
    return kOutOfMemory;
  } catch (...) {
    return kCheckFailed;
  }
}
