import { currentLocale } from "./locale";

const messages = {
  en: {
    title: "Access",
    description: "Review inherited owner-server access, external Raft server visibility, and direct per-app member grants.",
  },
  "zh-CN": {
    title: "访问权限",
    description: "管理所属服务器继承的权限、外部 Raft 服务器可见性和应用的直接成员权限。",
  },
};
export function appAccessMessage(key: keyof typeof messages.en): string {
  return messages[currentLocale()][key];
}
