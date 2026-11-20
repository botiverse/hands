/**
 * A section of the app overview: a quiet heading line (icon, name, a hint and
 * at most one action at its end) over the section's rows, and the empty state
 * a section shows when it has nothing yet.
 */
import type { ReactNode } from "react";
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  ListRowGroup,
} from "@botiverse/raft-ui";

export function OverviewSection({
  id,
  icon,
  title,
  hint,
  action,
  children,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex min-h-8 items-center gap-2">
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

export function OverviewEmpty({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <ListRowGroup>
      <EmptyState className="py-8">
        <EmptyStateContent>
          <EmptyStateIcon>{icon}</EmptyStateIcon>
          <EmptyStateTitle>{title}</EmptyStateTitle>
          <EmptyStateDescription>{description}</EmptyStateDescription>
        </EmptyStateContent>
        {action && <EmptyStateActions>{action}</EmptyStateActions>}
      </EmptyState>
    </ListRowGroup>
  );
}
