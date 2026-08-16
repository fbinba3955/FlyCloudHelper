import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ApiError } from "./errors.js";

interface EncryptedEnvelope {
  version: number;
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
}

/** 使用部署主密钥加密和解密服务凭据，不在业务表保存明文。 */
export class CredentialVault {
  private readonly encryptionKey: Buffer | null;

  public constructor(masterKey: string | null) {
    this.encryptionKey = masterKey
      ? createHash("sha256").update(masterKey, "utf8").digest()
      : null;
  }

  /** 返回凭据主密钥是否可用于服务配置。 */
  public isConfigured(): boolean {
    return this.encryptionKey !== null;
  }

  /** 加密任意 JSON 凭据对象并返回版本化信封。 */
  public encrypt(payload: Record<string, unknown>): string {
    const key = this.requireKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    const envelope: EncryptedEnvelope = {
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    return JSON.stringify(envelope);
  }

  /** 解密服务凭据，仅供 Provider 和 Worker 内部使用。 */
  public decrypt(encryptedPayload: string): Record<string, unknown> {
    const key = this.requireKey();
    let envelope: EncryptedEnvelope;
    try {
      envelope = JSON.parse(encryptedPayload) as EncryptedEnvelope;
      if (envelope.algorithm !== "aes-256-gcm" || envelope.version !== 1) {
        throw new Error("unsupported envelope");
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(envelope.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
      const cleartext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      const payload = JSON.parse(cleartext) as unknown;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("invalid payload");
      }
      return payload as Record<string, unknown>;
    } catch {
      throw new ApiError(503, "credential_decryption_failed", "服务凭据无法解密");
    }
  }

  /** 强制取得主密钥，缺失时拒绝服务连接写入与扫描。 */
  private requireKey(): Buffer {
    if (!this.encryptionKey) {
      throw new ApiError(
        503,
        "credential_key_missing",
        "服务凭据主密钥尚未配置",
      );
    }
    return this.encryptionKey;
  }
}
