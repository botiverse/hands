import com.google.archivepatcher.applier.DeltaApplier;
import com.google.archivepatcher.applier.FileByFileV1DeltaApplier;
import com.google.archivepatcher.shared.DefaultDeflater;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

/**
 * Test-only applier for archive-patcher-zucchini-v1 containers, mirroring the
 * Android SDK's ZucchiniFileByFileApplier with the CLI's WebAssembly applier in
 * place of the SDK's native one (both are built from the same sources):
 *
 *   java -cp archive-patcher.jar:. PatchApply NODE ZUCCHINI_GEN OLD PATCH OUT
 *
 * PATCH is the uncompressed container.
 */
public final class PatchApply {
  public static void main(String[] args) throws Exception {
    String node = args[0];
    String tool = args[1];
    File tempDir = Files.createTempDirectory("patch-apply").toFile();
    DeltaApplier zucchini = (File oldBlob, InputStream delta, OutputStream newBlob) -> {
      File patch = new File(tempDir, "delta.zp");
      File out = new File(tempDir, "new.blob");
      Files.copy(delta, patch.toPath(), StandardCopyOption.REPLACE_EXISTING);
      try {
        Process process = new ProcessBuilder(node, tool, "apply", oldBlob.getPath(), patch.getPath(), out.getPath())
            .inheritIO().start();
        if (process.waitFor() != 0) throw new IOException("zucchini apply failed");
      } catch (InterruptedException e) {
        throw new IOException(e);
      }
      Files.copy(out.toPath(), newBlob);
    };
    FileByFileV1DeltaApplier applier =
        new FileByFileV1DeltaApplier(tempDir, (level, nowrap) -> new DefaultDeflater(level, nowrap)) {
          @Override
          protected DeltaApplier getDeltaApplier() {
            return zucchini;
          }
        };
    try (InputStream in = new FileInputStream(args[3]); OutputStream out = new FileOutputStream(args[4])) {
      applier.applyDelta(new File(args[2]), in, out);
    }
  }
}
