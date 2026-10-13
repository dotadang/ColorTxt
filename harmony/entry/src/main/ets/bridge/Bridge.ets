import { webview } from '@kit.ArkWeb';
import { picker } from '@kit.CoreFileKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { bundleManager, common } from '@kit.AbilityKit';
import { promptAction, window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';

const TAG: string = 'ColorTxtBridge';
const DOMAIN: number = 0x0000;

interface BookMeta {
  name: string;
  size: number;
  mtime: number;
}

/**
 * 注入到 ArkWeb 页面的原生桥（window.ohosBridge）。
 * 方法名需与 Index.ets 中 registerJavaScriptProxy 的白名单保持一致。
 * 复杂数据一律以 JSON 字符串跨桥，避免代理对象序列化的兼容性问题。
 */
export class Bridge {
  private controller: webview.WebviewController | null = null;
  private booksDir: string;

  constructor(context: common.Context, controller: webview.WebviewController) {
    this.controller = controller;
    this.booksDir = `${context.filesDir}/books`;
    try {
      if (!fs.accessSync(this.booksDir)) {
        fs.mkdirSync(this.booksDir, true);
      }
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'init booksDir failed: %{public}s', JSON.stringify(err));
    }
  }

  getAppVersion(): string {
    try {
      const info = bundleManager.getBundleInfoForSelfSync(
        bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
      return info.versionName;
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'getAppVersion failed: %{public}s', JSON.stringify(err));
      return 'unknown';
    }
  }

  /** 系统选择器导入 TXT/MD，拷贝进应用沙箱后返回 JSON: BookMeta[] */
  async importBooks(): Promise<string> {
    const docPicker = new picker.DocumentViewPicker();
    const opts = new picker.DocumentSelectOptions();
    opts.fileSuffixFilters = ['.txt', '.md', '.epub'];
    opts.maxSelectNumber = 50;
    const uris: Array<string> = await docPicker.select(opts);
    if (!uris || uris.length === 0) {
      return '[]';
    }
    const imported: BookMeta[] = [];
    for (const uri of uris) {
      try {
        const name = this.safeBookName(this.lastSegment(uri));
        if (!name) {
          continue;
        }
        const dest = `${this.booksDir}/${name}`;
        const src = fs.openSync(uri, fs.OpenMode.READ_ONLY);
        try {
          fs.copyFileSync(src.fd, dest);
        } finally {
          fs.closeSync(src);
        }
        const stat = fs.statSync(dest);
        imported.push({ name: name, size: stat.size, mtime: stat.mtime });
      } catch (err) {
        hilog.error(DOMAIN, TAG, 'import one book failed: %{public}s', JSON.stringify(err));
      }
    }
    return JSON.stringify(imported);
  }

  /** 返回 JSON: BookMeta[]（按导入时间倒序）。跳过转换缓存（.conv.* / .tmp） */
  listBooks(): string {
    const metas: BookMeta[] = [];
    try {
      const names: string[] = fs.listFileSync(this.booksDir);
      for (const n of names) {
        if (n.includes('.conv.') || n.endsWith('.tmp')) {
          continue;
        }
        try {
          const path = `${this.booksDir}/${n}`;
          const st = fs.statSync(path);
          if (st.isFile()) {
            metas.push({ name: n, size: st.size, mtime: st.mtime });
          }
        } catch (err) {
          hilog.error(DOMAIN, TAG, 'stat book failed: %{public}s', JSON.stringify(err));
        }
      }
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'listBooks failed: %{public}s', JSON.stringify(err));
    }
    metas.sort((a, b) => b.mtime - a.mtime);
    return JSON.stringify(metas);
  }

  /** 按文件名读取沙箱书籍内容（UTF-8）；文件不存在/IO 错误返回空串，不抛出 */
  readBook(name: string): string {
    let file: fs.File | null = null;
    try {
      const path = `${this.booksDir}/${this.safeBookName(name)}`;
      file = fs.openSync(path, fs.OpenMode.READ_ONLY);
      const stat = fs.statSync(file.fd);
      const buf = new ArrayBuffer(stat.size);
      fs.readSync(file.fd, buf);
      return util.TextDecoder.create('utf-8').decodeToString(new Uint8Array(buf));
    } catch (err) {
      hilog.info(DOMAIN, TAG, 'readBook empty (missing/io): %{public}s %{public}s', name, JSON.stringify(err));
      return '';
    } finally {
      if (file) {
        fs.closeSync(file);
      }
    }
  }

  /** 按文件名读取沙箱书籍原始字节（Base64）；文件不存在/IO 错误返回空串，不抛出 */
  readBookBase64(name: string): string {
    let file: fs.File | null = null;
    try {
      const path = `${this.booksDir}/${this.safeBookName(name)}`;
      file = fs.openSync(path, fs.OpenMode.READ_ONLY);
      const stat = fs.statSync(file.fd);
      const buf = new ArrayBuffer(stat.size);
      fs.readSync(file.fd, buf);
      return new util.Base64Helper().encodeToStringSync(new Uint8Array(buf));
    } catch (err) {
      hilog.info(DOMAIN, TAG, 'readBookBase64 empty (missing/io): %{public}s %{public}s', name, JSON.stringify(err));
      return '';
    } finally {
      if (file) {
        fs.closeSync(file);
      }
    }
  }

  /**
   * 分块读取沙箱文件（Base64）；offset 越界/文件不存在/IO 错误一律返回空串。
   * 【重要】桥方法内绝不能抛异常：同步抛出会被系统判定为未捕获运行时错误，
   * 直接终止应用（Kill Reason: Js Error）。
   */
  readBookChunkBase64(name: string, offset: number, length: number): string {
    const path = `${this.booksDir}/${this.safeBookName(name)}`;
    let file: fs.File | null = null;
    try {
      file = fs.openSync(path, fs.OpenMode.READ_ONLY);
      const stat = fs.statSync(file.fd);
      if (offset >= stat.size) {
        return '';
      }
      const len = Math.min(length, stat.size - offset);
      const buf = new ArrayBuffer(len);
      const read = fs.readSync(file.fd, buf, { offset: offset });
      if (read <= 0) {
        return '';
      }
      return new util.Base64Helper().encodeToStringSync(new Uint8Array(buf, 0, read));
    } catch (err) {
      hilog.info(DOMAIN, TAG, 'chunk read empty (missing/io): %{public}s off=%{public}d %{public}s',
        name, offset, JSON.stringify(err));
      return '';
    } finally {
      if (file) {
        fs.closeSync(file);
      }
    }
  }

  /** 分块写入：首块前清空目标文件 */
  writeBookBegin(name: string): void {
    const path = `${this.booksDir}/${this.safeBookName(name)}`;
    try {
      if (fs.accessSync(path)) {
        fs.unlinkSync(path);
      }
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'writeBookBegin failed: %{public}s', JSON.stringify(err));
    }
  }

  /** 分块写入：追加一块文本（IO 失败仅记录，不抛出） */
  writeBookAppend(name: string, content: string): void {
    const path = `${this.booksDir}/${this.safeBookName(name)}`;
    let file: fs.File | null = null;
    try {
      file = fs.openSync(
        path,
        fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.APPEND,
      );
      fs.writeSync(file.fd, content);
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'writeBookAppend failed: %{public}s %{public}s', name, JSON.stringify(err));
    } finally {
      if (file) {
        fs.closeSync(file);
      }
    }
  }

  /** 分块写入完成后原子改名（.tmp → 正式名） */
  renameBook(from: string, to: string): void {
    try {
      fs.renameSync(
        `${this.booksDir}/${this.safeBookName(from)}`,
        `${this.booksDir}/${this.safeBookName(to)}`,
      );
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'renameBook failed: %{public}s %{public}s', from, JSON.stringify(err));
    }
  }

  deleteBook(name: string): void {
    try {
      fs.unlinkSync(`${this.booksDir}/${this.safeBookName(name)}`);
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'deleteBook failed: %{public}s', JSON.stringify(err));
    }
  }

  toast(message: string): void {
    promptAction.showToast({ message: message, duration: 2000 });
  }

  /** Web 侧导航状态变化时上报：0=书架 1=阅读页 2=阅读页+抽屉。供 onBackPress 同步决策 */
  reportNavDepth(depth: number): void {
    hilog.info(DOMAIN, TAG, 'reportNavDepth=%{public}d', depth);
    AppStorage.setOrCreate('webNavDepth', depth);
  }

  /** 沉浸式：阅读时隐藏系统状态栏/导航条，退出阅读时恢复 */
  setImmersive(enabled: boolean): void {
    const win = AppStorage.get<window.Window>('mainWindow');
    if (!win) {
      return;
    }
    win.setWindowLayoutFullScreen(enabled)
      .catch((err: BusinessError) => {
        hilog.error(DOMAIN, TAG, 'layoutFullScreen failed: %{public}s', JSON.stringify(err));
      });
    win.setWindowSystemBarEnable(enabled ? [] : ['status', 'navigation'])
      .catch((err: BusinessError) => {
        hilog.error(DOMAIN, TAG, 'systemBarEnable failed: %{public}s', JSON.stringify(err));
      });
  }

  private lastSegment(uri: string): string {
    const raw = uri.endsWith('/') ? uri.slice(0, -1) : uri;
    const idx = raw.lastIndexOf('/');
    const seg = idx >= 0 ? raw.slice(idx + 1) : raw;
    try {
      return decodeURIComponent(seg);
    } catch (err) {
      return seg;
    }
  }

  private safeBookName(name: string): string {
    return name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 120);
  }
}
