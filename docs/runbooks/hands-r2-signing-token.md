# Rotate the Hands R2 signing credentials

Use this runbook when a Hands download redirects to R2 but the R2 request
fails, or when the R2 signing credentials need rotation. Obtain the relevant
production authorization before creating a token, changing secrets, deploying
a Worker version, or revoking a token.

## What uses the credentials

`hands-worker` uses `R2_S3_ACCESS_KEY_ID` and `R2_S3_SECRET_ACCESS_KEY` to
sign both download GET/HEAD URLs and direct upload PUT URLs. The latter are
used by build assets, Android release artifacts, and some feedback attachments.
The R2 bucket binding is separate; not every upload uses these presigned URLs.

The production `deploy-hands-server.yml` job uses the
`reporter-session-production` GitHub Actions environment and reads the same
secret names from GitHub. When a value is nonempty, the workflow writes it to
the Worker. A stale GitHub value can therefore undo a direct Worker update.
At the time of writing these are repository-level secrets in `botiverse/hands`;
check for environment-level overrides before rotating them.

## Before changing anything

1. Ask the release owner to coordinate a pause of concurrent Hands deployments
   until the Worker and GitHub contain the same pair and verification finishes.
   Record the current Worker version, traffic split, and rollback plan.
2. Have an authorized operator with Cloudflare token and Worker permissions and
   GitHub Actions secret access perform the change. Confirm the correct account,
   the `hands-worker` service, and the production bucket `hands-artifacts`.
   If a gradual deployment is active, follow the release owner's staged
   deployment plan instead of immediately deploying a secret change.
3. Keep the old token until the replacement is verified, unless an incident
   owner directs immediate revocation. A revoked token invalidates existing
   presigned URLs signed by it.
4. Use a secure operator session. Disable shell tracing, do not put secret values
   in command arguments, unprotected files, shell history, chat, or logs, and
   retain the new pair only in an approved secure store for recovery if an
   update fails.

## Diagnose a download

Use a known public Hands download URL, not the R2 URL. The check below follows
the redirect in process memory, requests one byte, and prints statuses and the
first eight characters of the signer ID. It requires Node.js 20 or later. If
the expected ID is known, enter its first eight characters for comparison;
otherwise leave the prefix blank. Do not enter or share the full key or the
signed URL.

```bash
read -r -p 'Public https://hands.build download URL: ' HANDS_RUNBOOK_URL
read -r -p 'Expected access key ID prefix (8 hex; blank if unknown): ' HANDS_RUNBOOK_PREFIX
export HANDS_RUNBOOK_URL HANDS_RUNBOOK_PREFIX

if node <<'NODE'
(async () => {
  const publicUrl = new URL(process.env.HANDS_RUNBOOK_URL || "");
  const prefix = process.env.HANDS_RUNBOOK_PREFIX || "";
  if (publicUrl.protocol !== "https:" || publicUrl.hostname !== "hands.build" ||
      publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash ||
      (prefix && !/^[0-9a-f]{8}$/i.test(prefix))) throw new Error("invalid input");

  const first = await fetch(publicUrl, { redirect: "manual" });
  const location = first.headers.get("location");
  await first.body?.cancel();
  if (first.status !== 302 || !location) {
    console.log(JSON.stringify({ hands_status: first.status, r2_status: null }));
    process.exitCode = 1;
    return;
  }
  const signedUrl = new URL(location);
  if (signedUrl.protocol !== "https:" ||
      !signedUrl.hostname.endsWith(".r2.cloudflarestorage.com")) {
    throw new Error("unexpected redirect");
  }

  const credential = signedUrl.searchParams.get("X-Amz-Credential") || "";
  const signerPrefix = /^[0-9a-f]{8}/i.exec(credential)?.[0] || null;
  const prefixMatches = prefix ? signerPrefix?.toLowerCase() === prefix.toLowerCase() : null;
  const second = await fetch(signedUrl, {
    redirect: "manual",
    headers: { range: "bytes=0-0" },
  });
  const rangeOk = /^bytes 0-0\/[1-9][0-9]*$/.test(
    second.headers.get("content-range") || "",
  );
  await second.body?.cancel();
  console.log(JSON.stringify({
    hands_status: first.status,
    r2_status: second.status,
    signer_prefix: signerPrefix,
    prefix_matches: prefixMatches,
    range_ok: rangeOk,
  }));
  if (second.status !== 206 || !signerPrefix || (prefix && !prefixMatches) || !rangeOk) {
    process.exitCode = 1;
  }
})().catch(() => {
  console.error("Download check failed; no signed URL was logged.");
  process.exitCode = 1;
});
NODE
then
  unset HANDS_RUNBOOK_URL HANDS_RUNBOOK_PREFIX
else
  unset HANDS_RUNBOOK_URL HANDS_RUNBOOK_PREFIX
  false
fi
```

