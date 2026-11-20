/**
 * Organization › Webhooks: a page of a list. Each webhook is a row with its
 * endpoint and the events it gets; opening one shows a column with a switch
 * that pauses deliveries at once, the endpoint and events (each edited in a
 * dialog), the secret's state, the recent deliveries, and archiving it,
 * which a dialog confirms.
 *
 * The secret is written once, when the webhook is added: Hands signs every
 * delivery with it and never shows it again. Adding offers to generate one.
 */
import { useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Archive, Plus, Webhook as WebhookIcon } from "lucide-react";
import {
  Badge,
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  EmptyStateActions,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  ListRow,
  ListRowBody,
  ListRowBottom,
  ListRowDescription,
  ListRowGroup,
  ListRowIcon,
  ListRowMeta,
  ListRowSubtitle,
  ListRowTitle,
  ListRowTop,
  RadioGroup,
  RadioGroupItem,
  ScrollArea,
  Skeleton,
  Switch,
  Text,
  TextLink,
} from "@botiverse/raft-ui";
import type { BadgeProps } from "@botiverse/raft-ui";
import { SaveStatus, SaveStatusError } from "@botiverse/raft-ui/wip";
import { ListRowSkeleton } from "@botiverse/raft-ui/wip";
import {
  createOrgWebhook,
  deleteOrgWebhook,
  listOrgWebhooks,
  listWebhookDeliveries,
  updateOrgWebhook,
  WEBHOOK_EVENT_TYPES,
  type Webhook,
  type WebhookDelivery,
  type WebhookEventType,
} from "../../lib/api";
import { errorMessage } from "../../lib/errorMessage";
import { useLocale, useText } from "../../lib/locale";
import { useToast } from "../../components/Toast";
import { ConfirmActionDialog } from "../../components/ConfirmActionDialog";
import { DetailColumn, DetailSection } from "../../components/ListPage";
import { timeAgo } from "../Operations";
import { OrgPage, dateTime, type OrgFrame, type T } from "./OrgPage";

function eventsOf(w: Webhook): WebhookEventType[] {
  try {
    const parsed: unknown = JSON.parse(w.events_json);
    return Array.isArray(parsed) ? (parsed as WebhookEventType[]) : [];
  } catch {
    return [];
  }
}

function eventsSummary(events: string[], t: T) {
  if (events.length === 0) return t("All events", "全部事件");
  if (events.length <= 2) return events.join(", ");
  return t(`${events.slice(0, 2).join(", ")} and ${events.length - 2} more`, `${events.slice(0, 2).join("、")} 等 ${events.length} 个事件`);
}

