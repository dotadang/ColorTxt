/**
 * 鸿蒙 ArkWeb 原生桥的类型封装。
 * 实现在 harmony/entry/src/main/ets/bridge/Bridge.ets，
 * 方法名与 Index.ets 里 registerJavaScriptProxy 的白名单一致。
 */

export type BookMeta = {
  name: string;
  size: number;
  mtime: number;
};

declare global {
  interface Window {
    ohosBridge?: {
      getAppVersion(): string;
      importBooks(): Promise<string>;
      listBooks(): string;
      readBook(name: string): string;
      readBookBase64(name: string): string;
      /** 分块读取：offset 越界返回空串 */
      readBookChunkBase64(name: string, offset: number, length: number): string;
      writeBookBegin(name: string): void;
      writeBookAppend(name: string, content: string): void;
      renameBook(from: string, to: string): void;
      deleteBook(name: string): void;
      toast(message: string): void;
      setImmersive(enabled: boolean): void;
      reportNavDepth(depth: number): void;
    };
  }
}

export class BridgeUnavailableError extends Error {
  constructor() {
    super("原生桥未接通（ohosBridge 未注入）");
  }
}

export function bridge(): NonNullable<Window["ohosBridge"]> {
  const b = window.ohosBridge;
  if (!b) throw new BridgeUnavailableError();
  return b;
}

export function listBooks(): BookMeta[] {
  return JSON.parse(bridge().listBooks()) as BookMeta[];
}

export async function importBooks(): Promise<BookMeta[]> {
  return JSON.parse(await bridge().importBooks()) as BookMeta[];
}

export function readBook(name: string): string {
  return bridge().readBook(name);
}

export function deleteBook(name: string): void {
  bridge().deleteBook(name);
}

export function toast(message: string): void {
  try {
    bridge().toast(message);
  } catch {
    // 桥不可用时静默（例如纯浏览器调试）
  }
}

/** 阅读：隐藏系统状态栏/导航条；退出阅读恢复 */
export function setImmersive(enabled: boolean): void {
  try {
    bridge().setImmersive(enabled);
  } catch {
    // 桥不可用时静默
  }
}
