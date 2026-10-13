<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch,
} from "vue";
import {
  applyLeadIndentFullWidth,
  chapterTitleForDisplay,
  detectChapterTitle,
} from "../chapter";
import { readBookTextChunked, readEpubAsMarkdown } from "./epub";
import { colorizeLineToHtml, readerSurface } from "./colorize";
import {
  type BookMeta,
  bridge,
  deleteBook,
  importBooks,
  listBooks,
  setImmersive,
  toast,
} from "./ohosBridge";

type ChapterSpan = { title: string; startLine: number };
type BookContent = {
  meta: BookMeta;
  lines: string[];
  spans: ChapterSpan[];
  isMd: boolean;
};
type Pos = {
  ci: number;
  ratio: number;
  page?: number;
  pages?: number;
  /** 阅读锚点：当前跨页首个段落序号（与布局无关，用于换布局后定位） */
  para?: number;
};

const view = ref<"library" | "reader">("library");
const books = ref<BookMeta[]>([]);
const book = ref<BookContent | null>(null);
const ci = ref(0);
const scroller = ref<HTMLElement | null>(null);
const columnsEl = ref<HTMLElement | null>(null);
const showBars = ref(true);
const showToc = ref(false);
const showSettings = ref(false);
const busy = ref(false);

// ---- 翻页模式状态 ----
const PAGE_PAD_X = 22; // 每页左右留白
const PAGE_GAP = 44; // 页间距 = 2 × 留白（双页模式下即中缝宽）
const SPREAD_MIN_W = 620; // 视口宽达到该值且横屏时，允许双页
const pages = ref(1);
const page = ref(0);
const dragX = ref(0);
/** 阅读锚点：当前视起首段落的序号（翻页/滚动时持续更新，与布局无关） */
const anchorPara = ref(0);
const vpW = ref(0);
const vpH = ref(0);
let touchStartX = 0;
let touchStartY = 0;
let touchDragging = false;
let touchMoved = false;
let pendingJumpLastPage = false;

/** 宽视口（折叠屏展开/平板/2in1 横窗）且用户开启时，一屏显示左右两页 */
function isSpreadNow(w: number, h: number): boolean {
  return settings.spread && w >= SPREAD_MIN_W && w > h;
}

const settings = reactive({
  fontSize: 20,
  lineHeight: 1.9,
  dark: false,
  indent: true,
  font: "default" as "default" | "kinghwa",
  readMode: "paged" as "paged" | "scroll",
  spread: true,
});

/** 向 ArkTS 上报导航深度：0=书架 1=阅读 2=阅读+抽屉（供系统返回同步分级决策） */
function reportNav(): void {
  try {
    const depth =
      view.value === "reader" && book.value
        ? showToc.value || showSettings.value
          ? 2
          : 1
        : 0;
    bridge().reportNavDepth(depth);
  } catch {
    // 桥不可用时静默（例如纯浏览器调试）
  }
}

/** 系统返回（onBackPress 消费后调用）：关抽屉 → 退书架 */
function goBack(): void {
  if (showSettings.value) {
    showSettings.value = false;
  } else if (showToc.value) {
    showToc.value = false;
  } else {
    closeBook();
  }
}

onMounted(() => {
  loadSettings();
  refreshBooks();
  window.addEventListener("resize", onViewportResize);
  document.fonts?.addEventListener?.("loadingdone", onFontsLoaded);
  (window as unknown as { __goBack?: () => void }).__goBack = goBack;
  reportNav();
});

watch([view, showToc, showSettings], () => reportNav());

onUnmounted(() => {
  window.removeEventListener("resize", onViewportResize);
  document.fonts?.removeEventListener?.("loadingdone", onFontsLoaded);
});

// 打开目录时，自动把当前章节滚动到列表中部
watch(showToc, async (open) => {
  if (!open || !book.value) return;
  await nextTick();
  requestAnimationFrame(() => {
    document
      .querySelector(".toc-row.active")
      ?.scrollIntoView({ block: "center" });
  });
});

function onViewportResize(): void {
  if (view.value === "reader" && isPaged.value) scheduleMeasure(true);
}

/** 内置字体异步加载完成后字宽变化，需重新分页 */
function onFontsLoaded(): void {
  if (view.value === "reader" && isPaged.value) scheduleMeasure(true);
}

watch(
  () => [
    settings.fontSize,
    settings.lineHeight,
    settings.indent,
    settings.font,
    settings.readMode,
    settings.spread,
  ],
  () => {
    if (view.value === "reader" && isPaged.value) scheduleMeasure(true);
  },
);

// ---------- 设置 ----------

const SETTINGS_KEY = "ct.m.settings";

