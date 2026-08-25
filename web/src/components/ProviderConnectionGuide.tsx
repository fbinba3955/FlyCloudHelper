import { ExternalLink } from "lucide-react";

interface ProviderConnectionGuideContent {
  title: string;
  steps: string[];
  toolUrl?: string;
  toolLabel?: string;
  note?: string;
}

// 关键变量：操作指南与当前 Provider 实际要求的连接字段保持一致，避免引导用户复制后台尚不支持的凭据。
const providerConnectionGuides: Record<string, ProviderConnectionGuideContent> = {
  webdav: {
    title: "WebDAV 添加说明",
    steps: [
      "填写可以直接访问的 WebDAV 服务地址，地址应包含服务实际使用的路径前缀。",
      "按网盘服务要求填写用户名和密码；如果服务使用 Bearer Token，则填写 Token。",
      "点击“验证连接并创建服务”，连接成功后再进入服务详情选择扫描目录。",
    ],
    note: "用户名、密码和 Bearer Token 按实际认证方式填写，不需要同时提供两种认证凭据。",
  },
  guangya: {
    title: "光鸭云盘添加说明",
    steps: [
      "选择扫码登录或验证码登录，并在当前页面完成授权。",
      "页面显示授权成功后，点击“验证连接并创建服务”。",
      "创建完成后进入服务详情选择扫描目录，服务不会自动开始扫描。",
    ],
  },
  aliyundrive: {
    title: "阿里云盘授权信息获取说明",
    steps: [
      "打开 OpenList Token 工具，网盘类型选择“阿里云盘 OAuth2 扫码登录”。",
      "勾选“使用 OpenList 提供的参数”，点击获取 Token，并使用阿里云盘 APP 扫码授权。",
      "授权完成后复制 Access Token，返回本页面粘贴到对应输入框。",
      "填写该账号需要扫描的 Drive ID，然后点击“验证连接并创建服务”。",
    ],
    toolUrl: "https://api.oplist.org/",
    toolLabel: "打开 OpenList Token 工具",
    note: "Access Token 会过期；失效后需要在服务连接页面重新获取并替换。请不要把 Token 提交给不可信的网站。",
  },
  baidupan: {
    title: "百度网盘授权信息获取说明",
    steps: [
      "打开 OpenList Token 工具，网盘类型选择“百度网盘验证登录”。",
      "勾选“使用 OpenList 提供的参数”，点击获取 Token，并按页面提示完成百度网盘授权。",
      "授权完成后复制 Access Token，返回本页面粘贴到对应输入框。",
      "点击“验证连接并创建服务”，验证成功后再进入服务详情选择扫描目录。",
    ],
    toolUrl: "https://api.oplist.org/",
    toolLabel: "打开 OpenList Token 工具",
    note: "Access Token 会过期；失效后需要在服务连接页面重新获取并替换。请不要把 Token 提交给不可信的网站。",
  },
};

/** 根据当前选择的网盘类型展示与连接字段一致的手动操作指南。 */
export function ProviderConnectionGuide({ providerType }: { providerType: string }) {
  const guide = providerConnectionGuides[providerType];
  if (!guide) return null;

  return (
    <section className="rounded-xl border border-border bg-secondary/25 p-4 lg:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{guide.title}</h2>
        {guide.toolUrl && (
          <a
            href={guide.toolUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/45 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
          >
            {guide.toolLabel}
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        )}
      </div>
      <ol className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
        {guide.steps.map((step, index) => (
          <li key={step} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-1.5">
            <span className="font-medium text-foreground">{index + 1}.</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      {guide.note && (
        <p className="mt-3 border-t border-border pt-3 text-xs leading-5 text-muted-foreground">
          {guide.note}
        </p>
      )}
    </section>
  );
}
