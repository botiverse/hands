import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { apiRequest } from "../lib/api.js";
import { jsonRequested } from "../lib/json_output.js";

export type BetaGroup = {
  id: string;
  name: string | null;
  is_internal: boolean | null;
  has_access_to_all_builds: boolean | null;
  public_link_enabled: boolean | null;
  public_link: string | null;
  public_link_limit: number | null;
  public_link_limit_enabled: boolean | null;
  feedback_enabled: boolean | null;
};
type ReviewDetail = {
  id: string;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  demo_account_name: string | null;
  demo_account_password_set: boolean;
  demo_account_required: boolean | null;
  notes: string | null;
};
type BetaLocalization = {
  locale: string | null;
  description: string | null;
  feedback_email: string | null;
  marketing_url: string | null;
  privacy_policy_url: string | null;
};

const collect = (value: string, previous: string[] = []) => previous.concat(value);

/** `--public-link-limit` as an integer 1..10000 (the server checks it again). */
export function parsePublicLinkLimit(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isInteger(n) || n < 1 || n > 10_000) {
    throw new Error("--public-link-limit must be an integer between 1 and 10000");
  }
  return n;
}

export function formatBetaGroups(groups: BetaGroup[]): string {
  if (groups.length === 0) return "No TestFlight beta groups found.";
  return groups
    .map((g) => {
      const kind = g.is_internal ? "internal" : "external";
      const flags = [
        g.public_link_enabled ? `public-link${g.public_link_limit_enabled && g.public_link_limit ? ` (limit ${g.public_link_limit})` : ""}` : null,
        g.feedback_enabled ? "feedback" : null,
      ].filter(Boolean).join(", ");
      const link = g.public_link ? `\n    ${g.public_link}` : "";
      return `${g.id}  ${kind.padEnd(8)}  ${g.name ?? "(unnamed)"}${flags ? `  [${flags}]` : ""}${link}`;
    })
    .join("\n");
}

/** locale=value entries -> {locale: value}; `fromFile` reads each value as a path. */
export function parseLocaleEntries(entries: string[], option: string, fromFile = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) throw new Error(`${option} must use locale=${fromFile ? "path" : "value"}`);
    const locale = entry.slice(0, eq).trim();
    const raw = entry.slice(eq + 1);
    const value = fromFile ? readFileSync(raw.trim(), "utf8").trim() : raw.trim();
    if (!locale || !value) throw new Error(`${option}: locale and value must be non-empty`);
    if (Object.prototype.hasOwnProperty.call(out, locale)) throw new Error(`${option}: duplicate locale ${locale}`);
    out[locale] = value;
  }
  return out;
}

/** Body for PUT testflight-beta-app-description from the CLI flags. */
export function buildBetaDescriptionBody(opts: {
  description?: string[];
  descriptionFile?: string[];
  feedbackEmail?: string[];
  marketingUrl?: string[];
  privacyPolicyUrl?: string[];
}): { descriptions?: Record<string, string>; localizations?: Record<string, Record<string, string>> } {
  const inline = parseLocaleEntries(opts.description ?? [], "--description");
  const files = parseLocaleEntries(opts.descriptionFile ?? [], "--description-file", true);
  for (const locale of Object.keys(files)) {
    if (Object.prototype.hasOwnProperty.call(inline, locale)) {
      throw new Error(`description for ${locale} given by both --description and --description-file`);
    }
  }
  const descriptions = { ...inline, ...files };
  const localizations: Record<string, Record<string, string>> = {};
  const fieldOptions: Array<[string, string, string[] | undefined]> = [
    ["feedback_email", "--feedback-email", opts.feedbackEmail],
    ["marketing_url", "--marketing-url", opts.marketingUrl],
    ["privacy_policy_url", "--privacy-policy-url", opts.privacyPolicyUrl],
  ];
  for (const [field, option, entries] of fieldOptions) {
    for (const [locale, value] of Object.entries(parseLocaleEntries(entries ?? [], option))) {
      (localizations[locale] ??= {})[field] = value;
    }
  }
  const body: { descriptions?: Record<string, string>; localizations?: Record<string, Record<string, string>> } = {};
  if (Object.keys(descriptions).length > 0) body.descriptions = descriptions;
  if (Object.keys(localizations).length > 0) body.localizations = localizations;
  if (!body.descriptions && !body.localizations) {
    throw new Error("Nothing to set: pass --description, --description-file, --feedback-email, --marketing-url or --privacy-policy-url.");
  }
  return body;
}