const endpoint = (url: string) => url.replace(/^https?:\/\//, "");

/** 32 random bytes as hex: a secret strong enough for HMAC SHA-256. */
function generateSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const DELIVERY: Record<string, { en: string; zh: string; variant: NonNullable<BadgeProps["variant"]> }> = {
  pending: { en: "Pending", zh: "待投递", variant: "information" },
  retrying: { en: "Retrying", zh: "重试中", variant: "information" },
  succeeded: { en: "Delivered", zh: "成功", variant: "success" },
  failed: { en: "Failed", zh: "失败", variant: "danger" },
};

export function OrgWebhooks({ frame, canManage }: { frame: OrgFrame; canManage: boolean }) {
  const t = useText();
  const { orgId } = frame;
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const webhooks = useQuery({
    queryKey: ["org-webhooks", orgId],
    queryFn: () => listOrgWebhooks(orgId),
    enabled: canManage,
  });
  const rows = webhooks.data?.webhooks ?? [];
  const open = rows.find((w) => w.id === openId) ?? null;

  if (!canManage) {
    return (
      <OrgPage frame={frame}>
        <EmptyState className="py-16">
          <EmptyStateContent>
            <EmptyStateIcon><WebhookIcon aria-hidden="true" /></EmptyStateIcon>
            <EmptyStateTitle>{t("Owners and admins only", "仅限所有者和管理员")}</EmptyStateTitle>
            <EmptyStateDescription>{t("Webhooks hold secrets, so only owners and admins of the organization see and change them.", "Webhook 含有密钥，只有组织的所有者和管理员可以查看和修改。")}</EmptyStateDescription>
          </EmptyStateContent>
        </EmptyState>
      </OrgPage>
    );
  }

  return (
    <OrgPage
      frame={frame}
      count={webhooks.data ? rows.length : undefined}
      busy={webhooks.isLoading}
      toolbar={
        <>
          <Text.Sans size="small" variant="muted" className="min-w-0 flex-1 max-sm:hidden">
            {t("Release, build, store and feedback events, sent as signed HTTP POSTs.", "发布、构建、商店和反馈事件，以签名的 HTTP POST 发送。")}
          </Text.Sans>
          <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            {t("Add webhook", "添加 Webhook")}
          </Button>
        </>
      }
      detail={open && <WebhookColumn key={open.id} orgId={orgId} webhook={open} onClose={() => setOpenId(null)} />}
    >
      <div className="flex flex-col gap-0.5">
        {webhooks.isLoading && [0, 1].map((n) => <ListRowSkeleton key={n} cell leading />)}
        {webhooks.error && (
          <div className="px-(--column-margin)">
            <Banner status="warning">
              <AlertTriangle aria-hidden="true" />
              <BannerTitle>{t("Could not load the webhooks", "无法加载 Webhook")}</BannerTitle>
              <BannerDescription>{errorMessage(webhooks.error)}</BannerDescription>
              <BannerAction>
                <Button variant="outline" onClick={() => void webhooks.refetch()}>{t("Retry", "重试")}</Button>
              </BannerAction>
            </Banner>
          </div>
        )}
        {webhooks.data && rows.length === 0 && (
          <EmptyState className="py-16">
            <EmptyStateContent>
              <EmptyStateIcon><WebhookIcon aria-hidden="true" /></EmptyStateIcon>
              <EmptyStateTitle>{t("No webhooks yet", "还没有 Webhook")}</EmptyStateTitle>
              <EmptyStateDescription>
                {t("A webhook sends this organization's events to your own endpoint as they happen.", "Webhook 会把此组织的事件实时发送到你的接收地址。")}
              </EmptyStateDescription>
            </EmptyStateContent>
            <EmptyStateActions>
              <Button variant="outline" onClick={() => setCreating(true)}>{t("Add webhook", "添加 Webhook")}</Button>
            </EmptyStateActions>
          </EmptyState>
        )}
        {rows.map((w) => (
          <WebhookRow key={w.id} webhook={w} selected={openId === w.id} onOpen={() => setOpenId(w.id)} />
        ))}
      </div>

      {webhooks.data && rows.length > 0 && <DeliveryNotes />}

      {creating && (
        <CreateWebhookDialog
          orgId={orgId}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setOpenId(id);
          }}
        />
      )}
    </OrgPage>
  );
}

/** How deliveries are retried and signed, under the list. */
function DeliveryNotes() {
  const t = useText();
  return (
    <section aria-labelledby="webhook-notes" className="flex flex-col gap-1.5 px-(--column-margin) text-footnote text-foreground-muted">
      <h2 id="webhook-notes" className="font-bold text-foreground-hint">{t("How deliveries work", "投递规则")}</h2>
      <p>
        {t("Each delivery is signed with the webhook's secret: verify ", "每次投递都用 Webhook 的密钥签名：请校验 ")}
        <code className="font-mono">X-Hands-Signature: sha256=&lt;hmac&gt;</code>
        {t(" (the legacy ", "（仍会同时发送旧版 ")}
        <code className="font-mono">X-Quiver-Signature</code>
        {t(" is still sent too).", "）。")}
      </p>
      <p>
        {t("A failed delivery is retried after 5 minutes, 30 minutes and 2 hours, then marked ", "投递失败后会在 5 分钟、30 分钟和 2 小时后重试，之后标记为 ")}
        <code className="font-mono">failed</code>
        {t(".", "。")}
      </p>
    </section>
  );
}