function loadSettings(): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw) as Partial<typeof settings>;
    if (typeof s.fontSize === "number") settings.fontSize = clamp(s.fontSize, 14, 32);
    if (typeof s.lineHeight === "number") settings.lineHeight = s.lineHeight;
    if (typeof s.dark === "boolean") settings.dark = s.dark;
    if (typeof s.indent === "boolean") settings.indent = s.indent;
    if (s.font === "kinghwa" || s.font === "default") settings.font = s.font;
    if (s.readMode === "paged" || s.readMode === "scroll") settings.readMode = s.readMode;
    if (typeof s.spread === "boolean") settings.spread = s.spread;
  } catch {
    // 忽略损坏的设置
  }
}

function saveSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 存储不可用时忽略
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

const LINE_HEIGHTS = [1.6, 1.9, 2.2];

function cycleLineHeight(): void {
  const idx = LINE_HEIGHTS.indexOf(settings.lineHeight);
  settings.lineHeight = LINE_HEIGHTS[(idx + 1) % LINE_HEIGHTS.length]!;
  saveSettings();
}

// ---------- 书架 ----------

async function refreshBooks(): Promise<void> {
  try {
    books.value = listBooks();
    errBanner.value = "";
  } catch (e) {
    errBanner.value = "读取书架失败：" + (e instanceof Error ? e.message : String(e));
  }
}

async function onImport(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const imported = await importBooks();
    if (imported.length > 0) {
      toast(`已导入 ${imported.length} 本`);
    }
    // epub 预转换：转换结果写入缓存，首次打开即秒开
    for (const meta of imported) {
      if (meta.name.toLowerCase().endsWith(".epub")) {
        toast(`正在转换：${meta.name}`);
        try {
          await readEpubAsMarkdown(meta.name);
        } catch {
          // 预转换失败留到打开时再报错
        }
      }
    }
    await refreshBooks();
  } catch (e) {
    if (!(e instanceof Error && e.message.includes("cancel"))) {
      toast(e instanceof Error ? e.message : "导入失败");
    }
  } finally {
    busy.value = false;
  }
}

function removeBook(meta: BookMeta): void {
  // ArkWeb 里 window.confirm 不弹原生框（需 Web 组件 onConfirm 配合），用二次点击确认代替
  if (confirmDeleteName.value === meta.name) {
    deleteBook(meta.name);
    confirmDeleteName.value = "";
    void refreshBooks();
  } else {
    confirmDeleteName.value = meta.name;
    window.setTimeout(() => {
      if (confirmDeleteName.value === meta.name) confirmDeleteName.value = "";
    }, 3000);
  }
}

const confirmDeleteName = ref("");
/** 显示在书架顶部的持久错误横幅（桥调用/打开失败时可见，不再只靠一闪而过的 toast） */
const errBanner = ref("");
const lastFailedBook = ref("");
const diagText = ref("");

/** 分块读取诊断：直接探测各偏移的返回，定位是文件空、读空还是跳块 */
function runDiagnostics(): void {
  try {
    const name = lastFailedBook.value;
    const books = listBooks();
    const meta = books.find((b) => b.name === name);
    const r = {
      书架中登记大小: meta?.size ?? "未找到",
      读0: (bridge().readBookChunkBase64(name, 0, 262144) || "").length,
      读262144: (bridge().readBookChunkBase64(name, 262144, 262144) || "").length,
      读524288: (bridge().readBookChunkBase64(name, 524288, 262144) || "").length,
      读0取64字节: (bridge().readBookChunkBase64(name, 0, 64) || "").length,
    };
    diagText.value = JSON.stringify(r);
  } catch (e) {
    diagText.value = "诊断异常: " + (e instanceof Error ? e.message : String(e));
  }
}

function fmtSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

function posKey(name: string): string {
  return `ct.m.pos.${name}`;
}

function readPos(name: string): Pos | null {
  try {
    const raw = localStorage.getItem(posKey(name));
    return raw ? (JSON.parse(raw) as Pos) : null;
  } catch {
    return null;
  }
}

function progressPercent(name: string): number | null {
  const pos = readPos(name);
  if (!pos) return null;
  return Math.round(pos.ci * 100 * 1); // 打开书籍前无法按章节数归一，仅标记已读
}

// ---------- 阅读 ----------

function splitChapters(lines: string[]): ChapterSpan[] {
  const spans: ChapterSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    const title = detectChapterTitle(lines[i]!);
    if (title != null && title.length <= 50) {
      spans.push({ title: chapterTitleForDisplay(title), startLine: i });
    }
  }
  if (spans.length === 0 || spans[0]!.startLine > 200) {
    spans.unshift({ title: "正文", startLine: 0 });
  }
  return spans;
}

/** epub 转出的 markdown：按 ATX 标题（1~3 级）切章 */
function splitMdChapters(lines: string[]): ChapterSpan[] {
  const spans: ChapterSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^#{1,3}\s+(.{1,80}?)\s*#*\s*$/);
    if (m && m[1]) {
      const title = m[1].trim();
      if (title) spans.push({ title, startLine: i });
    }
  }
  return spans;
}

