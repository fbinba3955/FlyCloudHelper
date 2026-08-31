import type { ApiConfig } from "../config.js";

export interface MusicTrackMetadata {
  recordingId: string;
  releaseTrackId: string;
  releaseId: string;
  releaseGroupId: string;
  title: string;
  artist: string;
  artistIds: string[];
  album: string;
  albumArtist: string;
  albumArtistIds: string[];
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

  /** 按内嵌Recording ID或曲名、艺术家、专辑和时长查找MusicBrainz曲目。 */
  public async searchTrack(
    title: string,
    artist: string,
    signal?: AbortSignal,
    context: { album?: string; durationMs?: number; recordingId?: string } = {},
  ): Promise<MusicTrackMetadata | null> {
    await this.waitForRequestSlot();
    const recordingId = String(context.recordingId ?? "").trim();
    const url = new URL(recordingId
      ? `https://musicbrainz.org/ws/2/recording/${encodeURIComponent(recordingId)}`
      : "https://musicbrainz.org/ws/2/recording");
    if (recordingId) {
      url.searchParams.set("inc", "artists+releases+release-groups+media");
    } else {
      const queryParts = [
        title ? `recording:\"${this.escapeQuery(title)}\"` : "",
        artist ? `artist:\"${this.escapeQuery(artist)}\"` : "",
        context.album ? `release:\"${this.escapeQuery(context.album)}\"` : "",
      ].filter(Boolean);
      url.searchParams.set("query", queryParts.join(" AND ") || `${title} ${artist}`.trim());
      url.searchParams.set("dismax", "true");
      url.searchParams.set("limit", "5");
    }
    url.searchParams.set("fmt", "json");
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": this.userAgent, Accept: "application/json" },
        signal,
      });
      if (!response.ok) {
        return null;
      }
      const payload = await response.json() as Record<string, unknown> & { recordings?: Array<Record<string, unknown>> };
      const candidates = recordingId
        ? [payload]
        : Array.isArray(payload.recordings) ? payload.recordings : [];
      const recording = this.pickRecordingCandidate(candidates, title, artist, context.album ?? "", context.durationMs ?? 0);
      if (!recording || typeof recording.id !== "string") {
        return null;
      }
      const releases = Array.isArray(recording.releases)
        ? recording.releases.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        : [];
      const requestedAlbum = String(context.album ?? "").trim().toLocaleLowerCase("und");
      // 关键变量：同一录音可能属于多张发行版，优先选择与文件专辑标签一致的一张。
      const release = releases.find((candidate) => requestedAlbum
        && String(candidate.title ?? "").trim().toLocaleLowerCase("und") === requestedAlbum) ?? releases[0] ?? {};
      const releaseGroup = release["release-group"] && typeof release["release-group"] === "object"
        ? release["release-group"] as Record<string, unknown>
        : {};
      const releaseGroupId = typeof releaseGroup.id === "string" ? releaseGroup.id : "";
      const releaseId = typeof release.id === "string" ? release.id : "";
      const media = Array.isArray(release.media)
        ? release.media.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        : [];
      const tracks = media.flatMap((medium) => Array.isArray(medium.tracks)
        ? medium.tracks.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        : []);
      const releaseTrack = tracks.find((track) => {
        const trackRecording = track.recording && typeof track.recording === "object"
          ? track.recording as Record<string, unknown>
          : {};
        return String(trackRecording.id ?? "") === recording.id;
      });
      const releaseDate = String(recording["first-release-date"] ?? release.date ?? "");
      const recordingArtist = this.readArtistCredit(recording["artist-credit"]);
      return {
        recordingId: recording.id,
        releaseTrackId: typeof releaseTrack?.id === "string" ? releaseTrack.id : "",
        releaseId,
        releaseGroupId,
        title: String(recording.title ?? title),
        artist: recordingArtist || artist,
        artistIds: this.readArtistIds(recording["artist-credit"]),
        album: String(release.title ?? ""),
        albumArtist: this.readArtistCredit(release["artist-credit"]) || recordingArtist || artist,
        albumArtistIds: this.readArtistIds(release["artist-credit"]),
        year: /^\d{4}/u.test(releaseDate) ? Number(releaseDate.slice(0, 4)) : null,
        durationMs: typeof recording.length === "number" ? recording.length : null,
        coverUrl: releaseGroupId
          ? `https://coverartarchive.org/release-group/${releaseGroupId}/front-500`
          : releaseId
            ? `https://coverartarchive.org/release/${releaseId}/front-500`
            : null,
        // 关键变量：内嵌 Recording ID 直查没有搜索 score，编号命中应视为确定匹配。
        score: recordingId ? 100 : Number(recording.score ?? 0),
      };
    } catch {
      return null;
    }
  }

  /** 对搜索候选追加本地字段评分，避免只使用MusicBrainz返回顺序。 */
  private pickRecordingCandidate(
    candidates: Array<Record<string, unknown>>,
    title: string,
    artist: string,
    album: string,
    durationMs: number,
  ): Record<string, unknown> | undefined {
    const compare = (left: string, right: string): boolean => left.trim().toLocaleLowerCase("und") === right.trim().toLocaleLowerCase("und");
    return candidates
      .map((candidate, index) => {
        const releases = Array.isArray(candidate.releases)
          ? candidate.releases.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          : [];
        const candidateArtist = this.readArtistCredit(candidate["artist-credit"]);
        const candidateDuration = Number(candidate.length ?? 0);
        let score = Number(candidate.score ?? 0);
        if (title && compare(String(candidate.title ?? ""), title)) score += 30;
        if (artist && compare(candidateArtist, artist)) score += 25;
        if (album && releases.some((release) => compare(String(release.title ?? ""), album))) score += 20;
        if (durationMs > 0 && candidateDuration > 0) {
          const difference = Math.abs(durationMs - candidateDuration);
          if (difference <= 3_000) score += 10;
          else if (difference <= 10_000) score += 5;
        }
        // 将本地字段加权后的分数带回映射阶段，统一使用最终可信度判断。
        return { candidate: { ...candidate, score }, score, index };
      })
      .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.candidate;
  }

  /** 转义MusicBrainz Lucene查询中的引号和反斜线。 */
  private escapeQuery(value: string): string {
    return value.replace(/[\\"]/gu, (character) => `\\${character}`);
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

  /** 读取artist-credit中的稳定艺术家编号。 */
  private readArtistIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const artist = record.artist && typeof record.artist === "object"
        ? record.artist as Record<string, unknown>
        : {};
      return typeof artist.id === "string" && artist.id ? [artist.id] : [];
    }))];
  }
}
