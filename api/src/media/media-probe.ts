/** ffprobe 持久化的单个媒体文件规格；字段名与 Jellyfin MediaSource 常用字段保持一致。 */
export interface MediaProbeResult {
  probeVersion: number;
  container: string;
  runTimeTicks: number;
  bitRate: number;
  size: number;
  mediaStreams: Array<Record<string, unknown>>;
}

/** ffprobe JSON 中本阶段读取的格式字段。 */
interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  bit_rate?: string;
  size?: string;
}

/** ffprobe JSON 中本阶段读取的流字段。 */
interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  bit_rate?: string;
  bits_per_sample?: number;
  bits_per_raw_sample?: string;
  pix_fmt?: string;
  level?: number;
  channels?: number;
  channel_layout?: string;
  sample_rate?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_aspect_ratio?: string;
  display_aspect_ratio?: string;
  time_base?: string;
  duration?: string;
  field_order?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
  side_data_list?: Array<Record<string, unknown>>;
}

interface FfprobeDocument {
  format?: FfprobeFormat;
  streams?: FfprobeStream[];
}

/** 把未知数值限制为安全的非负整数。 */
function readNonNegativeInteger(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(parsed)) : 0;
}

/** 把 ffprobe 分数字段转换为帧率。 */
function readFrameRate(value: unknown): number | undefined {
  if (typeof value !== "string" || !value || value === "0/0") return undefined;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || !denominator) return undefined;
  const result = numerator! / denominator!;
  return result > 0 ? Math.round(result * 1000) / 1000 : undefined;
}

/** 按 ffprobe 流类型生成 Jellyfin 使用的枚举值。 */
function readJellyfinStreamType(value: unknown): "Video" | "Audio" | "Subtitle" | "Data" {
  if (value === "video") return "Video";
  if (value === "audio") return "Audio";
  if (value === "subtitle") return "Subtitle";
  return "Data";
}

/** 识别常见 HDR 和杜比视界信号，只使用媒体文件实际携带的色彩元数据。 */
function readVideoRange(stream: FfprobeStream): { range: "SDR" | "HDR"; type?: string } {
  const sideData = stream.side_data_list ?? [];
  if (sideData.some((item) => /dovi|dolby vision/iu.test(String(item.side_data_type ?? "")))) {
    return { range: "HDR", type: "DOVI" };
  }
  if (stream.color_transfer === "smpte2084") return { range: "HDR", type: "HDR10" };
  if (stream.color_transfer === "arib-std-b67") return { range: "HDR", type: "HLG" };
  return { range: "SDR" };
}

/** 生成客户端规格行使用的简短标题。 */
function buildStreamDisplayTitle(stream: FfprobeStream, type: string, videoRange: { range: string; type?: string }): string {
  const codec = String(stream.codec_name ?? "").toUpperCase();
  if (type === "Video") {
    const resolution = stream.height ? `${stream.height}p` : stream.width ? `${stream.width}w` : "";
    return [resolution, codec, videoRange.type].filter(Boolean).join(" ");
  }
  if (type === "Audio") {
    return [stream.tags?.language, codec, stream.channel_layout].filter(Boolean).join(" ");
  }
  return [stream.tags?.language, codec, stream.tags?.title].filter(Boolean).join(" ");
}