/** 超大章节的渲染拆分阈值：行数上限，超出则按序号拆成多个渲染单元 */
const MAX_UNIT_LINES = 1000;

/** 章节切分后，把超过阈值的大章拆成带序号的渲染单元（限制单次 DOM 规模，保证翻页流畅） */
function explodeSpans(spans: ChapterSpan[], lines: string[]): ChapterSpan[] {
  const out: ChapterSpan[] = [];
  for (let i = 0; i < spans.length; i++) {
    const start = spans[i]!.startLine;
    const end = i + 1 < spans.length ? spans[i + 1]!.startLine : lines.length;
    const n = end - start;
    if (n <= MAX_UNIT_LINES) {
      out.push(spans[i]!);
      continue;
    }
    const parts = Math.ceil(n / MAX_UNIT_LINES);
    for (let j = 0; j < parts; j++) {
      out.push({
        title: `${spans[i]!.title}（${j + 1}/${parts}）`,
        startLine: start + j * MAX_UNIT_LINES,
      });
    }
  }
  return out;
}

async function openBook(meta: BookMeta): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const lower = meta.name.toLowerCase();
    const isEpub = lower.endsWith(".epub");
    let text: string;
    if (isEpub) {
      text = await readEpubAsMarkdown(meta.name);
    } else {
      // 大 TXT 也走分块读取（整串跨桥会闪退）
      text = readBookTextChunked(meta.name);
    }
    if (!text.trim()) {
      // 内容为空：附带诊断数据（文件大小/文件头），用于定位是空文件还是格式问题
      let diag = "";
      try {
        const m = listBooks().find((b) => b.name === meta.name);
        const head = bridge().readBookChunkBase64(meta.name, 0, 64) || "";
        diag = JSON.stringify({
          登记大小: m?.size ?? "未找到",
          首块base64长: head.length,
          文件头base64: head.slice(0, 16),
        });
      } catch (e) {
        diag = "诊断异常: " + (e instanceof Error ? e.message : String(e));
      }
      errBanner.value = `《${meta.name}》内容为空。${diag}`;
      lastFailedBook.value = meta.name;
      view.value = "library";
      book.value = null;
      return;
    }
    const lines = text.split(/\r\n|\n|\r/);
    const mdSpans = isEpub ? splitMdChapters(lines) : [];
    const baseSpans =
      mdSpans.length >= 2
        ? mdSpans
        : splitChapters(lines).length >= 1
          ? splitChapters(lines)
          : [{ title: "正文", startLine: 0 }];
    const spans = explodeSpans(baseSpans, lines);
    book.value = { meta, lines, spans, isMd: isEpub };
    const pos = readPos(meta.name);
    ci.value = pos && pos.ci < spans.length ? pos.ci : 0;
    view.value = "reader";
    showBars.value = false; // 进书即沉浸阅读，点中间呼出菜单
    setImmersive(true);
    await nextTick();
    if (isPaged.value) {
      measurePages();
      if (pendingJumpLastPage) {
        page.value = pages.value - 1;
        pendingJumpLastPage = false;
      } else if (typeof pos?.para === "number" && pos.para >= 0) {
        anchorPara.value = pos.para;
        goToAnchorPara(pos.para);
      } else if (typeof pos?.page === "number") {
        page.value = clamp(pos.page, 0, pages.value - 1);
      } else {
        page.value = 0;
      }
    } else if (pos) {
      restoreRatio(pos.ratio);
    } else {
      scroller.value?.scrollTo(0, 0);
    }
  } catch (e) {
    lastFailedBook.value = meta.name;
    diagText.value = "";
    errBanner.value = `打开失败《${meta.name}》：${e instanceof Error ? e.message : String(e)}`;
    view.value = "library";
    book.value = null;
  } finally {
    busy.value = false;
  }
}

function restoreRatio(ratio: number): void {
  void nextTick(() => {
    const el = scroller.value;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = ratio * Math.max(0, el.scrollHeight - el.clientHeight);
    });
  });
}

function closeBook(): void {
  savePos();
  setImmersive(false);
  clearBarsTimer();
  showBars.value = false;
  view.value = "library";
  book.value = null;
  void refreshBooks();
}

/** 滚动模式下按滚动位置取锚点段落（视口上部 1/4 处） */
function anchorFromScrollTop(): number {
  const vp = scroller.value;
  const els = paraEls();
  if (!vp || els.length === 0) return 0;
  const target = vp.scrollTop + vp.clientHeight * 0.25;
  let best = 0;
  for (let i = 0; i < els.length; i++) {
    // 滚动模式无多列，offsetTop 即文档流纵坐标
    if (els[i]!.offsetTop <= target) best = i;
    else break;
  }
  return best;
}