function WebhookRow({ webhook: w, selected, onOpen }: { webhook: Webhook; selected: boolean; onOpen: () => void }) {
  const t = useText();
  const events = eventsOf(w);
  return (
    <ListRow cell selected={selected} aria-current={selected || undefined} onClick={onOpen}>
      <ListRowIcon><WebhookIcon /></ListRowIcon>
      <ListRowBody>
        <ListRowTop>
          <ListRowTitle className="min-w-0 flex-1 font-mono text-sm">{endpoint(w.url)}</ListRowTitle>
          {w.enabled !== 1 && <Badge appearance="soft" variant="muted" className="shrink-0">{t("Paused", "已暂停")}</Badge>}
        </ListRowTop>
        <ListRowSubtitle>{eventsSummary(events, t)}</ListRowSubtitle>
      </ListRowBody>
    </ListRow>
  );
}

function WebhookColumn({ orgId, webhook: w, onClose }: { orgId: string; webhook: Webhook; onClose: () => void }) {
  const t = useText();
  const { locale } = useLocale();
  const qc = useQueryClient();
  const toast = useToast();
  const id = useId();
  const [editing, setEditing] = useState<"url" | "events" | null>(null);
  const [archiving, setArchiving] = useState(false);
  const events = eventsOf(w);
  const refresh = () => qc.invalidateQueries({ queryKey: ["org-webhooks", orgId] });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateOrgWebhook(orgId, w.id, { enabled }),
    onSuccess: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: () => deleteOrgWebhook(orgId, w.id),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Webhook archived", "Webhook 已归档") });
      onClose();
      void refresh();
    },
    onError: (e) => toast.show({ kind: "error", title: t("Archive failed", "归档失败"), description: errorMessage(e) }),
  });
  const deliveries = useQuery({
    queryKey: ["webhook-deliveries", orgId, w.id],
    queryFn: () => listWebhookDeliveries(orgId, w.id),
  });
  const enabled = toggle.isPending ? Boolean(toggle.variables) : w.enabled === 1;

  return (
    <DetailColumn
      label={endpoint(w.url)}
      title={<span className="font-mono">{endpoint(w.url)}</span>}
      meta={enabled ? t("Sending", "发送中") : t("Paused", "已暂停")}
      onClose={onClose}
    >
      <ListRowGroup>
        <ListRow variant="plain" interactive={false}>
          <ListRowBody>
            <ListRowTitle id={`${id}-on`}>{t("Send deliveries", "发送投递")}</ListRowTitle>
            <ListRowDescription id={`${id}-on-d`} wrap>
              {t("Off pauses the webhook: events that happen meanwhile are not sent.", "关闭后暂停此 Webhook：期间发生的事件不会发送。")}
            </ListRowDescription>
            <SaveStatus>
              {toggle.error && <SaveStatusError>{t(`Not saved: ${errorMessage(toggle.error)}`, `未保存：${errorMessage(toggle.error)}`)}</SaveStatusError>}
            </SaveStatus>
          </ListRowBody>
          <Switch
            checked={enabled}
            disabled={toggle.isPending}
            onCheckedChange={(on) => toggle.mutate(on)}
            aria-labelledby={`${id}-on`}
            aria-describedby={`${id}-on-d`}
          />
        </ListRow>
      </ListRowGroup>

      <DetailSection title={t("Endpoint", "接收地址")}>
        <ListRowGroup>
          <ListRow variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowTitle>URL</ListRowTitle>
              <ListRowDescription wrap className="font-mono [overflow-wrap:anywhere]">{w.url}</ListRowDescription>
            </ListRowBody>
            <Button variant="outline" onClick={() => setEditing("url")}>{t("Edit", "编辑")}</Button>
          </ListRow>
          <ListRow variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowTitle>{t("Events", "事件")}</ListRowTitle>
              {events.length === 0 ? (
                <ListRowDescription wrap>{t("All events, including ones added later", "全部事件，包括以后新增的")}</ListRowDescription>
              ) : (
                <span className="mt-1 flex flex-wrap gap-1">
                  {events.map((e) => <Badge key={e} appearance="outline" className="font-mono">{e}</Badge>)}
                </span>
              )}
            </ListRowBody>
            <Button variant="outline" onClick={() => setEditing("events")}>{t("Edit", "编辑")}</Button>
          </ListRow>
          <ListRow variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowTitle>{t("Secret", "密钥")}</ListRowTitle>
              <ListRowDescription wrap>
                {w.secret_set
                  ? t("Set when the webhook was added. Hands signs with it and never shows it. To change it, add a new webhook and archive this one.", "添加 Webhook 时设置。Hands 用它签名，不会再显示。如需更换，请新建 Webhook 并归档此 Webhook。")
                  : t("Not set", "未设置")}
              </ListRowDescription>
            </ListRowBody>
          </ListRow>
        </ListRowGroup>
        <Text.Sans size="small" variant="muted">{t(`Added ${dateTime(w.created_at, locale)}`, `添加于 ${dateTime(w.created_at, locale)}`)}</Text.Sans>
      </DetailSection>

      <DetailSection title={t("Recent deliveries", "最近投递")}>
        {deliveries.isLoading && <Skeleton className="h-16 w-full" />}
        {deliveries.error && <Text.Sans size="small" className="text-danger-strong">{errorMessage(deliveries.error)}</Text.Sans>}
        {deliveries.data && deliveries.data.deliveries.length === 0 && (
          <Text.Sans size="small" variant="muted">{t("No deliveries yet. The next matching event sends one.", "还没有投递。下一个匹配的事件会触发投递。")}</Text.Sans>
        )}
        {deliveries.data && deliveries.data.deliveries.length > 0 && (
          <ListRowGroup>
            {deliveries.data.deliveries.map((d) => <DeliveryRow key={d.id} delivery={d} />)}
          </ListRowGroup>
        )}
      </DetailSection>

      <DetailSection title={t("Danger zone", "危险操作")}>
        <ListRowGroup>
          <ListRow variant="plain" tone="danger" onClick={() => setArchiving(true)} disabled={remove.isPending}>
            <ListRowIcon><Archive /></ListRowIcon>
            <ListRowBody>
              <ListRowTitle>{t("Archive webhook", "归档 Webhook")}</ListRowTitle>
              <ListRowDescription wrap>{t("Deliveries stop for good. This can't be undone.", "投递将永久停止。此操作无法撤回。")}</ListRowDescription>
            </ListRowBody>
          </ListRow>
        </ListRowGroup>
      </DetailSection>

      {editing === "url" && <EditUrlDialog orgId={orgId} webhook={w} onClose={() => setEditing(null)} />}
      {editing === "events" && <EditEventsDialog orgId={orgId} webhook={w} onClose={() => setEditing(null)} />}
      <ConfirmActionDialog
        open={archiving}
        title={t("Archive this webhook?", "归档此 Webhook？")}
        objectLabel={endpoint(w.url)}
        body={t(
          "Hands stops sending it events, and pending retries are dropped. This can't be undone; add the endpoint again to resume.",
          "Hands 将不再向它发送事件，待重试的投递也会丢弃。此操作无法撤回；如需恢复，请重新添加此地址。",
        )}
        confirmLabel={t("Archive webhook", "归档 Webhook")}
        confirmKind="danger"
        pending={remove.isPending}
        onConfirm={() => remove.mutate(undefined, { onSettled: () => setArchiving(false) })}
        onCancel={() => setArchiving(false)}
      />
    </DetailColumn>
  );
}