/** 把单个 ffprobe 流映射为 Jellyfin MediaStream DTO。 */
function mapFfprobeStream(stream: FfprobeStream): Record<string, unknown> {
  const type = readJellyfinStreamType(stream.codec_type);
  const videoRange = readVideoRange(stream);
  const bitDepth = readNonNegativeInteger(stream.bits_per_raw_sample || stream.bits_per_sample) || undefined;
  const codec = String(stream.codec_name ?? "").toLowerCase();
  const textSubtitleCodecs = new Set(["ass", "ssa", "subrip", "srt", "webvtt", "mov_text"]);
  return {
    Codec: codec || undefined,
    Language: stream.tags?.language || undefined,
    TimeBase: stream.time_base || undefined,
    Title: stream.tags?.title || undefined,
    VideoRange: type === "Video" ? videoRange.range : undefined,
    VideoRangeType: type === "Video" ? videoRange.type : undefined,
    ColorRange: stream.color_range || undefined,
    ColorSpace: stream.color_space || undefined,
    ColorTransfer: stream.color_transfer || undefined,
    ColorPrimaries: stream.color_primaries || undefined,
    IsInterlaced: type === "Video" ? !["", "progressive", "unknown"].includes(String(stream.field_order ?? "")) : undefined,
    ChannelLayout: stream.channel_layout || undefined,
    BitRate: readNonNegativeInteger(stream.bit_rate) || undefined,
    BitDepth: bitDepth,
    Channels: readNonNegativeInteger(stream.channels) || undefined,
    SampleRate: readNonNegativeInteger(stream.sample_rate) || undefined,
    IsDefault: Number(stream.disposition?.default ?? 0) === 1,
    IsForced: Number(stream.disposition?.forced ?? 0) === 1,
    Height: readNonNegativeInteger(stream.height) || undefined,
    Width: readNonNegativeInteger(stream.width) || undefined,
    AverageFrameRate: readFrameRate(stream.avg_frame_rate),
    RealFrameRate: readFrameRate(stream.r_frame_rate),
    Profile: stream.profile || undefined,
    Type: type,
    AspectRatio: stream.display_aspect_ratio || stream.sample_aspect_ratio || undefined,
    Index: readNonNegativeInteger(stream.index),
    IsExternal: false,
    IsTextSubtitleStream: type === "Subtitle" ? textSubtitleCodecs.has(codec) : undefined,
    SupportsExternalStream: false,
    DeliveryMethod: "Embed",
    PixelFormat: stream.pix_fmt || undefined,
    Level: readNonNegativeInteger(stream.level) || undefined,
    DisplayTitle: buildStreamDisplayTitle(stream, type, videoRange) || undefined,
  };
}

/** 解析 ffprobe 标准 JSON 输出并生成可直接映射 Jellyfin 的持久化结果。 */
export function parseFfprobeOutput(output: string, fallbackSize: number, fallbackContainer = ""): MediaProbeResult {
  const document = JSON.parse(output) as FfprobeDocument;
  const formatDurationSeconds = Number(document.format?.duration ?? 0);
  const streamDurationSeconds = Math.max(
    0,
    ...(document.streams ?? []).map((stream) => Number(stream.duration ?? 0)).filter(Number.isFinite),
  );
  const durationSeconds = Number.isFinite(formatDurationSeconds) && formatDurationSeconds > 0
    ? formatDurationSeconds
    : streamDurationSeconds;
  const probedContainer = String(document.format?.format_name ?? "").split(",", 1)[0]?.toLowerCase() ?? "";
  return {
    probeVersion: 1,
    // 关键变量：ffprobe 会把 MP4 报为 mov、MKV 报为 matroska，协议输出优先保留真实文件扩展名。
    container: fallbackContainer.toLowerCase() || probedContainer,
    runTimeTicks: Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.floor(durationSeconds * 10_000_000)
      : 0,
    bitRate: readNonNegativeInteger(document.format?.bit_rate),
    size: readNonNegativeInteger(document.format?.size) || Math.max(0, fallbackSize),
    mediaStreams: Array.isArray(document.streams) ? document.streams.map(mapFfprobeStream) : [],
  };
}

/** 从数据库 JSON 中读取已经完成的媒体规格。 */
export function parseMediaProbeResult(value: unknown): MediaProbeResult | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as Partial<MediaProbeResult>;
    if (!parsed || !Array.isArray(parsed.mediaStreams)) return null;
    return {
      probeVersion: readNonNegativeInteger(parsed.probeVersion) || 1,
      container: typeof parsed.container === "string" ? parsed.container : "",
      runTimeTicks: readNonNegativeInteger(parsed.runTimeTicks),
      bitRate: readNonNegativeInteger(parsed.bitRate),
      size: readNonNegativeInteger(parsed.size),
      mediaStreams: parsed.mediaStreams.filter((stream): stream is Record<string, unknown> => (
        Boolean(stream) && typeof stream === "object" && !Array.isArray(stream)
      )),
    };
  } catch {
    return null;
  }
}

/** 只解析状态已经完成的媒体规格，排队、分析中和失败记录都不向协议层暴露。 */
export function parseCompletedMediaProbeResult(status: unknown, value: unknown): MediaProbeResult | null {
  return status === "completed" ? parseMediaProbeResult(value) : null;
}

/** 从一个或多个已经完成的实际文件规格中选择可靠总时长。 */
export function readJellyfinRunTimeTicks(probes: Array<MediaProbeResult | null>): number {
  return Math.max(0, ...probes.map((probe) => probe?.runTimeTicks ?? 0));
}