function savePos(): void {
  const el = scroller.value;
  if (!el || !book.value) return;
  let pos: Pos;
  if (isPaged.value) {
    anchorPara.value = currentAnchorPara();
    pos = {
      ci: ci.value,
      ratio: 0,
      page: page.value,
      pages: pages.value,
      para: anchorPara.value,
    };
  } else {
    anchorPara.value = anchorFromScrollTop();
    const denom = Math.max(1, el.scrollHeight - el.clientHeight);
    pos = { ci: ci.value, ratio: clamp(el.scrollTop / denom, 0, 1) };
  }
  try {
    localStorage.setItem(posKey(book.value.meta.name), JSON.stringify(pos));
  } catch {
    // 存储不可用时忽略
  }
}

let lastSave = 0;

function onScroll(): void {
  const now = Date.now();
  if (now - lastSave > 800) {
    lastSave = now;
    savePos();
  }
}

const currentTitle = computed(() => {
  const span = book.value?.spans[ci.value];
  return span ? span.title : "";
});

const readerPalette = computed(() => readerSurface(settings.dark));

const isPaged = computed(() => settings.readMode === "paged");

/** 当前平移步长：单页 = 屏宽；双页 = 2 列 + 2×中缝 */
function pagePitch(): number {
  const w = vpW.value;
  if (!isSpreadNow(w, vpH.value)) return w;
  return Math.round(((w - PAGE_PAD_X * 2 - PAGE_GAP) / 2 + PAGE_GAP) * 2);
}

/** 多列布局样式：每列 = 一页，JS 给出平移量（含跟手拖拽与吸附过渡） */
const columnStyle = computed(() => {
  if (!isPaged.value || !vpW.value) return {};
  return {
    columnFill: "auto",
    height: "100%",
    transform: `translateX(${-page.value * pagePitch() + dragX.value}px)`,
    transition: touchDragging ? "none" : "transform 0.22s ease",
  } as Record<string, string>;
});

/** 同步测量：先命令式落列宽样式，再读 scrollWidth（强制布局），页数可靠 */
function measurePages(): void {
  const el = columnsEl.value;
  const vp = scroller.value;
  if (!isPaged.value || !el || !vp) return;
  const w = vp.clientWidth;
  const h = vp.clientHeight;
  if (!w) return;
  vpW.value = w;
  vpH.value = h;
  const twoCol = isSpreadNow(w, h);
  // 容器内容宽（含左右 22px padding）必须与列宽×列数严格匹配：
  // 单页时列宽=内容宽；双页时 2 列+中缝=内容宽。否则浏览器会拉伸"唯一一列"导致页距漂移
  const colW = twoCol ? (w - PAGE_PAD_X * 2 - PAGE_GAP) / 2 : w - PAGE_PAD_X * 2;
  el.style.columnWidth = colW + "px";
  el.style.columnGap = PAGE_GAP + "px";
  const total = el.scrollWidth;
  if (twoCol) {
    // 列数 = (总宽 − 2×留白 + 中缝) / (列宽+中缝)；跨页数 = 列数 ÷ 2 向上取整
    const nc = Math.max(
      1,
      Math.round((total - PAGE_PAD_X * 2 + PAGE_GAP) / (colW + PAGE_GAP)),
    );
    pages.value = Math.max(1, Math.ceil(nc / 2));
  } else {
    pages.value = Math.max(1, Math.round((total - PAGE_PAD_X - colW) / w) + 1);
  }
  if (page.value > pages.value - 1) page.value = pages.value - 1;
}

function paraEls(): HTMLElement[] {
  const el = columnsEl.value;
  return el ? Array.from(el.querySelectorAll<HTMLElement>("p.rd-p")) : [];
}

function columnMetrics(): { pitch: number; colsPerSpread: number } | null {
  const vp = scroller.value;
  if (!vp) return null;
  const w = vp.clientWidth;
  const h = vpH.value || vp.clientHeight;
  const twoCol = isSpreadNow(w, h);
  const colW = twoCol ? (w - PAGE_PAD_X * 2 - PAGE_GAP) / 2 : w - PAGE_PAD_X * 2;
  return { pitch: colW + PAGE_GAP, colsPerSpread: twoCol ? 2 : 1 };
}

/** 当前跨页首个可见段落的序号（锚点；段落起始列 ≥ 本跨页首列的第一段） */
function currentAnchorPara(): number {
  const els = paraEls();
  const m = columnMetrics();
  if (els.length === 0 || !m) return -1;
  const c0 = page.value * m.colsPerSpread;
  for (let i = 0; i < els.length; i++) {
    const k = Math.round((els[i]!.offsetLeft - PAGE_PAD_X) / m.pitch);
    if (k >= c0) return i;
  }
  return els.length - 1;
}

/** 跳到指定段落所在的跨页 */
function goToAnchorPara(paraIdx: number): void {
  const els = paraEls();
  const m = columnMetrics();
  if (els.length === 0 || !m) return;
  const i = clamp(paraIdx, 0, els.length - 1);
  const k = Math.round((els[i]!.offsetLeft - PAGE_PAD_X) / m.pitch);
  page.value = clamp(Math.floor(k / m.colsPerSpread), 0, pages.value - 1);
}

