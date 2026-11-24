import com.google.archivepatcher.generator.FileByFileV1DeltaGenerator;
import com.google.archivepatcher.generator.RecommendationModifier;
import com.google.archivepatcher.shared.DefaultDeflater;
import com.google.archivepatcher.shared.IDeflater;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.function.BiFunction;
import java.util.zip.GZIPOutputStream;

/**
 * Minimal CLI wrapper around archive-patcher's file-by-file delta generator
 * (com.eidu:archive-patcher, a maintained fork of Google's Play-Store engine).
 * Produces a patch that upgrades OLD.apk to NEW.apk:
 *
 *   java -cp archive-patcher.jar:. PatchGen OLD.apk NEW.apk OUT.patch
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
 * An optional 4th argument `raw` writes the uncompressed patch instead; the
 * container server compresses it with the `xz` CLI for the
 * archive-patcher-v1+xz variant (about 30% smaller than gzip on real APKs).
 */
public final class PatchGen {
  static final BiFunction<Integer, Boolean, IDeflater> DEFLATER_FACTORY =
      (level, nowrap) -> new DefaultDeflater(level, nowrap);

  public static void main(String[] args) throws Exception {
    boolean raw = args.length == 4 && args[3].equals("raw");
    if (args.length != 3 && !raw) {
      System.err.println("usage: PatchGen <old.apk> <new.apk> <out.patch.gz> [raw]");
      System.exit(2);
    }
    File oldFile = new File(args[0]);
    File newFile = new File(args[1]);
    OutputStream file = new BufferedOutputStream(new FileOutputStream(args[2]));
    try (OutputStream out = raw ? file : new GZIPOutputStream(file)) {
      new FileByFileV1DeltaGenerator(DEFLATER_FACTORY, new RecommendationModifier[0])
          .generateDelta(oldFile, newFile, out);
    }
  }
}
