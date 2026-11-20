/**
 * Parts shared by the connectors on the Integrations page: the state a
 * connector reports for its row in the list, and the rows its column is
 * made of (design: patterns/forms, "A setting's row" and "Danger zone").
 */
import { useId, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import {
  Badge,
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowGroup,
  ListRowIcon,
  ListRowTitle,
} from "@botiverse/raft-ui";

/** What a connector's row says about it: connected, needs attention, turned
 *  off by an admin, or not connected. */
export type ConnectorState = {
  tone: "connected" | "attention" | "paused" | "off";
  label: string;
  /** One line under the row's description: the package, the key, why it needs attention. */
  detail?: string | undefined;
};

export function ConnectorStateBadge({ state }: { state: ConnectorState }) {
  if (state.tone === "connected") return <Badge appearance="soft" variant="success">{state.label}</Badge>;
  if (state.tone === "attention") return <Badge appearance="soft" variant="warning">{state.label}</Badge>;
  return <Badge appearance="outline" variant="muted">{state.label}</Badge>;
}

/** A display row: a title, what it means, and a control at its end. */
export function SettingRow({
  title,
  description,
  children,
  testId,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** The control or value at the row's end. */
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <ListRow variant="plain" interactive={false} className="flex-wrap" data-testid={testId}>
      <ListRowBody className="min-w-48">
        <ListRowTitle className="whitespace-normal">{title}</ListRowTitle>
        {description && <ListRowDescription wrap>{description}</ListRowDescription>}
      </ListRowBody>
      {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </ListRow>
  );
}

/** The danger zone at the end of a connector: one red row that removes it,
 *  confirmed before it runs. Named by its title alone. */
export function DangerRow({
  title,
  description,
  disabled,
  onClick,
}: {
  title: string;
  description: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  const id = useId();
  return (
    <ListRowGroup>
      <ListRow
        variant="plain"
        tone="danger"
        disabled={disabled}
        onClick={onClick}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
      >
        <ListRowIcon><Trash2 /></ListRowIcon>
        <ListRowBody>
          <ListRowTitle id={`${id}-title`}>{title}</ListRowTitle>
          <ListRowDescription id={`${id}-description`} wrap>{description}</ListRowDescription>
        </ListRowBody>
      </ListRow>
    </ListRowGroup>
  );
}

/** Save and Cancel under a form in a connector's column: Save first, at the
 *  start of the line (patterns/forms, "Settings saved together"). */
export function FormActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}