function scheduleMeasure(keepAnchor = false): void {
  void nextTick(() => {
    requestAnimationFrame(() => {
      // 锚点在翻页/滚动时已持续更新（布局稳定状态），此处不做现场采样——
      // resize 触发时浏览器已完成新布局重排，现场采样会采到错误段落
      measurePages();
      if (keepAnchor) goToAnchorPara(anchorPara.value);
      if (pendingJumpLastPage) {
        page.value = pages.value - 1;
        pendingJumpLastPage = false;
      }
    });
  });
}

function nextPage(): void {
  if (page.value < pages.value - 1) {
    page.value += 1;
    savePos();
  } else {
    nextChapter();
  }
}

function prevPage(): void {
  if (page.value > 0) {
    page.value -= 1;
    savePos();
  } else if (ci.value > 0) {
    pendingJumpLastPage = true;
    gotoChapter(ci.value - 1);
  }
}

function onTouchStart(e: TouchEvent): void {
  if (!isPaged.value) return;
  const t = e.touches[0]!;
  touchStartX = t.clientX;
  touchStartY = t.clientY;
  touchDragging = false;
  touchMoved = false;
}

function onTouchMove(e: TouchEvent): void {
  if (!isPaged.value) return;
  const t = e.touches[0]!;
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;
  if (!touchMoved) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    touchMoved = true;
    touchDragging = Math.abs(dx) > Math.abs(dy);
  }
  if (!touchDragging) return;
  let d = dx;
  const atFirst = page.value === 0;
  const atLast = page.value >= pages.value - 1;
  if ((d > 0 && atFirst) || (d < 0 && atLast)) d = d / 3; // 边界橡皮筋
  dragX.value = d;
}

function onTouchEnd(e: TouchEvent): void {
  if (!isPaged.value) return;
  const target = e.target as HTMLElement | null;
  if (target && typeof target.closest === "function" && target.closest("button, a")) {
    // 章节导航等按钮走原生 click，不参与翻页手势
    touchDragging = false;
    dragX.value = 0;
    return;
  }
  e.preventDefault(); // 抑制合成 click，避免与分区点按重复
  if (touchDragging) {
    touchDragging = false;
    const threshold = Math.min(110, (scroller.value?.clientWidth ?? 0) / 4);
    if (dragX.value <= -threshold) nextPage();
    else if (dragX.value >= threshold) prevPage();
    dragX.value = 0; // 松手吸附（未过阈值回弹）
    return;
  }
  if (touchMoved) return;
  // 点击分区：左 1/3 上一页，右 1/3 下一页，中间呼出/隐藏菜单
  const t = e.changedTouches[0];
  if (!t) return;
  const vp = scroller.value;
  if (!vp) return;
  const x = t.clientX - vp.getBoundingClientRect().left;
  const w = vp.clientWidth;
  if (x < w / 3) prevPage();
  else if (x > (w * 2) / 3) nextPage();
  else toggleBars();
}

const paragraphs = computed(() => {
  const b = book.value;
  if (!b) return [] as string[];
  const start = b.spans[ci.value]!.startLine;
  const end = ci.value + 1 < b.spans.length ? b.spans[ci.value + 1]!.startLine : b.lines.length;
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    let line = b.lines[i]!.trim();
    if (line.length === 0) continue;
    // epub 转 md：跳过图片与残留标题行（标题已在章节列表里）
    if (b.isMd && /^!\[[^\]]*\]\([^)]*\)$/.test(line)) continue;
    if (b.isMd && /^#{1,3}\s/.test(line)) continue;
    // TXT 行首全角缩进（与桌面「行首缩进」一致；md 自带结构不处理）
    if (settings.indent && !b.isMd) {
      line = applyLeadIndentFullWidth(line, { exemptChapterTitle: true });
    }
    out.push(colorizeLineToHtml(line, settings.dark));
  }
  return out;
});

const percent = computed(() => {
  const b = book.value;
  if (!b || b.spans.length === 0) return 0;
  if (isPaged.value) {
    const pageFrac = pages.value > 1 ? page.value / (pages.value - 1) : 1;
    return clamp(((ci.value + pageFrac) / b.spans.length) * 100, 0, 100);
  }
  const el = scroller.value;
  const inChapter = el
    ? clamp(el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight), 0, 1)
    : 0;
  return clamp(((ci.value + inChapter) / b.spans.length) * 100, 0, 100);
});

function gotoChapter(i: number): void {
  if (!book.value) return;
  savePos();
  ci.value = clamp(i, 0, book.value.spans.length - 1);
  showToc.value = false;
  if (!pendingJumpLastPage) {
    page.value = 0;
    pages.value = 1;
    anchorPara.value = 0;
  }
  void nextTick(() => {
    if (isPaged.value) scheduleMeasure();
    else scroller.value?.scrollTo(0, 0);
  });
  savePos();
}

