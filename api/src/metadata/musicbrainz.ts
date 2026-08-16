import type { ApiConfig } from "../config.js";

export interface MusicTrackMetadata {
  recordingId: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  year: number | null;
  durationMs: number | null;
  coverUrl: string | null;
  score: number;
}

/** 复用 FlymbyServer 的字段口径和每秒一次 MusicBrainz 调度规则。 */
export class MusicBrainzClient {
  private lastRequestAt = 0;
  private requestChain: Promise<void> = Promise.resolve();
  private readonly userAgent: string;

  public constructor(config: ApiConfig) {
    this.userAgent = config.musicbrainzUserAgent;
  }

  /** 按曲名和艺术家查找首个 MusicBrainz Recording 候选。 */
  public async searchTrack(title: string, artist: string, signal?: AbortSignal): Promise<MusicTrackMetadata | null> {
    await this.waitForRequestSlot();
    const url = new URL("https://musicbrainz.org/ws/2/recording");
    url.searchParams.set("query", `${title} ${artist}`.trim());
    url.searchParams.set("dismax", "true");
    url.searchParams.set("fmt", "json");
    url.searchParams.set("limit", "1");
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": this.userAgent, Accept: "application/json" },
        signal,
      });
      if (!response.ok) {
        return null;
      }
      const payload = await response.json() as { recordings?: Array<Record<string, unknown>> };
      const recording = payload.recordings?.[0];
      if (!recording || typeof recording.id !== "string") {
        return null;
      }
      const releases = Array.isArray(recording.releases)
        ? recording.releases.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        : [];
      const release = releases[0] ?? {};
      const releaseGroup = release["release-group"] && typeof release["release-group"] === "object"
        ? release["release-group"] as Record<string, unknown>
        : {};
      const releaseGroupId = typeof releaseGroup.id === "string" ? releaseGroup.id : "";
      const releaseId = typeof release.id === "string" ? release.id : "";
      const releaseDate = String(recording["first-release-date"] ?? release.date ?? "");
      const recordingArtist = this.readArtistCredit(recording["artist-credit"]);
      return {
        recordingId: recording.id,
        title: String(recording.title ?? title),
        artist: recordingArtist || artist,
        album: String(release.title ?? ""),
        albumArtist: this.readArtistCredit(release["artist-credit"]) || recordingArtist || artist,
        year: /^\d{4}/u.test(releaseDate) ? Number(releaseDate.slice(0, 4)) : null,
        durationMs: typeof recording.length === "number" ? recording.length : null,
        coverUrl: releaseGroupId
          ? `https://coverartarchive.org/release-group/${releaseGroupId}/front-500`
          : releaseId
            ? `https://coverartarchive.org/release/${releaseId}/front-500`
            : null,
        score: Number(recording.score ?? 0),
      };
    } catch {
      return null;
    }
  }

  /** 串行化 MusicBrainz 请求并保持至少 1.05 秒间隔。 */
  private async waitForRequestSlot(): Promise<void> {
    const current = this.requestChain.then(async () => {
      const remaining = 1050 - (Date.now() - this.lastRequestAt);
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      this.lastRequestAt = Date.now();
    });
    this.requestChain = current.catch(() => undefined);
    await current;
  }

  /** 转换 MusicBrainz artist-credit 数组为展示文本。 */
  private readArtistCredit(value: unknown): string {
    if (!Array.isArray(value)) {
      return "";
    }
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      const artist = record.artist && typeof record.artist === "object"
        ? record.artist as Record<string, unknown>
        : {};
      return `${String(record.name ?? artist.name ?? "")}${String(record.joinphrase ?? "")}`;
    }).join("").trim();
  }
}
