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
import { Button, EmptyState, EmptyStateTitle, Input, Label, Skeleton } from "raft-ui";

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

  return (
    <section className="border-t border-line-hairline pt-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground-strong">
          {t("Trusted publishers (GitHub Actions)", "可信发布者（GitHub Actions）")}
        </h3>
        {!adding && (
          <Button variant="outline" className="py-1! px-2! text-xs! whitespace-nowrap" onClick={() => setAdding(true)}>
            {t("+ Add", "+ 添加")}
          </Button>
        )}
      </div>
      {publishers.isLoading && <Skeleton className="h-8 w-full" />}
      {publishers.error && (
        <p className="text-danger">{t("Failed:", "加载失败：")} {errorMessage(publishers.error)}</p>
      )}
      {adding && (
        <form
          className="mb-4 grid gap-3 rounded border border-line-hairline p-3 sm:grid-cols-2"
          onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
        >
          <div className="space-y-1">
            <Label htmlFor="tp-repository">{t("Repository", "仓库")}</Label>
            <Input id="tp-repository" placeholder="owner/repo" value={repository} onChange={(e) => setRepository(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <Label htmlFor="tp-workflow">{t("Workflow file", "Workflow 文件")}</Label>
            <Input id="tp-workflow" placeholder=".github/workflows/release.yml" value={workflow} onChange={(e) => setWorkflow(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <Label htmlFor="tp-refs">{t("Allowed refs", "允许的分支/tag")}</Label>
            <Input id="tp-refs" placeholder="refs/heads/main refs/tags/v*" value={refs} onChange={(e) => setRefs(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <Label htmlFor="tp-environment">{t("GitHub environment (optional)", "GitHub environment（可选）")}</Label>
            <Input id="tp-environment" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={create.isPending}>{t("Add", "添加")}</Button>
            <Button type="button" variant="outline" onClick={() => setAdding(false)}>{t("Cancel", "取消")}</Button>
          </div>
        </form>
      )}
      {publishers.data && rows.length === 0 && !adding && (
        <EmptyState>
          <EmptyStateTitle>{t("No trusted publishers yet.", "暂无可信发布者。")}</EmptyStateTitle>
        </EmptyState>
      )}
      {rows.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-foreground-muted text-left border-b border-line-hairline">
              <th className="font-normal py-1 pr-2">{t("Repository", "仓库")}</th>
              <th className="font-normal py-1 pr-2">{t("Workflow", "Workflow")}</th>
              <th className="font-normal py-1 pr-2">{t("Refs", "分支/tag")}</th>
              <th className="font-normal py-1 pr-2">{t("Last used", "上次使用")}</th>
              <th className="font-normal py-1">{t("Actions", "操作")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-b border-line-hairline hover:bg-fill-muted">
                <td className="py-2 pr-2">
                  <div className="font-medium">{p.repository}</div>
                  <div className="text-xs text-foreground-muted">
                    {p.environment ? t(`environment ${p.environment}`, `environment ${p.environment}`) : t("any environment", "任意 environment")}
                    {p.repository_id ? ` · id ${p.repository_id}` : ""}
                  </div>
                </td>
                <td className="py-2 pr-2 font-mono text-xs">{p.workflow_path}</td>
                <td className="py-2 pr-2 font-mono text-xs">{p.ref_patterns.join(" ")}</td>
                <td className="py-2 pr-2 text-xs text-foreground-muted">
                  {p.last_used_at ? new Date(p.last_used_at).toISOString().slice(0, 16).replace("T", " ") : "—"}
                </td>
                <td className="py-2 text-xs">
                  <Button
                    variant="link"
                    size="sm"
                    className="text-danger"
                    disabled={revoke.isPending}
                    onClick={() => {
                      if (confirm(t(`Stop trusting ${p.repository} ${p.workflow_path}? Tokens it minted stop working.`, `不再信任 ${p.repository} ${p.workflow_path}？它签发的令牌会立即失效。`))) {
                        revoke.mutate(p.id);
                      }
                    }}
                  >
                    {t("Remove", "移除")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-xs text-foreground-muted mt-2">
        {t(
          `A matching workflow run gets a one-hour publisher token without any stored secret. In the job set "permissions: id-token: write", then run "hands github-oidc-login --app ${appRef}".`,
          `匹配的 workflow 运行无需存任何密钥即可获得一小时有效的发布令牌。在 job 中设置 "permissions: id-token: write"，然后运行 "hands github-oidc-login --app ${appRef}"。`,
        )}
      </p>
    </section>
  );
}
