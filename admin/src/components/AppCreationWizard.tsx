import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { createApp } from "../lib/api";
import { useToast } from "./Toast";

/**
 * App creation wizard — 3 steps:
 *   1. Basics: name / slug / description
 *   2. Product types: review parser/product families that will be seeded
 *   3. Channels: review seeded distribution lanes
 *
 * On save, the backend `POST /api/apps` handler now seeds default
 * product_types / channels via a single batch insert
 * (see worker/src/routes/apps.ts handleCreateApp). The wizard just
 * collects the basics — the seeding is automatic.
 *
 * The wizard is currently "informational" — it shows what's being created
 * so the user understands the consequences. It should not expose checkboxes
 * for values that the backend does not yet accept.
 */

const DEFAULT_PRODUCT_TYPES: Array<{
  name: string;
  display_name: string;
  description: string;
  artifact_note: string;
}> = [
  {
    name: "android-apk",
    display_name: "Android APK",
    description: "Android application package — direct install",
    artifact_note: "APK assets are selected later when creating builds/releases.",
  },
  {
    name: "electron-installer",
    display_name: "Electron desktop app",
    description: "Cross-platform desktop (darwin / linux / win32)",
    artifact_note:
      "Platform-specific installers such as dmg, exe, AppImage, and arch variants are chosen at artifact upload time.",
  },
  {
    name: "rn-bundle",
    display_name: "React Native OTA bundle",
    description: "JS bundle hot-update (replaces JS layer only)",
    artifact_note: "Bundle assets are selected later when creating builds/releases.",
  },
];

const DEFAULT_CHANNELS = [
  {
    slug: "main",
    name: "Main",
    description: "Primary stable lane for normal users",
    enabled_product_types: ["android-apk", "electron-installer", "rn-bundle"],
  },
  {
    slug: "preview",
    name: "Preview",
    description: "Pre-release lane for QA and selected testers",
    enabled_product_types: ["android-apk", "rn-bundle"],
  },
  {
    slug: "nightly",
    name: "Nightly",
    description: "Fast-moving lane for internal daily validation",
    enabled_product_types: ["android-apk"],
  },
];

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

export function AppCreationWizard({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugAuto, setSlugAuto] = useState(true);
  const [description, setDescription] = useState("");
  const createToastId = useRef<number | null>(null);

  const toast = useToast();

  const create = useMutation({
    mutationFn: () =>
      createApp({
        slug: slug || slugify(name),
        name,
        platform: "android",
        description: description.trim() || undefined,
      }),
    onMutate: () => {
      createToastId.current = toast.show({
        kind: "loading",
        title: `Creating app '${name}'...`,
        ttlMs: 0,
      });
    },
    onSuccess: () => {
      const patch = {
        kind: "success",
        title: `App '${slug || slugify(name)}' created`,
        description: `Seeded ${DEFAULT_PRODUCT_TYPES.length} product types and ${DEFAULT_CHANNELS.length} channels`,
      } as const;
      if (createToastId.current !== null) toast.update(createToastId.current, patch);
      else toast.show(patch);
      createToastId.current = null;
      onCreated();
    },
    onError: (e) => {
      const patch = {
        kind: "error",
        title: "Failed to create app",
        description: (e as Error).message,
      } as const;
      if (createToastId.current !== null) toast.update(createToastId.current, patch);
      else toast.show(patch);
      createToastId.current = null;
    },
  });

  const canAdvance =
    (step === 1 && name.trim().length > 0 && (slug.trim().length > 0 || slugify(name).length > 0)) ||
    step === 2 ||
    step === 3;

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center p-4 z-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="card max-w-2xl w-full relative">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 text-slate-400 hover:text-slate-700 w-8 h-8 flex items-center justify-center rounded-md hover:bg-slate-100"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-6 text-xs text-slate-500">
          {[1, 2, 3].map((n) => (
            <div key={n} className="flex items-center gap-2">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center font-medium ${
                  n === step
                    ? "bg-blue-600 text-white"
                    : n < step
                      ? "bg-blue-100 text-blue-700"
                      : "bg-slate-100 text-slate-500"
                }`}
              >
                {n < step ? "✓" : n}
              </div>
              <span className={n === step ? "font-medium text-slate-700" : ""}>
                {n === 1 ? "Basics" : n === 2 ? "Product types" : "Channels"}
              </span>
              {n < 3 && <span className="text-slate-300 mx-2">→</span>}
            </div>
          ))}
        </div>

        {step === 1 && (
          <div>
            <h2 className="text-lg font-bold mb-4">Create app — Basics</h2>
            <div className="space-y-3">
              <div>
                <label className="label">Name *</label>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (slugAuto) setSlug(slugify(e.target.value));
                  }}
                  placeholder="My App"
                  autoFocus
                />
              </div>
              <div>
                <label className="label">Slug (kebab-case, auto-generated from name)</label>
                <input
                  className="input font-mono text-xs"
                  value={slug}
                  onChange={(e) => {
                    setSlug(e.target.value);
                    setSlugAuto(false);
                  }}
                  placeholder="my-app"
                />
              </div>
              <div>
                <label className="label">Description (optional)</label>
                <textarea
                  className="input min-h-[60px]"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What does this app do?"
                />
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="text-lg font-bold mb-4">Create app — Product types</h2>
            <p className="text-sm text-slate-500 mb-4">
              These product families will be seeded for the app. They define parsers
              and release flows; concrete platform artifacts are picked later when
              you upload assets for a release.
            </p>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {DEFAULT_PRODUCT_TYPES.map((pt) => (
                <div key={pt.name} className="border border-slate-200 rounded-lg p-3">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 h-5 w-5 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-medium">
                      ✓
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{pt.display_name}</div>
                      <div className="text-xs font-mono text-slate-500">{pt.name}</div>
                      <div className="text-xs text-slate-600 mt-1">{pt.description}</div>
                      <div className="text-xs text-slate-500 mt-2">
                        {pt.artifact_note}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h2 className="text-lg font-bold mb-4">Create app — Channels</h2>
            <p className="text-sm text-slate-500 mb-4">
              Channels are the delivery lanes clients use to fetch updates.
              Hands keeps maturity simple: publish to main for stable users,
              preview for validation, and nightly for fast internal iteration.
            </p>

            <div className="pt-1">
              <div className="text-xs font-medium text-slate-700 mb-2">
                Default distribution channels (will be seeded):
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {DEFAULT_CHANNELS.map((c) => (
                  <div
                    key={c.slug}
                    className="border border-slate-200 rounded-md p-2 bg-slate-50"
                  >
                    <div className="font-medium text-sm">{c.name}</div>
                    <div className="text-xs font-mono text-slate-500">{c.slug}</div>
                    <div className="text-xs text-slate-600 mt-1">
                      {c.description}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-2">
                      Products: {c.enabled_product_types.join(", ")}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="flex gap-2 justify-between pt-4 mt-4 border-t border-slate-100">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => (step === 1 ? onClose() : setStep((step - 1) as 1 | 2 | 3))}
          >
            {step === 1 ? "Cancel" : "← Back"}
          </button>
          {step < 3 ? (
            <button
              type="button"
              className="btn-primary"
              onClick={() => setStep((step + 1) as 1 | 2 | 3)}
              disabled={!canAdvance}
            >
              Next →
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              onClick={() => create.mutate()}
              disabled={
                create.isPending ||
                !name.trim()
              }
            >
              {create.isPending ? "Creating…" : "Create app + seed defaults"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
