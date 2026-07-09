# @oranix/quiver (HarmonyOS)

Hands feedback + crash reporting SDK for HarmonyOS (ArkTS).

- **Feedback tickets** — submit in-app feedback with attachments and automatic
  device metadata. Large attachments (up to the configured cap) upload directly
  to storage via presigned URLs; smaller ones go inline.
- **Crash reporting** — store-then-send crash capture, uploaded as crash tickets
  on the next launch.
- **Device id** — a stable per-install id for rollout/analytics correlation.

Configured at runtime (base URL, app slug, channel, client key are init
parameters, never compiled in). See the Hands docs at
<https://quiver.oranix.io/docs> for integration details.

## Install

```
ohpm install @oranix/quiver
```

## License

MIT — see [LICENSE](./LICENSE).