async function readPasswordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error(
      "--demo-account-password-stdin expects the password on stdin, e.g. `printf %s \"$DEMO_PASSWORD\" | hands testflight review-detail set ...`.",
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (!password) throw new Error("--demo-account-password-stdin: stdin was empty.");
  return password;
}

/** The demo account password only ever comes from stdin or a named environment variable, never argv. */
export async function resolveDemoPassword(opts: {
  demoAccountPasswordStdin?: boolean;
  demoAccountPasswordEnv?: string;
}): Promise<string | undefined> {
  if (opts.demoAccountPasswordStdin && opts.demoAccountPasswordEnv) {
    throw new Error("Use only one of --demo-account-password-stdin and --demo-account-password-env.");
  }
  if (opts.demoAccountPasswordStdin) return readPasswordFromStdin();
  if (opts.demoAccountPasswordEnv) {
    const value = process.env[opts.demoAccountPasswordEnv];
    if (!value) throw new Error(`--demo-account-password-env: environment variable ${opts.demoAccountPasswordEnv} is empty or unset.`);
    return value;
  }
  return undefined;
}

function formatReviewDetail(d: ReviewDetail): string {
  const line = (label: string, value: unknown) => `${label.padEnd(22)}${value === null || value === undefined ? "-" : String(value)}`;
  return [
    line("Contact", [d.contact_first_name, d.contact_last_name].filter(Boolean).join(" ") || null),
    line("Contact phone", d.contact_phone),
    line("Contact email", d.contact_email),
    line("Demo account", d.demo_account_name),
    line("Demo password", d.demo_account_password_set ? "(set)" : "(not set)"),
    line("Demo account required", d.demo_account_required),
    line("Notes", d.notes),
  ].join("\n");
}

/**
 * App-level TestFlight setup for a public external beta: beta groups, Beta App
 * Review Detail and Beta App localizations (`hands testflight beta-groups|review-detail|beta-description`).
 */