A 302 followed by 206 verifies one ranged download; compare the prefix with
the expected token if it is known.
A 401 or 403 is not by itself proof of a deleted token: check the token's
status and policy, URL expiry, signature, and request time. The token details
or API policy are authoritative for scope; a token-creation audit record may
omit `resources`.

## Create and verify one replacement

In the Cloudflare R2 dashboard, create one account API token with **Object Read
& Write**, scoped only to `hands-artifacts`. The corresponding API permission
group is `Workers R2 Storage Bucket Item Write`; it allows object reads, writes,
and listings. Confirm the token details show only the intended bucket and
permission before using it. Do not infer bucket scope from an incomplete audit
entry. If creation is uncertain, inspect the token list before retrying.

Copy the Access Key ID and Secret Access Key once into the approved secure
store. For tokens created through the API instead of the R2 dashboard, the
Access Key ID is the token ID and the Secret Access Key is the hex SHA-256 of
the token value; the token value itself is not the S3 secret. See Cloudflare's
[R2 authentication documentation](https://developers.cloudflare.com/r2/api/tokens/).

## Update both stores

Use the same new pair for the Worker and GitHub. The following Bash example
reads each value invisibly, passes it via stdin rather than arguments or a
temporary file, and uses the project's Wrangler to update the two Worker
secrets in one request. It then updates both repository-level GitHub Actions
secrets from the same shell values.

Run it from the repository root in an authenticated operator session with
Node 22, pnpm, Wrangler, and `gh` configured for the intended accounts. Before
running, confirm there is no environment-level override of either GitHub
secret. The format check expects Cloudflare's current 32-hex-character access
key ID and 64-hex-character S3 secret; stop if they differ.

```bash
(
  set -euo pipefail
  set +x
  unset HANDS_RUNBOOK_ACCESS_ID HANDS_RUNBOOK_SECRET_KEY

  read -r -s -p 'R2 access key ID: ' HANDS_RUNBOOK_ACCESS_ID
  printf '\n'
  read -r -s -p 'R2 secret access key: ' HANDS_RUNBOOK_SECRET_KEY
  printf '\n'

  if [[ ! "$HANDS_RUNBOOK_ACCESS_ID" =~ ^[0-9a-fA-F]{32}$ ||
        ! "$HANDS_RUNBOOK_SECRET_KEY" =~ ^[0-9a-fA-F]{64}$ ]]; then
    printf 'Unexpected credential format; no updates attempted.\n' >&2
    exit 1
  fi

  printf '%s\n%s\n' "$HANDS_RUNBOOK_ACCESS_ID" "$HANDS_RUNBOOK_SECRET_KEY" |
    node -e 'const fs = require("node:fs");
      const [id, key] = fs.readFileSync(0, "utf8").trimEnd().split("\n");
      process.stdout.write(JSON.stringify({
        R2_S3_ACCESS_KEY_ID: id,
        R2_S3_SECRET_ACCESS_KEY: key,
      }));' |
    pnpm --filter @botiverse/hands-worker exec wrangler secret bulk --name hands-worker

  printf '%s' "$HANDS_RUNBOOK_ACCESS_ID" |
    gh secret set R2_S3_ACCESS_KEY_ID --repo botiverse/hands
  printf '%s' "$HANDS_RUNBOOK_SECRET_KEY" |
    gh secret set R2_S3_SECRET_ACCESS_KEY --repo botiverse/hands
)
```

`wrangler secret bulk` creates and deploys a Worker version; it is not a
read-only command. See the [Wrangler command reference](https://developers.cloudflare.com/workers/wrangler/commands/workers/).
If any command fails, stop and keep the deployment pause. One store or one
GitHub secret may already have changed. Inspect the live version and update
status, then use the **same** pair from the approved secure store to complete
the failed step. Do not create another token just by rerunning the procedure.

An operator may instead edit both Worker secrets in the Cloudflare dashboard
and select **Deploy** once, then enter the same pair in GitHub Actions secrets.
Do not run the full server deployment merely to rotate a signer: it can deploy
code, apply migrations, and rewrite other secrets even when the main commit
matches the currently deployed code.

## Verify and retire

- Read the final live Worker version and traffic percentage; verify the intended
  code remains in service and both GitHub secret updates completed. Timestamps
  alone do not prove that the two stores contain the same values; the operator
  must confirm both updates used the same pair.
- Run the download check on each supported platform and have an external
  client complete at least one full download, comparing its size and hash with
  the release metadata.
- Check the token details again for the intended bucket and Object Read & Write
  permission. R2 permission changes may take up to one minute to propagate:
  [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/).
  Verify a presigned PUT through an explicitly authorized test upload if one is
  available; otherwise report upload behavior as unverified.
- After verification, release the deployment pause. Identify old or duplicate
  tokens by ID, never by name. Before revoking a still-valid old token, account
  for the lifetime of outstanding signed URLs; revocation invalidates them.
  Follow the incident owner's direction if a compromised token must be revoked
  sooner. Never revoke the currently active signer.
