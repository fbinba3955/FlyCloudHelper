import { ExternalLink } from "lucide-react";

interface ProviderConnectionGuideContent {
  title: string;
  steps: string[];
  toolUrl?: string;
  toolLabel?: string;
  note?: string;
}

type ProviderConnectionGuideMode = "create" | "replace";

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
      "授权完成后复制 Access Token 和 Refresh Token，返回本页面粘贴到对应输入框。",
      "点击“验证连接并创建服务”，云助手会自动获取该账号的 Drive ID。",
    ],
    toolUrl: "https://api.oplist.org/",
    toolLabel: "打开 OpenList Token 工具",
    note: "Drive ID 和开放接口地址由云助手自动处理。Access Token 会过期；失效后需要在服务连接页面重新获取并替换。请不要把 Token 提交给不可信的网站。",
  },
  baidupan: {
    title: "百度网盘授权信息获取说明",
    steps: [
      "打开 OpenList Token 工具，网盘类型选择“百度网盘验证登录”。",
      "勾选“使用 OpenList 提供的参数”，点击获取 Token，并按页面提示完成百度网盘授权。",
      "授权完成后复制 Access Token 和 Refresh Token，返回本页面粘贴到对应输入框。",
      "点击“验证连接并创建服务”，验证成功后再进入服务详情选择扫描目录。",
    ],
    toolUrl: "https://api.oplist.org/",
    toolLabel: "打开 OpenList Token 工具",
    note: "百度网盘目录使用路径和文件 fs_id 定位，开放接口地址由云助手自动使用官方地址。Access Token 会过期；失效后需要在服务连接页面重新获取并替换。",
  },
};

// 关键变量：替换连接不会创建新服务，说明文字必须明确旧 Secret 不回显且会校验原扫描目录。
const providerReplacementGuides: Record<string, ProviderConnectionGuideContent> = {
  webdav: {
    title: "WebDAV 连接替换说明",
    steps: [
      "重新填写可以直接访问的 WebDAV 服务地址，地址应包含服务实际使用的路径前缀。",
      "按网盘服务要求重新填写用户名和密码；如果服务使用 Bearer Token，则填写 Token。",
      "点击“验证并保存连接”，验证成功后会替换当前连接，原服务和媒体库保持不变。",
    ],
    note: "旧用户名、密码和 Bearer Token 不会回显。请提交一套完整新连接；保存时还会验证原来配置的扫描目录是否可以访问。",
  },
  guangya: {
    title: "光鸭云盘重新授权说明",
    steps: [
      "三方光鸭可以选择扫码登录或验证码登录，并在当前页面重新完成授权。",
      "授权成功后，页面会自动验证并替换当前连接，不需要再次点击保存按钮。",
      "官方光鸭需要先在 Flymby APP 中完成登录，再由 APP 同步到当前云助手服务。",
    ],
    note: "重新授权只替换登录连接，原服务、媒体库和扫描配置保持不变；新账号仍需能够访问原来配置的扫描目录。",
  },
  aliyundrive: {
    title: "阿里云盘重新授权说明",
    steps: [
      "打开 OpenList Token 工具，网盘类型选择“阿里云盘 OAuth2 扫码登录”。",
      "勾选“使用 OpenList 提供的参数”，点击获取 Token，并使用阿里云盘 APP 扫码授权。",
      "授权完成后复制新的 Access Token 和 Refresh Token，返回本页面填写完整登录信息。",
      "点击“验证并保存连接”，验证成功后会替换当前连接，原服务和媒体库保持不变。",
    ],
    toolUrl: "https://api.oplist.org/",
    toolLabel: "打开 OpenList Token 工具",
    note: "旧 Token 不会回显。云助手会自动获取 Drive ID，并验证新账号能否访问原来配置的扫描目录。请不要把 Token 提交给不可信的网站。",
  },
  baidupan: {
    title: "百度网盘重新授权说明",
    steps: [
      "打开 OpenList Token 工具，网盘类型选择“百度网盘验证登录”。",
      "勾选“使用 OpenList 提供的参数”，点击获取 Token，并按页面提示完成百度网盘授权。",
      "授权完成后复制新的 Access Token 和 Refresh Token，返回本页面填写完整登录信息。",
      "点击“验证并保存连接”，验证成功后会替换当前连接，原服务和媒体库保持不变。",
    ],
    toolUrl: "https://api.oplist.org/",
    toolLabel: "打开 OpenList Token 工具",
    note: "旧 Token 不会回显。百度网盘目录仍使用原路径和文件 fs_id，保存前会验证新账号能否访问原来配置的扫描目录。",
  },
};

interface ProviderConnectionGuideProps {
  providerType: string;
  mode?: ProviderConnectionGuideMode;
}

/** 根据当前网盘类型和操作场景展示与连接字段一致的手动操作指南。 */
export function ProviderConnectionGuide({ providerType, mode = "create" }: ProviderConnectionGuideProps) {
  const guide = mode === "replace"
    ? providerReplacementGuides[providerType]
    : providerConnectionGuides[providerType];
  if (!guide) return null;

  /** 记录用户从说明卡片打开外部授权工具，便于定位入口是否正常触发。 */
  function logAuthorizationToolOpen(): void {
    console.info("codex-flycloud-connection-guide", {
      事件: "打开Provider授权工具",
      网盘类型: providerType,
      操作场景: mode === "replace" ? "替换连接" : "创建服务",
    });
  }

  return (
    <section className="rounded-xl border border-border bg-secondary/25 p-4 lg:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{guide.title}</h2>
        {guide.toolUrl && (
          <a
            href={guide.toolUrl}
            target="_blank"
            rel="noreferrer"
            onClick={logAuthorizationToolOpen}
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