function DeliveryRow({ delivery: d }: { delivery: WebhookDelivery }) {
  const t = useText();
  const { locale } = useLocale();
  const s = DELIVERY[d.status] ?? { en: d.status, zh: d.status, variant: "muted" as const };
  const facts = [
    t(`attempt ${d.attempts}/${d.max_attempts}`, `第 ${d.attempts}/${d.max_attempts} 次`),
    d.last_response_status != null ? `HTTP ${d.last_response_status}` : null,
    !d.last_error && d.next_attempt_at && d.status !== "succeeded"
      ? t(`next ${new Date(d.next_attempt_at).toLocaleTimeString(locale)}`, `下次 ${new Date(d.next_attempt_at).toLocaleTimeString(locale)}`)
      : null,
  ].filter(Boolean);
  return (
    <ListRow variant="plain" interactive={false}>
      <ListRowBody>
        <ListRowTop>
          <span className="flex min-w-0 flex-1 items-center">
            <Badge appearance="outline" className="min-w-0 truncate font-mono">{d.event_type}</Badge>
          </span>
          <ListRowMeta className="shrink-0" title={new Date(d.created_at).toLocaleString(locale)}>{timeAgo(d.created_at, locale)}</ListRowMeta>
        </ListRowTop>
        <ListRowBottom>
          <ListRowDescription>{facts.join(" · ")}</ListRowDescription>
          <Badge appearance="soft" variant={s.variant} className="shrink-0">{t(s.en, s.zh)}</Badge>
        </ListRowBottom>
        {d.last_error && (
          <ListRowDescription wrap className="font-mono text-danger-strong [overflow-wrap:anywhere]">{d.last_error}</ListRowDescription>
        )}
      </ListRowBody>
    </ListRow>
  );
}

