/**
 * The frame of an app page that is a list (design: patterns/page-structure,
 * "A page of a list"): the panel header with the title and the count, a
 * toolbar of filters and the add action, and the list, which scrolls alone.
 * Opening an item puts its details in a column beside the list, with its own
 * header; below the two-column width the column takes the page's place and
 * its close button returns to the list.
 */
import type { ReactNode } from "react";
import { X } from "lucide-react";
import {
  Panel,
  PanelAction,
  PanelActions,
  PanelHeader,
  PanelHeaderContent,
  PanelHeaderIcon,
  PanelHeading,
  PanelMeta,
  PanelScrollViewport,
  PanelTitle,
  Text,
} from "@botiverse/raft-ui";
import { cn } from "@botiverse/raft-ui/cn";
import { useText } from "../lib/locale";

export function ListPage({
  icon,
  title,
  count,
  toolbar,
  busy,
  detail,
  children,
}: {
  icon: ReactNode;
  title: string;
  /** Shown in Space Mono beside the title once known. */
  count?: number | undefined;
  toolbar?: ReactNode;
  busy?: boolean;
  /** The open item's column, or null. */
  detail?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1">
      <Panel className={cn("flex min-h-0 min-w-0 flex-1 flex-col", detail && "max-lg:hidden")} aria-label={title}>
        <PanelHeader>
          <PanelHeaderIcon className="max-md:hidden">{icon}</PanelHeaderIcon>
          <PanelHeaderContent>
            <PanelHeading>
              <PanelTitle render={<h1 />}>{title}</PanelTitle>
            </PanelHeading>
            {count !== undefined && <PanelMeta className="font-mono">{count}</PanelMeta>}
          </PanelHeaderContent>
        </PanelHeader>
        {toolbar && (
          <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line-seam px-(--column-margin) py-1.5">
            {toolbar}
          </div>
        )}
        <PanelScrollViewport
          className="min-h-0 flex-1"
          contentClassName="flex w-full max-w-5xl flex-col gap-8 pt-3 pb-10"
          aria-busy={busy || undefined}
        >
          {children}
        </PanelScrollViewport>
      </Panel>
      {detail}
    </div>
  );
}

/** The column of the item open beside a list. */
export function DetailColumn({
  label,
  title,
  meta,
  actions,
  onClose,
  children,
}: {
  /** The column's accessible name. */
  label: string;
  title: ReactNode;
  meta?: ReactNode;
  /** PanelActions that change the view (Open as a page), before Close. */
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useText();
  return (
    <Panel
      edge="attached"
      aria-label={label}
      className="flex min-h-0 min-w-0 flex-col max-lg:flex-1 lg:w-[440px] lg:shrink-0"
    >
      <PanelHeader>
        <PanelHeaderContent>
          <PanelHeading>
            <PanelTitle render={<h2 />}>{title}</PanelTitle>
          </PanelHeading>
          {meta && <PanelMeta>{meta}</PanelMeta>}
        </PanelHeaderContent>
        <PanelActions>
          {actions}
          <PanelAction aria-label={t("Close", "关闭")} onClick={onClose}>
            <X />
          </PanelAction>
        </PanelActions>
      </PanelHeader>
      <PanelScrollViewport className="min-h-0 flex-1" contentClassName="flex flex-col gap-6 px-(--column-margin) pt-4 pb-10">
        {children}
      </PanelScrollViewport>
    </Panel>
  );
}

/** A section of a detail column: a group heading over its content. */
export function DetailSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-6 items-center gap-2">
        <Text.Sans render={<h3 />} size="group">{title}</Text.Sans>
        {action && <div className="ml-auto flex shrink-0 items-center">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/** The heading line of a group of rows on a list page. */
export function ListHeading({
  id,
  icon,
  title,
  hint,
  action,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center gap-2 px-(--column-margin)">
      <h2 id={id} className="flex shrink-0 items-center gap-2 text-footnote font-bold text-foreground-hint [&_svg]:size-4">
        <span aria-hidden className="flex">{icon}</span>
        {title}
      </h2>
      {hint && <span className="min-w-0 truncate font-mono text-footnote text-foreground-hint">{hint}</span>}
      {action && <div className="ml-auto flex shrink-0 items-center">{action}</div>}
    </div>
  );
}
