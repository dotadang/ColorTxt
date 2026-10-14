/**
 * TXT/MD 文本编码检测（移动端）。
 * 检测逻辑与桌面版 src/main/detectTextEncoding.ts 保持一致：
 * BOM → ASCII → 严格 UTF-8 → jschardet + GBK 字节结构启发式。
 * 解码交给 ArkWeb（Chromium）原生 TextDecoder，支持 gb18030/big5 等标签。
 */
import jschardet from "jschardet";

const SAMPLE_BYTES = 64 * 1024;
const SHORT_SAMPLE_BYTES = 512;
const CHARDET_CONFIDENCE_MIN = 0.7;

const WESTERN_CHARDET_ENCODINGS = new Set([
  "ascii",
  "iso-8859-1",
  "iso-8859-2",
  "iso-8859-15",
  "windows-1250",
  "windows-1252",
  "latin1",
  "latin-1",
  "cp1252",
]);

function normalizeEncodingName(raw: string): string {
  const u = raw.trim().toLowerCase().replace(/\s+/g, "").replace(/_/g, "-");
  if (!u) return "utf-8";
  if (u === "utf-8" || u === "utf8") return "utf-8";
  if (u === "gb2312" || u === "gbk" || u === "gb-2312") return "gb18030";
  if (u === "utf-16le" || u === "utf-16-le") return "utf-16le";
  if (u === "utf-16be" || u === "utf-16-be") return "utf-16be";
  return raw.trim();
}

function encodingFromBom(sample: Uint8Array): string | null {
  if (
    sample.length >= 3 &&
    sample[0] === 0xef &&
    sample[1] === 0xbb &&
    sample[2] === 0xbf
  ) {
    return "utf-8";
  }
  if (sample.length >= 2) {
    if (sample[0] === 0xff && sample[1] === 0xfe) return "utf-16le";
    if (sample[0] === 0xfe && sample[1] === 0xff) return "utf-16be";
  }
  return null;
}

function isAsciiOnly(sample: Uint8Array): boolean {
  for (let i = 0; i < sample.length; i++) {
    if (sample[i]! >= 0x80) return false;
  }
  return true;
}

function isValidUtf8(sample: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function isGbkLead(byte: number): boolean {
  return byte >= 0x81 && byte <= 0xfe;
}

function isGbkTrail(byte: number): boolean {
  return (byte >= 0x40 && byte <= 0x7e) || (byte >= 0x80 && byte <= 0xfe);
}

/** 非 ASCII 字节是否均可按 GBK/GB18030 双字节序列解析（尾部不完整仍视为可能） */
function looksLikeGbkFamily(sample: Uint8Array): boolean {
  let i = 0;
  let hasHighByte = false;
  while (i < sample.length) {
    const b = sample[i]!;
    if (b < 0x80) {
      i++;
      continue;
    }
    hasHighByte = true;
    if (!isGbkLead(b)) return false;
    if (i + 1 >= sample.length) return true;
    if (!isGbkTrail(sample[i + 1]!)) return false;
    i += 2;
  }
  return hasHighByte;
}

function isChineseLocale(locale: string | undefined): boolean {
  const l = (locale ?? "").toLowerCase();
  return l.startsWith("zh");
}

function shouldPreferGbkFamily(
  sample: Uint8Array,
  chardetEncoding: string | undefined,
  confidence: number,
  locale: string | undefined,
): boolean {
  if (!looksLikeGbkFamily(sample) || isValidUtf8(sample)) return false;

  const enc = (chardetEncoding ?? "").toLowerCase().replace(/\s+/g, "");
  if (sample.length < SHORT_SAMPLE_BYTES) return true;
  if (confidence < CHARDET_CONFIDENCE_MIN) return true;
  if (enc && WESTERN_CHARDET_ENCODINGS.has(enc)) return true;
  if (isChineseLocale(locale) && enc !== "gb18030" && enc !== "gb2312" && enc !== "gbk") {
    return confidence < 0.9;
  }
  return false;
}

/** jschardet 的 src 版假设输入是二进制字符串（Uint8Array 会在 slice(-1).split 处崩溃） */
function toBinaryString(bytes: Uint8Array): string {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return bin;
}

/**
 * 从文件头样本推断 TextDecoder 标签。
 * @param locale 可选，如 navigator.language（zh-CN），用于低置信度时的中文 ANSI 回退。
 */
export function detectEncodingLabelFromSample(
  sample: Uint8Array,
  locale?: string,
): string {
  if (sample.length === 0) return "utf-8";

  const bom = encodingFromBom(sample);
  if (bom) return normalizeEncodingName(bom);
  if (isAsciiOnly(sample)) return "utf-8";
  if (isValidUtf8(sample)) return "utf-8";

  const detected = jschardet.detect(toBinaryString(sample));
  const chardetEnc =
    typeof detected?.encoding === "string" ? detected.encoding.trim() : "";
  const confidence =
    typeof detected?.confidence === "number" ? detected.confidence : 0;

  if (
    shouldPreferGbkFamily(sample, chardetEnc || undefined, confidence, locale)
  ) {
    return "gb18030";
  }

  if (chardetEnc) {
    const normalized = normalizeEncodingName(chardetEnc);
    try {
      // 标签必须是 ArkWeb TextDecoder 认识的编码，不认识的一律回退 gb18030
      // eslint-disable-next-line no-new
      new TextDecoder(normalized);
      return normalized;
    } catch {
      return "gb18030";
    }
  }
  return "gb18030";
}

/** 采样大小：64KB 对 CJK 编码检测已足够可靠 */
export const ENCODING_SAMPLE_BYTES = SAMPLE_BYTES;