// --- Events -------------------------------------------------------------------

const AREA_NAMES: Record<string, [string, string]> = {
  release: ["Releases", "版本"],
  build: ["Builds", "构建"],
  testflight: ["TestFlight", "TestFlight"],
  app_store: ["App Store", "App Store"],
  google_play: ["Google Play", "Google Play"],
  appgallery: ["AppGallery", "AppGallery"],
  feedback: ["Feedback", "反馈"],
  crash: ["Crashes", "崩溃"],
  error: ["Errors", "错误"],
};

/** All events, or only the ticked ones, grouped by their area. */
function EventPicker({ value, onChange }: { value: WebhookEventType[] | "all"; onChange: (next: WebhookEventType[] | "all") => void }) {
  const t = useText();
  const id = useId();
  const groups = useMemo(() => {
    const map = new Map<string, WebhookEventType[]>();
    for (const ev of WEBHOOK_EVENT_TYPES) {
      const area = ev.split(":")[0] ?? ev;
      map.set(area, [...(map.get(area) ?? []), ev]);
    }
    return [...map].sort((a, b) => Object.keys(AREA_NAMES).indexOf(a[0]) - Object.keys(AREA_NAMES).indexOf(b[0]));
  }, []);
  const picked = value === "all" ? [] : value;
  const toggle = (ev: WebhookEventType) =>
    onChange(picked.includes(ev) ? picked.filter((e) => e !== ev) : [...picked, ev]);
  return (
    <div className="flex flex-col gap-3">
      <RadioGroup
        aria-labelledby={`${id}-label`}
        value={value === "all" ? "all" : "some"}
        onValueChange={(v) => onChange(v === "all" ? "all" : picked)}
        className="grid gap-2"
      >
        <span id={`${id}-label`} className="sr-only">{t("Events", "事件")}</span>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <RadioGroupItem value="all" aria-label={t("All events, including ones added later", "全部事件，包括以后新增的")} />
          <span aria-hidden="true">{t("All events, including ones added later", "全部事件，包括以后新增的")}</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <RadioGroupItem value="some" aria-label={t("Only the events I pick", "只接收选中的事件")} />
          <span aria-hidden="true">{t("Only the events I pick", "只接收选中的事件")}</span>
        </label>
      </RadioGroup>
      {value !== "all" && (
        <ScrollArea className="max-h-72 rounded-lg border border-line-hairline" contentClassName="flex flex-col gap-3 p-3">
          {groups.map(([area, evs]) => (
            <fieldset key={area} className="flex flex-col gap-1.5">
              <legend className="mb-1 text-footnote font-bold text-foreground-hint">{t(...(AREA_NAMES[area] ?? [area, area]))}</legend>
              {evs.map((ev) => (
                <label key={ev} className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={picked.includes(ev)} onCheckedChange={() => toggle(ev)} aria-label={ev} />
                  <span className="font-mono text-footnote">{ev}</span>
                </label>
              ))}
            </fieldset>
          ))}
        </ScrollArea>
      )}
    </div>
  );
}

const asEvents = (v: WebhookEventType[] | "all") => (v === "all" ? [] : v);

