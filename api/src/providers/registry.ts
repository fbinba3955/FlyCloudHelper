import type { ApiConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { AliyunDriveProvider } from "./aliyundrive.js";
import { BaiduPanProvider } from "./baidupan.js";
import { GuangyaProvider } from "./guangya.js";
import type { ProviderAdapter, ProviderDescriptor } from "./types.js";
import { WebDavProvider } from "./webdav.js";

/** 管理内置 Provider 能力，扫描核心只依赖统一适配器契约。 */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  public constructor(
    config: ApiConfig,
    logConnectionFailure?: (fields: Record<string, string | number | boolean | null>) => void,
  ) {
    const networkOptions = {
      allowInsecureHttp: config.allowInsecureProviderHttp,
      logConnectionFailure,
    };
    [
      new WebDavProvider(networkOptions),
      new AliyunDriveProvider(networkOptions),
      new BaiduPanProvider(networkOptions),
      new GuangyaProvider(networkOptions),
    ].forEach((adapter) => this.adapters.set(adapter.descriptor.type, adapter));
  }

  /** 返回指定 Provider，未知类型使用稳定错误码。 */
  public get(providerType: string): ProviderAdapter {
    const adapter = this.adapters.get(providerType);
    if (!adapter) {
      throw new ApiError(422, "provider_not_supported", `当前实例不支持 Provider：${providerType}`);
    }
    return adapter;
  }

  /** 返回当前实例全部 Provider 能力描述。 */
  public listDescriptors(): ProviderDescriptor[] {
    return [...this.adapters.values()].map((adapter) => adapter.descriptor);
  }
}