function prevChapter(): void {
  gotoChapter(ci.value - 1);
}

function nextChapter(): void {
  gotoChapter(ci.value + 1);
}

let barsAutoHideTimer = 0;

function clearBarsTimer(): void {
  if (barsAutoHideTimer) {
    window.clearTimeout(barsAutoHideTimer);
    barsAutoHideTimer = 0;
  }
}

/** 呼出顶栏/底栏，4 秒无操作自动隐藏回沉浸状态 */
function showBarsTemporarily(): void {
  showBars.value = true;
  clearBarsTimer();
  barsAutoHideTimer = window.setTimeout(() => {
    barsAutoHideTimer = 0;
    showBars.value = false;
  }, 4000);
}

function toggleBars(): void {
  if (showToc.value || showSettings.value) {
    showToc.value = false;
    showSettings.value = false;
    return;
  }
  if (showBars.value) {
    showBars.value = false;
    clearBarsTimer();
  } else {
    showBarsTemporarily();
  }
}
</script>

<template>
  <div class="m-root" :class="{ dark: settings.dark }">
    <!-- 书架 -->
    <div v-if="view === 'library'" class="library">
      <header class="lib-header">
        <h1>彩读</h1>
        <button class="btn-primary" :disabled="busy" @click="onImport">＋ 导入</button>
      </header>
      <div v-if="errBanner" class="err-banner">
        <div>{{ errBanner }}</div>
        <button v-if="lastFailedBook" class="diag-btn" @click="runDiagnostics()">
          {{ diagText ? '再测一次' : '诊断此书' }}
        </button>
        <div v-if="diagText" class="diag-text">{{ diagText }}</div>
      </div>
      <div class="lib-list">
        <div
          v-for="b in books"
          :key="b.name"
          class="book-row"
          @click="openBook(b)"
        >
          <div class="book-info">
            <div class="book-name">{{ b.name }}</div>
            <div class="book-sub">
              {{ fmtSize(b.size) }}
              <span v-if="progressPercent(b.name) !== null" class="book-read">· 已在读</span>
            </div>
          </div>
          <button class="book-del" @click.stop="removeBook(b)">
            {{ confirmDeleteName === b.name ? "确认删" : "删" }}
          </button>
        </div>
        <div v-if="books.length === 0" class="empty">
          书架是空的<br />
          <span class="empty-sub">点右上角「导入」添加 TXT / MD 文件</span>
        </div>
      </div>
    </div>

    <!-- 阅读页 -->
    <div
      v-else-if="book"
      class="reader"
      :class="{ 'font-kinghwa': settings.font === 'kinghwa' }"
      :style="{ '--m-bg': readerPalette.readerBg, '--m-fg': readerPalette.bodyText }"
    >
      <header class="rd-header bar" :class="{ hide: !showBars }">
        <button class="bar-btn" @click="closeBook">‹ 书架</button>
        <div class="rd-header-title">{{ book.meta.name }}</div>
        <div class="bar-btn-placeholder"></div>
      </header>

      <main
        ref="scroller"
        class="rd-viewport"
        :class="{ 'rd-scroll': !isPaged, 'rd-paged': isPaged }"
        @scroll.passive="!isPaged && onScroll()"
        @touchstart.passive="onTouchStart"
        @touchmove.passive="onTouchMove"
        @touchend="onTouchEnd"
        @click="!isPaged && toggleBars()"
      >
        <div ref="columnsEl" class="rd-columns" :style="columnStyle">
          <h2 class="rd-chapter-title" :style="{ color: readerPalette.chapterTitle }">
            {{ currentTitle }}
          </h2>
          <p
            v-for="(p, idx) in paragraphs"
            :key="idx"
            class="rd-p"
            :style="{
              fontSize: settings.fontSize + 'px',
              lineHeight: String(settings.lineHeight),
            }"
            v-html="p"
          ></p>
          <div class="rd-chapter-nav">
            <button :disabled="ci <= 0" @click.stop="prevChapter">上一章</button>
            <span class="rd-nav-pos">{{ ci + 1 }} / {{ book.spans.length }}</span>
            <button :disabled="ci >= book.spans.length - 1" @click.stop="nextChapter">下一章</button>
          </div>
        </div>
      </main>

      <footer class="rd-footer bar" :class="{ hide: !showBars }">
        <button class="bar-btn" @click.stop="showBarsTemporarily(); showToc = true">目录</button>
        <span class="rd-percent">
          <template v-if="isPaged">{{ page + 1 }}/{{ pages }} 页 · </template>{{ Math.round(percent) }}%
        </span>
        <button class="bar-btn" @click.stop="showBarsTemporarily(); showSettings = true">Aa</button>
      </footer>

      <!-- 章节目录 -->
      <div v-if="showToc" class="mask" @click="showToc = false">
        <div class="sheet" @click.stop>
          <div class="sheet-title">目录 · {{ book.spans.length }} 章</div>
          <div class="toc-list">
            <div
              v-for="(span, idx) in book.spans"
              :key="span.startLine"
              class="toc-row"
              :class="{ active: idx === ci }"
              @click="gotoChapter(idx)"
            >
              {{ span.title }}
            </div>
          </div>
        </div>
      </div>

      <!-- 排版设置 -->
      <div v-if="showSettings" class="mask" @click="showSettings = false">
        <div class="sheet settings-sheet" @click.stop>
          <div class="setting-row">
            <span class="setting-label">字号</span>
            <div class="setting-ctrl">
              <button @click="settings.fontSize = clamp(settings.fontSize - 1, 14, 32); saveSettings()">A-</button>
              <span class="setting-value">{{ settings.fontSize }}</span>
              <button @click="settings.fontSize = clamp(settings.fontSize + 1, 14, 32); saveSettings()">A+</button>
            </div>
          </div>
          <div class="setting-row">
            <span class="setting-label">行距</span>
            <div class="setting-ctrl">
              <button @click="cycleLineHeight">{{ settings.lineHeight.toFixed(1) }}</button>
            </div>
          </div>
          <div class="setting-row">
            <span class="setting-label">主题</span>
            <div class="setting-ctrl">
              <button :class="{ on: !settings.dark }" @click="settings.dark = false; saveSettings()">明亮</button>
              <button :class="{ on: settings.dark }" @click="settings.dark = true; saveSettings()">暗黑</button>
            </div>
          </div>
          <div class="setting-row">
            <span class="setting-label">段首缩进</span>
            <div class="setting-ctrl">
              <button :class="{ on: settings.indent }" @click="settings.indent = true; saveSettings()">开</button>
              <button :class="{ on: !settings.indent }" @click="settings.indent = false; saveSettings()">关</button>
            </div>
          </div>
          <div class="setting-row">
            <span class="setting-label">阅读模式</span>
            <div class="setting-ctrl">
              <button :class="{ on: settings.readMode === 'paged' }" @click="settings.readMode = 'paged'; saveSettings()">左右翻页</button>
              <button :class="{ on: settings.readMode === 'scroll' }" @click="settings.readMode = 'scroll'; saveSettings()">上下滚动</button>
            </div>
          </div>
          <div class="setting-row">
            <span class="setting-label">横屏双页</span>
            <div class="setting-ctrl">
              <button :class="{ on: settings.spread }" @click="settings.spread = true; saveSettings()">开</button>
              <button :class="{ on: !settings.spread }" @click="settings.spread = false; saveSettings()">关</button>
            </div>
          </div>
          <div class="setting-row">
            <span class="setting-label">字体</span>
            <div class="setting-ctrl">
              <button :class="{ on: settings.font === 'default' }" @click="settings.font = 'default'; saveSettings()">默认</button>
              <button :class="{ on: settings.font === 'kinghwa' }" @click="settings.font = 'kinghwa'; saveSettings()">京華老宋体</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
