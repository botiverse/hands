#include "components/zucchini/zucchini_capi.h"
#include "components/zucchini/zucchini.h"
#include "components/zucchini/patch_reader.h"
#include "components/zucchini/buffer_view.h"

#if ZUCCHINI_ENABLE_GENERATOR
#include "components/zucchini/patch_writer.h"
#endif

extern "C" {

int zucchini_apply_patch(
    const uint8_t* old_data, size_t old_size,
    const uint8_t* patch_data, size_t patch_size,
    uint8_t* new_data, size_t new_size) {
  
  if (!patch_data || patch_size == 0 || !new_data || new_size == 0) {
    return static_cast<int>(zucchini::status::kStatusInvalidParam);
  }

  zucchini::ConstBufferView old_view(old_data, old_size);
  zucchini::ConstBufferView patch_view(patch_data, patch_size);
  zucchini::MutableBufferView new_view(new_data, new_size);

  auto patch_reader = zucchini::EnsemblePatchReader::Create(patch_view);
  if (!patch_reader.has_value()) {
    return static_cast<int>(zucchini::status::kStatusPatchReadError);
  }

  if (patch_reader->header().new_size != new_size) {
    return static_cast<int>(zucchini::status::kStatusInvalidParam);
  }

  zucchini::status::Code status = zucchini::ApplyBuffer(old_view, *patch_reader, new_view);
  return static_cast<int>(status);
}

size_t zucchini_get_new_size(const uint8_t* patch_data, size_t patch_size) {
  if (!patch_data || patch_size == 0) {
    return 0;
  }
  zucchini::ConstBufferView patch_view(patch_data, patch_size);
  auto patch_reader = zucchini::EnsemblePatchReader::Create(patch_view);
  if (!patch_reader.has_value()) {
    return 0;
  }
  return patch_reader->header().new_size;
}

const char* zucchini_status_to_string(int status_code) {
  switch (static_cast<zucchini::status::Code>(status_code)) {
    case zucchini::status::kStatusSuccess: //0
      return "Success";
    case zucchini::status::kStatusInvalidParam: //1
      return "Invalid parameter";
    case zucchini::status::kStatusFileReadError: //2
      return "File read error";
    case zucchini::status::kStatusFileWriteError: //3
      return "File write error";
    case zucchini::status::kStatusPatchReadError: //4
      return "Patch read error";
    case zucchini::status::kStatusPatchWriteError: //5
      return "Patch write error";
    case zucchini::status::kStatusInvalidOldImage: //6
      return "Invalid old image";
    case zucchini::status::kStatusInvalidNewImage: //7
      return "Invalid new image";
    case zucchini::status::kStatusDiskFull: //8
      return "Disk full";
    case zucchini::status::kStatusIoError: //9
      return "I/O error";
    case zucchini::status::kStatusFatal: //10
      return "Fatal error";
    default:
      return "Unknown status";
  }
}

#if ZUCCHINI_ENABLE_GENERATOR
size_t zucchini_generate_patch(
    const uint8_t* old_data, size_t old_size,
    const uint8_t* new_data, size_t new_size,
    uint8_t* patch_data, size_t patch_size) {
  
  if (!old_data || old_size == 0 || !new_data || new_size == 0) {
    return 0;
  }

  zucchini::ConstBufferView old_view(old_data, old_size);
  zucchini::ConstBufferView new_view(new_data, new_size);

  zucchini::EnsemblePatchWriter patch_writer(old_view, new_view);
  zucchini::GenerateOptions options; // Default options

  zucchini::status::Code status = zucchini::GenerateBuffer(old_view, new_view, options, &patch_writer);
  if (status != zucchini::status::kStatusSuccess) {
    return 0;
  }

  size_t required_size = patch_writer.SerializedSize();
  if (!patch_data || patch_size < required_size) {
    return required_size;
  }

  zucchini::MutableBufferView patch_view(patch_data, required_size);
  if (!patch_writer.SerializeInto(patch_view)) {
    return 0;
  }

  return required_size;
}
#endif

}
