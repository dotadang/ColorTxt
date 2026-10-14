/**
 * 移动端 epub 支持：桥取原始字节（base64）→ 复用桌面版 parseEpub 转 markdown。
 * 桌面伞形入口 convertEbookToMarkdown 会连 pdfjs 一起打包，移动端只直连 parseEpub。
 */
import JSZip from "jszip";
import { convertEpubToArtifacts } from "../ebook/convert/parseEpub";
import {
  detectEncodingLabelFromSample,
  ENCODING_SAMPLE_BYTES,
} from "./textEncoding";
import { bridge } from "./ohosBridge";

/** epub 内部结构诊断：条目数/加密/OPF/spine，用于空内容定位 */
async function diagnoseEpubBytes(bytes: Uint8Array): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files);
    const enc = zip.file("META-INF/encryption.xml");
    const encInfo = enc ? "有encryption.xml(可能DRM加密)" : "无encryption.xml";
    const container = zip.file("META-INF/container.xml");
    let rootfile = "container.xml缺失";
    if (container) {
      const s = await container.async("string");
      rootfile = s.match(/full-path="([^"]+)"/)?.[1] ?? "rootfile未找到";
    }
    const opf = rootfile !== "container.xml缺失" ? zip.file(rootfile) : null;
    let spineInfo = "OPF缺失";
    if (opf) {
      const s = await opf.async("string");
      spineInfo = `OPF长度${s.length},spine项${(s.match(/<itemref/g) ?? []).length},manifest项${(s.match(/<item /g) ?? []).length}`;
    }
    const html样本 = names.filter((n) => n.endsWith(".html") || n.endsWith(".xhtml")).length;
    return `epub诊断: 条目${names.length}个(html:${html样本}); ${encInfo}; rootfile=${rootfile}; ${spineInfo}`;
  } catch (e) {
    return "epub诊断失败: " + (e instanceof Error ? e.message : String(e));
  }
}

/** epub 的转换缓存文件名（与源书同存书库）。v2：清洗规则升级后旧缓存自动失效 */
function convertedCacheName(name: string): string {
  return `${name.replace(/\.[^.]+$/, "") || name}.conv.v2.md`;
}

/** 跨桥单块大小：64KB（base64 后约 87KB）。更大的单串跨桥有闪退风险 */
const BRIDGE_CHUNK = 65536;

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 分块读取沙箱文件并按 UTF-8 解码（大文件安全，永不单串跨桥） */
export function readBookTextChunked(name: string): string {
  const decoder = new TextDecoder("utf-8");
  let out = "";
  let offset = 0;
  for (;;) {
    const b64 = bridge().readBookChunkBase64(name, offset, BRIDGE_CHUNK);
    if (!b64) break;
    const bytes = base64ToBytes(b64);
    out += decoder.decode(bytes, { stream: true });
    offset += bytes.length;
  }
  out += decoder.decode();
  return out;
}

export type BookTextResult = { text: string; encoding: string };

/** 分块读取 TXT/MD：自动检测编码（UTF-8/GBK/Big5/UTF-16 等，采样 64KB） */
export function readBookTextAuto(name: string): BookTextResult {
  const locale = typeof navigator !== "undefined" ? navigator.language : undefined;
  let label = "utf-8";
  const sampleB64 = bridge().readBookChunkBase64(name, 0, ENCODING_SAMPLE_BYTES);
  if (sampleB64) {
    label = detectEncodingLabelFromSample(base64ToBytes(sampleB64), locale);
  }
  try {
    new TextDecoder(label);
  } catch {
    label = "gb18030"; // ArkWeb 不认识的标签一律回退中文 ANSI 超集
  }
  const decoder = new TextDecoder(label);
  let out = "";
  let offset = 0;
  for (;;) {
    const b64 = bridge().readBookChunkBase64(name, offset, BRIDGE_CHUNK);
    if (!b64) break;
    const bytes = base64ToBytes(b64);
    out += decoder.decode(bytes, { stream: true });
    offset += bytes.length;
  }
  out += decoder.decode();
  return { text: out, encoding: label };
}

/** 分块读取沙箱文件的原始字节（epub 等二进制用） */
function readBookBytesChunked(name: string): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  let offset = 0;
  for (;;) {
    const b64 = bridge().readBookChunkBase64(name, offset, BRIDGE_CHUNK);
    if (!b64) break;
    const bytes = base64ToBytes(b64);
    parts.push(bytes);
    total += bytes.length;
    offset += bytes.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** 分块写入：先写 .tmp 全部成功后原子改名，崩溃不会留半截缓存 */
function writeBookTextChunked(name: string, text: string): void {
  const tmp = `${name}.tmp`;
  bridge().writeBookBegin(tmp);
  for (let i = 0; i < text.length; ) {
    let end = Math.min(i + BRIDGE_CHUNK, text.length);
    if (end < text.length) {
      const c = text.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end -= 1; // 不拆代理对
    }
    if (end <= i) break;
    bridge().writeBookAppend(tmp, text.slice(i, end));
    i = end;
  }
  bridge().renameBook(tmp, name);
}

/**
 * 解析 epub → markdown 文本（图片写入项忽略：移动端 v1 纯文本）。
 * 转换结果缓存进沙箱（对齐桌面端 ConvertedTxt 机制），二次打开直接读缓存。
 */
export async function readEpubAsMarkdown(name: string): Promise<string> {
  const cacheName = convertedCacheName(name);
  try {
    const cached = readBookTextChunked(cacheName);
    if (cached.trim()) {
      return stripEpubArtifacts(cached);
    }
  } catch {
    // 无缓存，走转换
  }
  const bytes = readBookBytesChunked(name);
  const outputBase = name.replace(/\.[^.]+$/, "") || name;
  const artifacts = await convertEpubToArtifacts(bytes.buffer, outputBase);
  const md = stripEpubArtifacts(artifacts.utf8);
  if (!md.trim()) {
    // 转换成功但内容为空：抛出内部结构诊断（纯 JS 异常，会显示在书架横幅）
    throw new Error(await diagnoseEpubBytes(bytes));
  }
  try {
    writeBookTextChunked(cacheName, md);
  } catch {
    // 缓存写入失败不影响本次阅读
  }
  return md;
}

/**
 * 清洗转换产物中的非正文标记（桌面版由 markdown 渲染管线消化，移动端 v1 纯文本展示）：
 * - TOC 锚点行 / 行内锚点：`<span id="toc_x_y"></span>`
 * - 行内链接：`[文字](#anchor)` → `文字`（脚注引用等）
 * - 整行都是 HTML 标签的残留
 */
export function stripEpubArtifacts(md: string): string {
  return md
    .replace(/^[ \t]*<span id="[^"]*"><\/span>[ \t]*$/gm, "")
    .replace(/<span id="[^"]*"><\/span>/g, "")
    // 图片/脚注引用整段删除（含行内，如 `![注](#footnote1 "注")`）
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    // 行内链接 → 文字（脚注引用等）
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
    .replace(/^[ \t]*<\/?[a-zA-Z][^>]*>[ \t]*$/gm, "");
}