:root {
  --m-bg: #f7f4ee;
  --m-fg: #3b3a36;
  --m-sub: #8a867c;
  --m-line: #e5e0d5;
  --m-panel: #fffdf8;
  --m-accent: #d96c3f;
}
.m-root.dark {
  --m-bg: #1b1a17;
  --m-fg: #c9c4b8;
  --m-sub: #6f6a60;
  --m-line: #32302b;
  --m-panel: #26241f;
  --m-accent: #d97b4f;
}
</style>

<style scoped>
.m-root {
  position: fixed;
  inset: 0;
  background: var(--m-bg);
  color: var(--m-fg);
  font-family: "HarmonyOS Sans SC", "Noto Serif SC", serif;
  overflow: hidden;
}
button {
  font-family: inherit;
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.btn-primary {
  background: var(--m-accent);
  color: #fff;
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 15px;
}
.btn-primary:disabled {
  opacity: 0.5;
}

/* ---- 书架 ---- */
.library {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.lib-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: calc(12px + env(safe-area-inset-top)) 20px 12px;
  border-bottom: 1px solid var(--m-line);
}
.lib-header h1 {
  font-size: 20px;
  font-weight: 600;
}
.err-banner {
  margin: 10px 16px 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: #fde8e4;
  color: #b3261e;
  font-size: 13px;
  word-break: break-all;
}
.diag-btn {
  margin-top: 8px;
  padding: 6px 12px;
  font-size: 13px;
  border: 1px solid #b3261e;
  border-radius: 6px;
  color: #b3261e;
}
.diag-text {
  margin-top: 8px;
  font-size: 12px;
  color: #b3261e;
  white-space: pre-wrap;
}
.m-root.dark .err-banner {
  background: #3a1f1c;
  color: #f2b8b5;
}
.lib-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0 calc(16px + env(safe-area-inset-bottom));
}
.book-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--m-line);
}
.book-row:active {
  background: var(--m-panel);
}
.book-name {
  font-size: 16px;
  max-width: 66vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.book-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--m-sub);
}
.book-read {
  color: var(--m-accent);
}
.book-del {
  font-size: 12px;
  color: var(--m-sub);
  border: 1px solid var(--m-line);
  border-radius: 6px;
  padding: 4px 8px;
}
.empty {
  text-align: center;
  margin-top: 30vh;
  font-size: 16px;
  line-height: 2;
}
.empty-sub {
  font-size: 13px;
  color: var(--m-sub);
}

