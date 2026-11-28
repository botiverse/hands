// Command-line Zucchini patch generator for the Hands CLI, built to
// WebAssembly by build.sh (see README.md).
//
//   zucchini-gen gen <old> <new> <patch> [<imposed matches>]
//   zucchini-gen apply <old> <patch> <new>
//
// Imposed matches use Zucchini's "oldOffset+oldSize=newOffset+newSize,..."
// format and pair DEX files explicitly. `apply` runs the same applier sources
// as the Android SDK; the CLI's tests use it to check that generated patches
// apply. Exit status 0 on success.
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "components/zucchini/buffer_view.h"
#include "components/zucchini/patch_reader.h"
#include "components/zucchini/patch_writer.h"
#include "components/zucchini/zucchini.h"

namespace {

bool ReadFile(const char* path, std::vector<uint8_t>* out) {
  FILE* f = std::fopen(path, "rb");
  if (f == nullptr) return false;
  bool ok = std::fseek(f, 0, SEEK_END) == 0;
  long size = ok ? std::ftell(f) : -1;
  ok = ok && size >= 0 && std::fseek(f, 0, SEEK_SET) == 0;
  if (ok) {
    out->resize(static_cast<size_t>(size));
    ok = size == 0 || std::fread(out->data(), 1, out->size(), f) == out->size();
  }
  std::fclose(f);
  return ok;
}

bool WriteFile(const char* path, const std::vector<uint8_t>& data) {
  FILE* f = std::fopen(path, "wb");
  if (f == nullptr) return false;
  bool ok = data.empty() || std::fwrite(data.data(), 1, data.size(), f) == data.size();
  return std::fclose(f) == 0 && ok;
}

}  // namespace

int Generate(const char* old_path, const char* new_path, const char* patch_path, const char* imposed) {
  std::vector<uint8_t> old_data, new_data;
  if (!ReadFile(old_path, &old_data) || !ReadFile(new_path, &new_data)) {
    std::fprintf(stderr, "zucchini-gen: cannot read input\n");
    return 3;
  }
  zucchini::ConstBufferView old_view(old_data.data(), old_data.size());
  zucchini::ConstBufferView new_view(new_data.data(), new_data.size());
  zucchini::EnsemblePatchWriter writer(old_view, new_view);
  zucchini::GenerateOptions options;
  if (imposed != nullptr) options.imposed_matches = imposed;
  zucchini::status::Code status = zucchini::GenerateBuffer(old_view, new_view, options, &writer);
  if (status != zucchini::status::kStatusSuccess) {
    std::fprintf(stderr, "zucchini-gen: generate failed with status %d\n", static_cast<int>(status));
    return 4;
  }
  std::vector<uint8_t> patch(writer.SerializedSize());
  if (!writer.SerializeInto(zucchini::MutableBufferView(patch.data(), patch.size()))) {
    std::fprintf(stderr, "zucchini-gen: serialize failed\n");
    return 5;
  }
  if (!WriteFile(patch_path, patch)) {
    std::fprintf(stderr, "zucchini-gen: cannot write patch\n");
    return 6;
  }
  return 0;
}

int Apply(const char* old_path, const char* patch_path, const char* new_path) {
  std::vector<uint8_t> old_data, patch_data;
  if (!ReadFile(old_path, &old_data) || !ReadFile(patch_path, &patch_data)) {
    std::fprintf(stderr, "zucchini-gen: cannot read input\n");
    return 3;
  }
  auto reader = zucchini::EnsemblePatchReader::Create(
      zucchini::ConstBufferView(patch_data.data(), patch_data.size()));
  if (!reader.has_value()) {
    std::fprintf(stderr, "zucchini-gen: invalid patch\n");
    return 4;
  }
  std::vector<uint8_t> new_data(reader->header().new_size);
  zucchini::status::Code status = zucchini::ApplyBuffer(
      zucchini::ConstBufferView(old_data.data(), old_data.size()), *reader,
      zucchini::MutableBufferView(new_data.data(), new_data.size()));
  if (status != zucchini::status::kStatusSuccess) {
    std::fprintf(stderr, "zucchini-gen: apply failed with status %d\n", static_cast<int>(status));
    return 5;
  }
  if (!WriteFile(new_path, new_data)) {
    std::fprintf(stderr, "zucchini-gen: cannot write output\n");
    return 6;
  }
  return 0;
}

int main(int argc, char** argv) {
  const std::string mode = argc > 1 ? argv[1] : "";
  if (mode == "gen" && (argc == 5 || argc == 6)) {
    return Generate(argv[2], argv[3], argv[4], argc == 6 ? argv[5] : nullptr);
  }
  if (mode == "apply" && argc == 5) return Apply(argv[2], argv[3], argv[4]);
  std::fprintf(stderr,
               "usage: zucchini-gen gen <old> <new> <patch> [<imposed matches>]\n"
               "       zucchini-gen apply <old> <patch> <new>\n");
  return 2;
}
