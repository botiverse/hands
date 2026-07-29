# @botiverse/hands (HarmonyOS)

Hands feedback + crash reporting SDK for HarmonyOS (ArkTS).

- **Feedback tickets** — submit in-app feedback with attachments and automatic
  device metadata. Large attachments (up to the configured cap) upload directly
  to storage via presigned URLs; smaller ones go inline.
- **Crash reporting** — store-then-send crash capture, uploaded as crash tickets
  on the next launch. Existing crash directories and individual malformed
  system fault events do not block the rest of the pending batch.
- **Device id** — a stable per-install id for rollout/analytics correlation.

Configured at runtime (base URL, app slug, channel, client key are init
parameters, never compiled in). See the Hands docs at
<https://hands.build/docs> for integration details.

## Install

```
ohpm install @botiverse/hands
```

## License

MIT — see [LICENSE](./LICENSE).
