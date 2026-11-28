import com.google.archivepatcher.generator.DeltaGenerator;
import com.google.archivepatcher.generator.FileByFileV1DeltaGenerator;
import com.google.archivepatcher.generator.RecommendationModifier;
import com.google.archivepatcher.shared.DefaultDeflater;
import com.google.archivepatcher.shared.IDeflater;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BiFunction;
import java.util.zip.GZIPOutputStream;

/**
 * Minimal CLI wrapper around archive-patcher's file-by-file delta generator
 * (com.eidu:archive-patcher, a maintained fork of Google's Play-Store engine).
 * Produces a patch that upgrades OLD.apk to NEW.apk:
 *
 *   java -cp archive-patcher.jar:. PatchGen OLD.apk NEW.apk OUT.patch.gz
 *   java -cp archive-patcher.jar:. PatchGen --zucchini NODE GENERATOR OLD.apk NEW.apk OUT.patch.gz
 *
 * NOTE 1: the eidu fork's constructor differs from Google's original -- it takes
 * a pluggable deflater factory (level, nowrap) -> IDeflater (so callers can
 * match a platform's exact zlib), not a no-arg constructor. The applier side
 * (Android, P2) needs the SAME factory. DefaultDeflater wraps java.util.zip.
 *
 * NOTE 2: the RAW archive-patcher patch is a bsdiff stream that is mostly zeros
 * for unchanged regions -- it is nearly the full APK size on disk but is highly
 * compressible (a 40-byte change over a 600KB APK: 600KB raw -> ~760B gzipped).
 * So we GZIP the patch here; the stored artifact and the < full-APK size guard
 * must both use this compressed form, and the applier (P2) must GUNZIP before
 * FileByFileV1DeltaApplier.applyDelta. algorithm id: archive-patcher-v1+gzip.
 *
 * NOTE 3: with --zucchini the delta between the delta-friendly blobs is a
 * Zucchini patch instead of bsdiff, made by the CLI's WebAssembly generator
 * (GENERATOR, run with NODE). The container is otherwise identical; the CLI
 * recompresses it as xz for algorithm archive-patcher-zucchini-v1+xz, which
 * Android SDK 0.16.0+ applies.
 */
public final class PatchGen {
  static final BiFunction<Integer, Boolean, IDeflater> DEFLATER_FACTORY =
      (level, nowrap) -> new DefaultDeflater(level, nowrap);

  public static void main(String[] args) throws Exception {
    final boolean zucchini = args.length == 6 && args[0].equals("--zucchini");
    if (args.length != 3 && !zucchini) {
      System.err.println("usage: PatchGen [--zucchini <node> <generator>] <old.apk> <new.apk> <out.patch.gz>");
      System.exit(2);
    }
    int i = zucchini ? 3 : 0;
    File oldFile = new File(args[i]);
    File newFile = new File(args[i + 1]);
    FileByFileV1DeltaGenerator generator = zucchini
        ? new FileByFileV1DeltaGenerator(DEFLATER_FACTORY, new RecommendationModifier[0]) {
            @Override
            protected DeltaGenerator getDeltaGenerator() {
              return new ZucchiniDeltaGenerator(args[1], args[2]);
            }
          }
        : new FileByFileV1DeltaGenerator(DEFLATER_FACTORY, new RecommendationModifier[0]);
    try (OutputStream out =
        new GZIPOutputStream(new BufferedOutputStream(new FileOutputStream(args[i + 2])))) {
      generator.generateDelta(oldFile, newFile, out);
    }
  }

  /**
   * Runs the Zucchini generator on the delta-friendly blobs. Zucchini's own
   * matcher gives up on DEX when an archive has more than one, so DEX files are
   * paired explicitly: the n-th DEX in the old blob with the n-th in the new
   * one (classes.dex, classes2.dex, ... keep their order in an APK).
   */
  static final class ZucchiniDeltaGenerator implements DeltaGenerator {
    private final String node;
    private final String script;

    ZucchiniDeltaGenerator(String node, String script) {
      this.node = node;
      this.script = script;
    }

    @Override
    public void generateDelta(File oldBlob, File newBlob, OutputStream out)
        throws IOException, InterruptedException {
      File patch = File.createTempFile("zucchini", ".patch", oldBlob.getParentFile());
      try {
        List<long[]> oldDex = dexRanges(oldBlob);
        List<long[]> newDex = dexRanges(newBlob);
        StringBuilder imposed = new StringBuilder();
        for (int i = 0; i < Math.min(oldDex.size(), newDex.size()); i++) {
          if (imposed.length() > 0) imposed.append(',');
          imposed.append(oldDex.get(i)[0]).append('+').append(oldDex.get(i)[1]).append('=')
              .append(newDex.get(i)[0]).append('+').append(newDex.get(i)[1]);
        }
        List<String> command = new ArrayList<>(List.of(
            node, script, "gen", oldBlob.getPath(), newBlob.getPath(), patch.getPath()));
        if (imposed.length() > 0) command.add(imposed.toString());
        Process process = new ProcessBuilder(command).inheritIO().start();
        int status = process.waitFor();
        if (status != 0) throw new IOException("zucchini generator exited with status " + status);
        Files.copy(patch.toPath(), out);
      } finally {
        patch.delete();
      }
    }
  }

  /** Offsets and sizes of the DEX files in a delta-friendly blob, in order. */
  static List<long[]> dexRanges(File blob) throws IOException {
    byte[] bytes = Files.readAllBytes(blob.toPath());
    ByteBuffer buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
    List<long[]> ranges = new ArrayList<>();
    for (int i = 0; i + 0x70 <= bytes.length; i++) {
      // "dex\n" + three version digits + NUL, header_size 0x70, little-endian tag.
      if (bytes[i] != 'd' || bytes[i + 1] != 'e' || bytes[i + 2] != 'x' || bytes[i + 3] != '\n'
          || bytes[i + 7] != 0 || buffer.getInt(i + 0x24) != 0x70
          || buffer.getInt(i + 0x28) != 0x12345678) {
        continue;
      }
      long size = buffer.getInt(i + 0x20) & 0xffffffffL;
      if (size < 0x70 || size > bytes.length - i) continue;
      ranges.add(new long[] {i, size});
      i += (int) size - 1;
    }
    return ranges;
  }
}
