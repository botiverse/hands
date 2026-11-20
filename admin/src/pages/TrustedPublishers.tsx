/**
 * Trusted publishers — GitHub Actions workflows that may publish this app
 * without a stored token. A matching run exchanges its GitHub OIDC token for a
 * one-hour deploy token (`hands github-oidc-login --app <app>`).
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createTrustedPublisher,
  listTrustedPublishers,
  revokeTrustedPublisher,
} from "../lib/api";
import { errorMessage } from "../lib/errorMessage";
import { useText } from "../lib/locale";
import { useToast } from "../components/Toast";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowGroup,
  ListRowSubtitle,
  ListRowTitle,
  Skeleton,
  TextLink,
} from "@botiverse/raft-ui";
import { Workflow } from "lucide-react";
import { ConfirmActionDialog } from "../components/ConfirmActionDialog";
import { SectionNote, SettingsSection } from "../components/SettingsPage";

export function TrustedPublisherList({ appId, appSlug }: { appId: string; appSlug?: string | undefined }) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [repository, setRepository] = useState("");
  const [workflow, setWorkflow] = useState(".github/workflows/");
  const [refs, setRefs] = useState("refs/heads/main");
  const [environment, setEnvironment] = useState("");
  const key = ["app-trusted-publishers", appId];
  const publishers = useQuery({ queryKey: key, queryFn: () => listTrustedPublishers(appId) });
  const create = useMutation({
    mutationFn: () => createTrustedPublisher(appId, {
      repository: repository.trim(),
      workflow_path: workflow.trim(),
      ref_patterns: refs.split(/[\s,]+/).map((r) => r.trim()).filter(Boolean),
      ...(environment.trim() ? { environment: environment.trim() } : {}),
    }),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Trusted publisher added", "可信发布者已添加") });
      setAdding(false);
      setRepository("");
      setWorkflow(".github/workflows/");
      setRefs("refs/heads/main");
      setEnvironment("");
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.show({ kind: "error", title: t("Add failed", "添加失败"), description: errorMessage(e) }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeTrustedPublisher(appId, id),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Trusted publisher removed", "可信发布者已移除") });
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ["app-deploy-tokens", appId] });
    },
    onError: (e) => toast.show({ kind: "error", title: t("Remove failed", "移除失败"), description: errorMessage(e) }),
  });
  const rows = publishers.data?.trusted_publishers ?? [];
  const appRef = appSlug ?? appId;
  const [removing, setRemoving] = useState<(typeof rows)[number] | null>(null);

  return (
    <SettingsSection
      id="app-access-publishers"
      icon={<Workflow />}
      title={t("Trusted publishers", "可信发布者")}
      hint="GitHub Actions"
      action={<TextLink className="text-footnote" onClick={() => setAdding(true)}>{t("Add publisher", "添加发布者")}</TextLink>}
    >
      <ListRowGroup className="@container">
        {publishers.isLoading && <ListRow variant="plain" interactive={false}><Skeleton className="h-6 w-full" /></ListRow>}
        {publishers.error && (
          <ListRow variant="plain" interactive={false}>
            <ListRowBody><ListRowDescription wrap className="text-danger-strong">{t("Failed:", "加载失败：")} {errorMessage(publishers.error)}</ListRowDescription></ListRowBody>
          </ListRow>
        )}
        {publishers.data && rows.length === 0 && (
          <ListRow variant="plain" interactive={false}>
            <ListRowBody><ListRowDescription wrap>{t("No trusted publishers yet.", "暂无可信发布者。")}</ListRowDescription></ListRowBody>
          </ListRow>
        )}
        {rows.map((p) => (
          <ListRow key={p.id} variant="plain" interactive={false} className="@max-lg:flex-wrap">
            <ListRowBody>
              <ListRowTitle>{p.repository}</ListRowTitle>
              <ListRowSubtitle className="font-mono">{p.workflow_path}</ListRowSubtitle>
              <ListRowDescription wrap>
                <span className="font-mono">{p.ref_patterns.join(" ")}</span>
                {" · "}
                {p.environment ? t(`environment ${p.environment}`, `environment ${p.environment}`) : t("any environment", "任意 environment")}
                {p.repository_id ? ` · id ${p.repository_id}` : ""}
                {" · "}
                {p.last_used_at
                  ? t(`last used ${new Date(p.last_used_at).toISOString().slice(0, 16).replace("T", " ")}`, `上次使用 ${new Date(p.last_used_at).toISOString().slice(0, 16).replace("T", " ")}`)
                  : t("never used", "从未使用")}
              </ListRowDescription>
            </ListRowBody>
            <Button variant="outline" className="@max-lg:ml-auto" disabled={revoke.isPending} onClick={() => setRemoving(p)}>
              {t("Remove", "移除")}
            </Button>
          </ListRow>
        ))}
      </ListRowGroup>
      <SectionNote>
        {t(
          `A matching workflow run gets a one-hour publisher token without any stored secret. In the job set "permissions: id-token: write", then run "hands github-oidc-login --app ${appRef}".`,
          `匹配的 workflow 运行无需存任何密钥即可获得一小时有效的发布令牌。在 job 中设置 "permissions: id-token: write"，然后运行 "hands github-oidc-login --app ${appRef}"。`,
        )}
      </SectionNote>
      {adding && (
        <Dialog open onOpenChange={(open) => { if (!open) setAdding(false); }}>
          <DialogContent>
            <DialogHeader><DialogTitle>{t("Add trusted publisher", "添加可信发布者")}</DialogTitle></DialogHeader>
            <DialogBody>
              <form id="add-trusted-publisher" className="stack-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
                <Field>
                  <FieldLabel htmlFor="tp-repository">{t("Repository", "仓库")}</FieldLabel>
                  <Input id="tp-repository" placeholder="owner/repo" value={repository} onChange={(e) => setRepository(e.target.value)} required autoFocus />
                </Field>
                <Field>
                  <FieldLabel htmlFor="tp-workflow">{t("Workflow file", "Workflow 文件")}</FieldLabel>
                  <Input id="tp-workflow" placeholder=".github/workflows/release.yml" value={workflow} onChange={(e) => setWorkflow(e.target.value)} required />
                </Field>
                <Field>
                  <FieldLabel htmlFor="tp-refs">{t("Allowed refs", "允许的分支/tag")}</FieldLabel>
                  <Input id="tp-refs" placeholder="refs/heads/main refs/tags/v*" value={refs} onChange={(e) => setRefs(e.target.value)} required />
                  <FieldDescription>{t("Separate with spaces or commas.", "用空格或逗号分隔。")}</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="tp-environment" optional>{t("GitHub environment", "GitHub environment")}</FieldLabel>
                  <Input id="tp-environment" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
                </Field>
              </form>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" size="lg" onClick={() => setAdding(false)}>{t("Cancel", "取消")}</Button>
              <Button type="submit" form="add-trusted-publisher" variant="primary" size="lg" loading={create.isPending} disabled={create.isPending}>{t("Add", "添加")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      <ConfirmActionDialog
        open={removing !== null}
        title={t("Stop trusting this workflow?", "不再信任此 workflow？")}
        objectLabel={removing?.repository ?? ""}
        objectHint={removing?.workflow_path}
        body={t("Tokens it minted stop working at once. Add it again to trust it again.", "它签发的令牌会立即失效。需要时可以重新添加。")}
        confirmLabel={t("Remove", "移除")}
        confirmKind="danger"
        pending={revoke.isPending}
        onConfirm={() => { if (removing) revoke.mutate(removing.id, { onSettled: () => setRemoving(null) }); }}
        onCancel={() => setRemoving(null)}
      />
    </SettingsSection>
  );
}