export function registerTestflightBetaCommands(
  testflight: Command,
  program: Command,
  resolveAppId: (input: string) => Promise<string>,
): void {
  const asJson = (local?: boolean) => jsonRequested(program, local);

  const groups = testflight
    .command("beta-groups")
    .description("App Store Connect beta groups of the app (no build needed).");

  groups
    .command("list <appIdOrSlug>")
    .description("List internal and external beta groups with their public link settings (app viewer).")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<{ groups: BetaGroup[] }>(`/api/apps/${appId}/testflight-beta-groups`);
      if (asJson(opts.json)) return console.log(JSON.stringify(result, null, 2));
      console.log(formatBetaGroups(result.groups));
    });

  groups
    .command("create <appIdOrSlug>")
    .description("Create an EXTERNAL beta group, optionally with a public TestFlight link (app admin).")
    .requiredOption("--name <name>", "Group name; must not already exist for the app.")
    .option("--public-link", "Enable the public link (https://testflight.apple.com/join/...).")
    .option("--public-link-limit <n>", "Maximum testers through the public link (1-10000); turns the limit on.")
    .option("--feedback", "Let testers send TestFlight feedback.")
    .option("--no-feedback", "Do not let testers send feedback.")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        opts: { name: string; publicLink?: boolean; publicLinkLimit?: string; feedback?: boolean; json?: boolean },
      ) => {
        const body: Record<string, unknown> = { name: opts.name };
        if (opts.publicLink !== undefined) body.public_link_enabled = opts.publicLink;
        if (opts.publicLinkLimit !== undefined) body.public_link_limit = parsePublicLinkLimit(opts.publicLinkLimit);
        if (opts.feedback !== undefined) body.feedback_enabled = opts.feedback;
        const appId = await resolveAppId(appIdOrSlug);
        const result = await apiRequest<{ group: BetaGroup; note?: string }>(`/api/apps/${appId}/testflight-beta-groups`, {
          method: "POST",
          body,
          retryOnUnauthorized: false,
        });
        if (asJson(opts.json)) return console.log(JSON.stringify(result, null, 2));
        console.log(`✔ Created external beta group ${result.group.id} (${result.group.name}).`);
        if (result.group.public_link) console.log(`  Public link: ${result.group.public_link}`);
        if (result.note) console.log(`  ${result.note}`);
      },
    );

  groups
    .command("update <appIdOrSlug> <groupId>")
    .description("Update a beta group's name, public link, tester limit or feedback (app admin). Public link options need an external group.")
    .option("--name <name>", "Rename the group.")
    .option("--public-link", "Enable the public link.")
    .option("--no-public-link", "Disable the public link.")
    .option("--public-link-limit <n>", "Maximum testers through the public link (1-10000); turns the limit on.")
    .option("--public-link-limit-enabled", "Turn the tester limit on.")
    .option("--no-public-link-limit-enabled", "Turn the tester limit off.")
    .option("--feedback", "Let testers send TestFlight feedback.")
    .option("--no-feedback", "Do not let testers send feedback.")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        groupId: string,
        opts: {
          name?: string;
          publicLink?: boolean;
          publicLinkLimit?: string;
          publicLinkLimitEnabled?: boolean;
          feedback?: boolean;
          json?: boolean;
        },
      ) => {
        const body: Record<string, unknown> = {};
        if (opts.name !== undefined) body.name = opts.name;
        if (opts.publicLink !== undefined) body.public_link_enabled = opts.publicLink;
        if (opts.publicLinkLimit !== undefined) body.public_link_limit = parsePublicLinkLimit(opts.publicLinkLimit);
        if (opts.publicLinkLimitEnabled !== undefined) body.public_link_limit_enabled = opts.publicLinkLimitEnabled;
        if (opts.feedback !== undefined) body.feedback_enabled = opts.feedback;
        if (Object.keys(body).length === 0) {
          throw new Error("Nothing to update: pass --name, --[no-]public-link, --public-link-limit, --[no-]public-link-limit-enabled or --[no-]feedback.");
        }
        const appId = await resolveAppId(appIdOrSlug);
        const result = await apiRequest<{ group: BetaGroup; note?: string }>(
          `/api/apps/${appId}/testflight-beta-groups/${encodeURIComponent(groupId)}`,
          { method: "PATCH", body },
        );
        if (asJson(opts.json)) return console.log(JSON.stringify(result, null, 2));
        console.log(`✔ Updated beta group ${result.group.id} (verified with App Store Connect).`);
        console.log(formatBetaGroups([result.group]));
        if (result.note) console.log(`  ${result.note}`);
      },
    );

  const review = testflight
    .command("review-detail")
    .description("Beta App Review Detail: contact, demo account and notes for Apple's beta reviewers.");

  review
    .command("get <appIdOrSlug>")
    .description("Show the Beta App Review Detail (app viewer). The demo password is never shown, only whether it is set.")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<{ review_detail: ReviewDetail }>(`/api/apps/${appId}/testflight-beta-review-detail`);
      if (asJson(opts.json)) return console.log(JSON.stringify(result, null, 2));
      console.log(formatReviewDetail(result.review_detail));
    });

  review
    .command("set <appIdOrSlug>")
    .description(
      "Set only the given Beta App Review Detail fields (app admin). The demo password is read from stdin " +
        "(--demo-account-password-stdin) or a named environment variable (--demo-account-password-env), never from argv.",
    )
    .option("--contact-first-name <name>", "Reviewer contact first name.")
    .option("--contact-last-name <name>", "Reviewer contact last name.")
    .option("--contact-phone <phone>", "Reviewer contact phone.")
    .option("--contact-email <email>", "Reviewer contact email.")
    .option("--demo-account-name <name>", "Demo account user name.")
    .option("--demo-account-password-stdin", "Read the demo account password from stdin.")
    .option("--demo-account-password-env <VAR>", "Read the demo account password from this environment variable.")
    .option("--demo-account-required", "Reviewers need the demo account to sign in.")
    .option("--no-demo-account-required", "Reviewers do not need a demo account.")
    .option("--notes <text>", "Notes for the reviewer (at most 4000 characters).")
    .option("--notes-file <path>", "Read the reviewer notes from a file.")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        opts: {
          contactFirstName?: string;
          contactLastName?: string;
          contactPhone?: string;
          contactEmail?: string;
          demoAccountName?: string;
          demoAccountPasswordStdin?: boolean;
          demoAccountPasswordEnv?: string;
          demoAccountRequired?: boolean;
          notes?: string;
          notesFile?: string;
          json?: boolean;
        },
      ) => {
        if (opts.notes !== undefined && opts.notesFile !== undefined) {
          throw new Error("Use only one of --notes and --notes-file.");
        }
        const body: Record<string, unknown> = {};
        if (opts.contactFirstName !== undefined) body.contact_first_name = opts.contactFirstName;
        if (opts.contactLastName !== undefined) body.contact_last_name = opts.contactLastName;
        if (opts.contactPhone !== undefined) body.contact_phone = opts.contactPhone;
        if (opts.contactEmail !== undefined) body.contact_email = opts.contactEmail;
        if (opts.demoAccountName !== undefined) body.demo_account_name = opts.demoAccountName;
        if (opts.demoAccountRequired !== undefined) body.demo_account_required = opts.demoAccountRequired;
        if (opts.notes !== undefined) body.notes = opts.notes;
        if (opts.notesFile !== undefined) body.notes = readFileSync(opts.notesFile, "utf8").trim();
        const password = await resolveDemoPassword(opts);
        if (password !== undefined) body.demo_account_password = password;
        if (Object.keys(body).length === 0) {
          throw new Error("Nothing to set: pass at least one field option (see --help).");
        }
        const appId = await resolveAppId(appIdOrSlug);
        const result = await apiRequest<{ updated_fields: string[]; review_detail: ReviewDetail }>(
          `/api/apps/${appId}/testflight-beta-review-detail`,
          { method: "PUT", body },
        );
        if (asJson(opts.json)) return console.log(JSON.stringify(result, null, 2));
        console.log(`✔ Updated ${result.updated_fields.join(", ")} (verified with App Store Connect).`);
        console.log(formatReviewDetail(result.review_detail));
      },
    );

  const description = testflight
    .command("beta-description")
    .description("App-level Beta App localizations: description, feedback email, marketing and privacy policy URLs.");

  description
    .command("get <appIdOrSlug>")
    .description("Show the Beta App localizations (app viewer).")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<{ localizations: BetaLocalization[] }>(
        `/api/apps/${appId}/testflight-beta-app-description`,
      );
      if (asJson(opts.json)) return console.log(JSON.stringify(result, null, 2));
      if (result.localizations.length === 0) return console.log("No Beta App localizations.");
      for (const loc of result.localizations) {
        console.log(`${loc.locale ?? "?"}`);
        console.log(`  description:        ${loc.description ?? "-"}`);
        console.log(`  feedback email:     ${loc.feedback_email ?? "-"}`);
        console.log(`  marketing URL:      ${loc.marketing_url ?? "-"}`);
        console.log(`  privacy policy URL: ${loc.privacy_policy_url ?? "-"}`);
      }
    });

  description
    .command("set <appIdOrSlug>")
    .description(
      "Create or update the given Beta App localization fields; other locales and fields stay as they are (app publisher). " +
        "A locale that does not exist yet needs a description.",
    )
    .option("--description <locale=text>", "Beta App Description. Repeat for multiple locales.", collect, [])
    .option("--description-file <locale=path>", "Read the description from a file. Repeatable.", collect, [])
    .option("--feedback-email <locale=email>", "Feedback email. Repeatable.", collect, [])
    .option("--marketing-url <locale=url>", "Marketing URL (https). Repeatable.", collect, [])
    .option("--privacy-policy-url <locale=url>", "Privacy policy URL (https). Repeatable.", collect, [])
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        opts: {
          description: string[];
          descriptionFile: string[];
          feedbackEmail: string[];
          marketingUrl: string[];
          privacyPolicyUrl: string[];
          json?: boolean;
        },
      ) => {
        const body = buildBetaDescriptionBody(opts);
        const appId = await resolveAppId(appIdOrSlug);
        const result = await apiRequest<{ updated_locales: string[] }>(
          `/api/apps/${appId}/testflight-beta-app-description`,
          { method: "PUT", body },
        );
        if (asJson(opts.json)) return console.log(JSON.stringify(result, null, 2));
        console.log(`✔ Updated ${result.updated_locales.join(", ")} (verified with App Store Connect).`);
      },
    );
}