/* ---- 阅读页 ---- */
.reader {
  height: 100%;
  position: relative;
}
/* 视口：滚动 / 翻页两种模式共用 */
.rd-viewport {
  height: 100%;
  position: relative;
}
.rd-scroll {
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: calc(64px + env(safe-area-inset-top)) 22px calc(80px + env(safe-area-inset-bottom));
}
.rd-paged {
  overflow: hidden;
  touch-action: pan-y;
}
.rd-paged .rd-columns {
  height: 100%;
  /* 左右 padding 是分页数学的一部分：容器内容宽 = 列宽，页距 = 屏宽 */
  padding: calc(30px + env(safe-area-inset-top)) 22px calc(24px + env(safe-area-inset-bottom));
  will-change: transform;
}
.rd-columns {
  /* 滚动模式下为普通块容器 */
}
.bar {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: color-mix(in srgb, var(--m-bg) 92%, transparent);
  backdrop-filter: blur(8px);
  transition: transform 0.22s ease, opacity 0.22s ease;
}
.bar.hide {
  transform: translateY(-110%);
  opacity: 0;
  pointer-events: none;
}
.rd-footer.bar {
  bottom: 0;
  transform-origin: bottom;
}
.rd-footer.bar.hide {
  transform: translateY(110%);
}
.rd-header {
  top: 0;
  padding-top: env(safe-area-inset-top);
}
.rd-footer {
  padding-bottom: env(safe-area-inset-bottom);
  border-top: 1px solid var(--m-line);
}
.bar-btn {
  padding: 12px 16px;
  font-size: 15px;
  color: var(--m-accent);
}
.bar-btn-placeholder {
  width: 60px;
}
.rd-header-title {
  font-size: 14px;
  color: var(--m-sub);
  max-width: 56vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rd-percent {
  font-size: 12px;
  color: var(--m-sub);
}
.rd-chapter-title {
  font-size: 1.25em;
  font-weight: 600;
  margin: 0.6em 0 1.2em;
}
.rd-p {
  margin: 0 0 0.9em;
  text-align: justify;
  text-justify: inter-ideograph;
  word-break: break-all;
}
/* 内置字体（Aa 面板可选） */
.reader.font-kinghwa .rd-p,
.reader.font-kinghwa .rd-chapter-title {
  font-family: "KingHwa OldSong", "HarmonyOS Sans SC", serif;
}
.rd-chapter-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 2.4em;
  padding-top: 1.2em;
  border-top: 1px solid var(--m-line);
}
.rd-chapter-nav button {
  font-size: 14px;
  color: var(--m-accent);
  padding: 8px 12px;
}
.rd-chapter-nav button:disabled {
  color: var(--m-sub);
  opacity: 0.5;
}
.rd-nav-pos {
  font-size: 12px;
  color: var(--m-sub);
}

/* ---- 抽屉 ---- */
.mask {
  position: absolute;
  inset: 0;
  z-index: 20;
  background: rgba(0, 0, 0, 0.35);
}
.sheet {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  max-height: 68%;
  display: flex;
  flex-direction: column;
  background: var(--m-panel);
  color: var(--m-fg);
  border-radius: 14px 14px 0 0;
  padding-bottom: env(safe-area-inset-bottom);
}
.sheet-title {
  padding: 14px 18px 8px;
  font-size: 13px;
  color: var(--m-sub);
}
.toc-list {
  overflow-y: auto;
  padding-bottom: 12px;
}
.toc-row {
  padding: 11px 18px;
  font-size: 15px;
  border-bottom: 1px solid var(--m-line);
}
.toc-row.active {
  color: var(--m-accent);
  font-weight: 600;
}
.settings-sheet {
  padding: 10px 18px 24px;
}
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 0;
}
.setting-label {
  font-size: 15px;
}
.setting-ctrl {
  display: flex;
  align-items: center;
  gap: 10px;
}
.setting-ctrl button {
  min-width: 44px;
  padding: 8px 12px;
  font-size: 14px;
  border: 1px solid var(--m-line);
  border-radius: 8px;
}
.setting-ctrl button.on {
  color: var(--m-accent);
  border-color: var(--m-accent);
}
.setting-value {
  min-width: 2em;
  text-align: center;
  font-size: 15px;
}
</style>
