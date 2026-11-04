import type { AppPermission } from "./api";

export const PERMISSION_ZH: Record<AppPermission, { label: string; description: string }> = {
  "app:read": { label: "读取应用", description: "读取应用数据、构建、版本、反馈和统计。" },
  "app:publish": { label: "发布版本", description: "创建和发布构建、版本及分发文件。" },
  "app:admin": { label: "管理应用", description: "管理应用设置、成员、凭据及执行删除等操作。" },
  "feedback:write": { label: "提交反馈", description: "为此应用提交反馈工单。" },
  "feedback:read": { label: "读取报告人反馈", description: "读取反馈工单。绑定报告人集成的令牌只能查看该集成的工单；未绑定的令牌可查看应用的工单。" },
  "feedback:comment": { label: "回复报告人反馈", description: "发送报告人可见的公开回复；绑定报告人集成的令牌还可以关闭该集成拥有的工单。范围由令牌绑定决定。" },
  "feedback:route": { label: "绑定报告人路由", description: "将不透明的路由主体绑定到报告人集成。" },
  "feedback:triage": { label: "处理反馈", description: "更改工单状态和负责人，并填写内部备注。" },
};
