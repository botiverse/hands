import com.android.apksig.ApkVerifier;
import com.android.apksig.SigningCertificateLineage;
import java.io.File;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** Emits verified APK signer lineages as stable, machine-readable lines. */
public final class ApkInspect {
  private static String sha256(X509Certificate certificate) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
    StringBuilder output = new StringBuilder(digest.length * 2);
    for (byte value : digest) output.append(String.format("%02x", value & 0xff));
    return output.toString();
  }

  public static void main(String[] args) throws Exception {
    if (args.length != 1) throw new IllegalArgumentException("expected one APK path");
    ApkVerifier.Result result = new ApkVerifier.Builder(new File(args[0])).build().verify();
    if (!result.isVerified()) {
      System.err.println("APK signature verification failed");
      System.exit(2);
    }

    List<List<X509Certificate>> lineages = new ArrayList<>();
    SigningCertificateLineage lineage = result.getSigningCertificateLineage();
    if (lineage != null) {
      lineages.add(lineage.getCertificatesInLineage());
    } else {
      for (X509Certificate certificate : result.getSignerCertificates()) {
        lineages.add(List.of(certificate));
      }
    }
    if (lineages.isEmpty()) throw new IllegalStateException("verified APK has no signer");

    List<List<String>> fingerprints = new ArrayList<>();
    for (List<X509Certificate> certificates : lineages) {
      if (certificates.isEmpty()) throw new IllegalStateException("empty signer lineage");
      List<String> fingerprintLineage = new ArrayList<>();
      for (X509Certificate certificate : certificates) {
        fingerprintLineage.add(sha256(certificate));
      }
      fingerprints.add(fingerprintLineage);
    }
    // Independent signer order is canonical by root fingerprint; certificate
    // order inside each lineage remains the apksig oldest -> current order.
    fingerprints.sort(Comparator.comparing(lineageFingerprints -> lineageFingerprints.get(0)));
    for (List<String> fingerprintLineage : fingerprints) {
      StringBuilder output = new StringBuilder("lineage=");
      for (int index = 0; index < fingerprintLineage.size(); index++) {
        if (index > 0) output.append(',');
        output.append(fingerprintLineage.get(index));
      }
      System.out.println(output);
    }
  }
}
