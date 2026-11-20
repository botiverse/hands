/**
 * The frame of an app page that is read top to bottom rather than as one
 * list (design: patterns/forms, "A setting's row"): the panel header with
 * the page's title, then sections, each a heading line over one or more
 * ListRowGroups of plain rows. Settings, the App Store page and similar use
 * it; list pages use ListPage.
 */
import type { ReactNode } from "react";
import {
  Panel,
  PanelHeader,
  PanelHeaderContent,
  PanelHeaderIcon,
  PanelHeading,
  PanelMeta,
  PanelScrollViewport,
  PanelTitle,
} from "@botiverse/raft-ui";
import { cn } from "@botiverse/raft-ui/cn";

export function SettingsPage({
  icon,
  title,
  meta,
  actions,
  busy,
  aside,
  children,
}: {
  icon: ReactNode;
  title: string;
  /** Beside the title: the app's name, a count. */
  meta?: ReactNode;
  /** PanelActions at the header's end. */
  actions?: ReactNode;
  busy?: boolean;
  /** A DetailColumn beside the page, or null. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1">
      <Panel className={cn("flex min-h-0 min-w-0 flex-1 flex-col", aside && "max-lg:hidden")} aria-label={title}>
        <PanelHeader>
          <PanelHeaderIcon className="max-md:hidden">{icon}</PanelHeaderIcon>
          <PanelHeaderContent>
            <PanelHeading>
              <PanelTitle render={<h1 />}>{title}</PanelTitle>
            </PanelHeading>
            {meta && <PanelMeta>{meta}</PanelMeta>}
          </PanelHeaderContent>
          {actions}
        </PanelHeader>
        <PanelScrollViewport
          className="min-h-0 flex-1"
          contentClassName="flex w-full max-w-3xl flex-col gap-8 px-(--column-margin) pt-4 pb-10"
          aria-busy={busy || undefined}
        >
          {children}
        </PanelScrollViewport>
      </Panel>
      {aside}
    </div>
  );
}

/** One section of a settings page: its icon and name, a hint only where it
 *  says something the name doesn't, an action at the end, then its groups
 *  12px apart. */
export function SettingsSection({
  id,
  icon,
  title,
  hint,
  action,
  children,
  className,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cn("stack-y-3", className)}>
      <div className="flex min-h-6 items-center gap-2">
        <h2 id={id} className="flex shrink-0 items-center gap-2 text-footnote font-bold text-foreground-hint [&_svg]:size-4">
          <span aria-hidden className="flex">{icon}</span>
          {title}
        </h2>
        {hint && <span className="min-w-0 truncate text-footnote text-foreground-hint">{hint}</span>}
        {action && <div className="ml-auto flex shrink-0 items-center">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/** A line of explanation under a section's groups, for what applies to the
 *  whole section (where it is stored, who can change it). */
export function SectionNote({ children }: { children: ReactNode }) {
  return <p className="px-1 text-footnote text-foreground-muted">{children}</p>;
}