function CreateWebhookDialog({ orgId, onClose, onCreated }: { orgId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useText();
  const toast = useToast();
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState<WebhookEventType[] | "all">("all");
  const create = useMutation({
    mutationFn: () => createOrgWebhook(orgId, { url: url.trim(), secret: secret.trim(), events: asEvents(events) }),
    onSuccess: (created) => {
      toast.show({ kind: "success", title: t("Webhook created", "Webhook 已创建") });
      void qc.invalidateQueries({ queryKey: ["org-webhooks", orgId] });
      onCreated(created.id);
    },
    onError: (e) => toast.show({ kind: "error", title: t("Create failed", "创建失败"), description: errorMessage(e) }),
  });
  const noEvents = events !== "all" && events.length === 0;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Add webhook", "添加 Webhook")}</DialogTitle>
          <DialogClose />
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <DialogDescription>{t("Hands sends each event as a signed POST to this URL.", "Hands 会把每个事件以签名的 POST 请求发送到此地址。")}</DialogDescription>
          <form
            id="create-webhook-form"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
            className="flex flex-col gap-4"
          >
            <Field>
              <FieldLabel>URL</FieldLabel>
              <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/hands" required autoFocus />
            </Field>
            <Field>
              <FieldLabel>{t("Secret", "密钥")}</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  className="font-mono"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={t("At least 16 random bytes", "至少 16 个随机字节")}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
                <InputGroupAddon align="inline-end">
                  <TextLink className="text-footnote" onClick={() => setSecret(generateSecret())}>{t("Generate", "生成")}</TextLink>
                </InputGroupAddon>
              </InputGroup>
              <FieldDescription>
                {t("Your endpoint checks ", "接收方用它校验 ")}
                <code className="font-mono">X-Hands-Signature</code>
                {t(" with it. Copy it now: Hands won't show it again.", "。请现在复制：之后不会再显示。")}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel nativeLabel={false} render={<div />}>{t("Events", "事件")}</FieldLabel>
              <EventPicker value={events} onChange={setEvents} />
            </Field>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t("Cancel", "取消")}</Button>
          <Button
            type="submit"
            form="create-webhook-form"
            variant="primary"
            loading={create.isPending}
            disabled={create.isPending || !url.trim() || secret.trim().length < 8 || noEvents}
          >
            {t("Add webhook", "添加 Webhook")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditUrlDialog({ orgId, webhook: w, onClose }: { orgId: string; webhook: Webhook; onClose: () => void }) {
  const t = useText();
  const toast = useToast();
  const qc = useQueryClient();
  const [url, setUrl] = useState(w.url);
  const save = useMutation({
    mutationFn: () => updateOrgWebhook(orgId, w.id, { url: url.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["org-webhooks", orgId] });
      onClose();
    },
    onError: (e) => toast.show({ kind: "error", title: t("Save failed", "保存失败"), description: errorMessage(e) }),
  });
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Edit URL", "编辑地址")}</DialogTitle>
          <DialogClose />
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <DialogDescription>{t("The secret stays the same.", "密钥保持不变。")}</DialogDescription>
          <form id="edit-webhook-url" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <Field>
              <FieldLabel>URL</FieldLabel>
              <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required autoFocus />
            </Field>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t("Cancel", "取消")}</Button>
          <Button type="submit" form="edit-webhook-url" variant="primary" loading={save.isPending} disabled={save.isPending || !url.trim() || url.trim() === w.url}>
            {t("Save", "保存")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditEventsDialog({ orgId, webhook: w, onClose }: { orgId: string; webhook: Webhook; onClose: () => void }) {
  const t = useText();
  const toast = useToast();
  const qc = useQueryClient();
  const initial = eventsOf(w);
  const [events, setEvents] = useState<WebhookEventType[] | "all">(initial.length ? initial : "all");
  const save = useMutation({
    mutationFn: () => updateOrgWebhook(orgId, w.id, { events: asEvents(events) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["org-webhooks", orgId] });
      onClose();
    },
    onError: (e) => toast.show({ kind: "error", title: t("Save failed", "保存失败"), description: errorMessage(e) }),
  });
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Edit events", "编辑事件")}</DialogTitle>
          <DialogClose />
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <DialogDescription className="font-mono [overflow-wrap:anywhere]">{endpoint(w.url)}</DialogDescription>
          <EventPicker value={events} onChange={setEvents} />
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t("Cancel", "取消")}</Button>
          <Button variant="primary" loading={save.isPending} disabled={save.isPending || (events !== "all" && events.length === 0)} onClick={() => save.mutate()}>
            {t("Save", "保存")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
