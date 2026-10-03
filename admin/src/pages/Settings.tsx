import { useQuery } from "@tanstack/react-query";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
  TextHeading,
  TextMono,
  TextSans,
} from "raft-ui";
import { getAuthMe } from "../lib/api";
import { AppearanceSettings } from "../components/AppearanceSettings";

function OrgRoleBadge({ role }: { role: string | null }) {
  if (!role) return <>—</>;
  if (role === "owner") return <Badge variant="accent">{role}</Badge>;
  if (role === "admin") return <Badge variant="information">{role}</Badge>;
  return <>{role}</>;
}

export function Settings() {
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const account = me.data?.account;
  const raftCallbackUrl = `${window.location.origin}/login/raft/callback`;

  return (
    <div className="space-y-6">
      <TextHeading level={1} className="text-2xl leading-8">
        Settings
      </TextHeading>

      {/* Current account + org context */}
      {account && (
        <Card>
          <CardHeader>
            <CardTitle>Current account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <DescriptionList direction="horizontal">
              <DescriptionItem>
                <DescriptionTerm>Display name</DescriptionTerm>
                <DescriptionDetails>{account.display_name}</DescriptionDetails>
              </DescriptionItem>
              <DescriptionItem>
                <DescriptionTerm>Principal type</DescriptionTerm>
                <DescriptionDetails>
                  {account.principal_type === "agent" ? (
                    <Badge variant="accent">agent (Raft)</Badge>
                  ) : account.principal_type === "human" ? (
                    <>human (Raft)</>
                  ) : (
                    <>{account.principal_type}</>
                  )}
                </DescriptionDetails>
              </DescriptionItem>
              <DescriptionItem>
                <DescriptionTerm>Server</DescriptionTerm>
                <DescriptionDetails className="font-mono">
                  {account.server_slug ?? account.server_id}
                </DescriptionDetails>
              </DescriptionItem>
              <DescriptionItem>
                <DescriptionTerm>Server role (from Raft)</DescriptionTerm>
                <DescriptionDetails>
                  {account.server_role ?? "—"}
                </DescriptionDetails>
              </DescriptionItem>
              <DescriptionItem>
                <DescriptionTerm>Org id</DescriptionTerm>
                <DescriptionDetails className="font-mono">
                  {account.org_id ?? "—"}
                </DescriptionDetails>
              </DescriptionItem>
              <DescriptionItem>
                <DescriptionTerm>Your org role</DescriptionTerm>
                <DescriptionDetails>
                  <OrgRoleBadge role={account.org_role} />
                </DescriptionDetails>
              </DescriptionItem>
            </DescriptionList>
            <TextSans
              size="caption"
              className="border-t border-line-hairline pt-3"
            >
              Signed in with Raft. To change role, ask an organization owner or
              admin in Organization settings.
            </TextSans>
          </CardContent>
        </Card>
      )}

      {/* Appearance: RUI theme family + mode; persisted per browser */}
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>
            Choose how the dashboard looks. Preferences are saved in this
            browser.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AppearanceSettings />
        </CardContent>
      </Card>

      {/* Infrastructure (existing static info) */}
      <Card>
        <CardHeader>
          <CardTitle>Infrastructure</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <TextSans size="small">
            Admin access uses Login with Raft. Access follows your Raft
            organization membership and role.
          </TextSans>
          <div className="space-y-1">
            <TextSans size="caption">Raft Callback URL</TextSans>
            <TextMono size="code" className="break-all">
              {raftCallbackUrl}
            </TextMono>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
