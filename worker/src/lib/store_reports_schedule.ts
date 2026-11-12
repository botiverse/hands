import { pollAscAnalytics } from "./asc_analytics_ingest";
import { pollGooglePlayStats } from "./play_stats_ingest";

/**
 * The App Store and Google Play report ingests take turns: even five-minute
 * ticks run the App Store one, odd ticks the Google Play one, so their
 * downloads and parsing never share one invocation's CPU budget.
 */
export function storeReportsIngest(env: Env, scheduledTime: number): Promise<void> {
  return (Math.floor(scheduledTime / 300_000) % 2 === 0 ? pollAscAnalytics(env) : pollGooglePlayStats(env))
    .catch(() => undefined);
}
