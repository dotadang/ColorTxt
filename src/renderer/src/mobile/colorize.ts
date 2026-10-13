/**
 * 移动端内容上色：把桌面版 Monarch 语法（txtrTextMonarch.ts）的规则模型
 * 移植为逐行 DOM tokenizer，输出 HTML 片段（仅自产 span 标签，文本全部转义）。
 *
 * 与桌面版一致的规则：
 * - root：引号/括号开符优先进入子状态，其次装饰符/数字/英文/标点，其余为正文
 * - 引号内：括号开符仍可进入括号子状态（如「《书名》」），其余按 token 上色，未配对到行尾为止（不跨行）
 * - 括号内：不再嵌套开符，除闭符外全部为 bracketInner（数字/英文等独立色）
 * - token 色与正文色来自 readerPalette 默认方案（明/暗各一）
 */
import {
  LATIN_WORD,
  NUMBER,
  PUNCTUATION_CLASS,
  SPECIAL_MARKERS,
} from "../monaco/txtrTextMonarch";
import {
  defaultReaderPaletteDark,
  defaultReaderPaletteLight,
  type ReaderSurfacePalette,
} from "../constants/readerPalette";

/** 成对引号：开符 → 闭符（＂开闭同形） */
const QUOTE_OPENERS: Record<string, string> = {
  '"': '"',
  "\uFF02": "\uFF02",
  "「": "」",
  "『": "』",
  "\u201C": "\u201D",
  "\u2018": "\u2019",
};

/** 成对括号：开符 → 闭符（与 txtrTextMonarch bracketOpenerRules 一致） */
const BRACKET_OPENERS: Record<string, string> = {
  "《": "》",
  "＜": "＞",
  "〈": "〉",
  "«": "»",
  "‹": "›",
  "(": ")",
  "（": "）",
  "〔": "〕",
  "﹝": "﹞",
  "[": "]",
  "［": "］",
  "【": "】",
  "〖": "〗",
  "{": "}",
  "｛": "｝",
};

const STICKY_FLAGS = "y";
const RE_NUMBER = new RegExp(NUMBER.source, STICKY_FLAGS);
const RE_LATIN = new RegExp(LATIN_WORD.source, STICKY_FLAGS);
const RE_PUNCT = new RegExp(PUNCTUATION_CLASS.source, STICKY_FLAGS);
const RE_MARKER = new RegExp(SPECIAL_MARKERS.source, STICKY_FLAGS);

type Mode = "root" | "quote" | "bracket";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function colorOfToken(token: string, p: ReaderSurfacePalette): string {
  switch (token) {
    case "number":
      return p.txtrNumber;
    case "english":
      return p.txtrEnglish;
    case "marker":
      return p.txtrSpecialMarker;
    case "punct":
      return p.txtrPunctuation;
    case "quote":
      return p.txtrQuoteInner;
    case "bracket":
      return p.txtrBracketInner;
    default:
      return p.bodyText;
  }
}

function span(token: string, text: string, p: ReaderSurfacePalette): string {
  return `<span style="color:${colorOfToken(token, p)}">${escapeHtml(text)}</span>`;
}

function matchStickyAt(re: RegExp, line: string, i: number): string | null {
  re.lastIndex = i;
  const m = re.exec(line);
  return m && m.index === i ? m[0] : null;
}

/** 在 [start,end) 内找与 opener 配对的闭符位置，无则 -1 */
function findCloser(line: string, start: number, end: number, closer: string): number {
  for (let j = start; j < end; j++) {
    if (line[j] === closer) return j;
  }
  return -1;
}

function colorizeSegment(
  seg: string,
  mode: Mode,
  p: ReaderSurfacePalette,
): string {
  let out = "";
  let plain = "";
  const innerToken = mode === "quote" ? "quote" : "bracket";
  const flush = () => {
    if (plain) {
      // 未闭合引号/括号的残余内文着内侧色；root 正文继承容器色
      out += mode === "root" ? escapeHtml(plain) : span(innerToken, plain, p);
      plain = "";
    }
  };

  let i = 0;
  const n = seg.length;  while (i < n) {
    const ch = seg[i]!;

    // 引号开符：仅 root 进入子状态；引号/括号内按普通内文处理
    if (mode === "root" && QUOTE_OPENERS[ch]) {
      const closer = findCloser(seg, i + 1, n, QUOTE_OPENERS[ch]!);
      const innerEnd = closer >= 0 ? closer : n;
      flush();
      out += span("punct", ch, p);
      out += colorizeSegment(seg.slice(i + 1, innerEnd), "quote", p);
      if (closer >= 0) {
        out += span("punct", seg[closer]!, p);
        i = closer + 1;
      } else {
        i = n;
      }
      continue;
    }

    // 括号开符：root 与引号内进入括号子状态；括号内不嵌套
    if ((mode === "root" || mode === "quote") && BRACKET_OPENERS[ch]) {
      const closer = findCloser(seg, i + 1, n, BRACKET_OPENERS[ch]!);
      const innerEnd = closer >= 0 ? closer : n;
      flush();
      out += span("punct", ch, p);
      out += colorizeSegment(seg.slice(i + 1, innerEnd), "bracket", p);
      if (closer >= 0) {
        out += span("punct", seg[closer]!, p);
        i = closer + 1;
      } else {
        i = n;
      }
      continue;
    }

    // 独立 token（引号/括号内同样上色，与桌面一致）
    const tokenAt = (): string | null => {
      if (matchStickyAt(RE_MARKER, seg, i)) return "marker";
      if (matchStickyAt(RE_NUMBER, seg, i)) return "number";
      if (matchStickyAt(RE_LATIN, seg, i)) return "english";
      if (matchStickyAt(RE_PUNCT, seg, i)) return "punct";
      return null;
    };
    const token = tokenAt();
    if (token) {
      const matched =
        token === "marker"
          ? matchStickyAt(RE_MARKER, seg, i)!
          : token === "number"
            ? matchStickyAt(RE_NUMBER, seg, i)!
            : token === "english"
              ? matchStickyAt(RE_LATIN, seg, i)!
              : matchStickyAt(RE_PUNCT, seg, i)!;
      flush();
      // 桌面默认所有分色开关开启：内侧的标点/数字等保持各自 token 色
      out += span(token, matched, p);
      i += matched.length;
      continue;
    }

    plain += ch;
    i++;
  }
  flush();
  return out;
}

/** 单行文本 → 上色 HTML（正文色由容器继承，无需逐字 span） */
export function colorizeLineToHtml(line: string, dark: boolean): string {
  const p = dark ? defaultReaderPaletteDark : defaultReaderPaletteLight;
  return colorizeSegment(line, "root", p);
}

/** 阅读区表面色（背景/标题/正文），随明暗主题切换 */
export function readerSurface(dark: boolean): ReaderSurfacePalette {
  return dark ? defaultReaderPaletteDark : defaultReaderPaletteLight;
}
