import { webview } from '@kit.ArkWeb';
import { Bridge } from '../bridge/Bridge';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';

const DOMAIN: number = 0x0000;
const TAG: string = 'ColorTxtWeb';
/** 同一次返回手势可能触发两次 onBackPress（第二次随手势动画提交迟到），窗口内的重复派发直接吞掉 */
let lastBackHandledAt: number = 0;
const BACK_DEBOUNCE_MS = 2000;

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();

  aboutToAppear(): void {
    // 开启 ArkWeb 远程调试（chrome devtools 协议），便于诊断页面问题
    webview.WebviewController.setWebDebuggingAccess(true);
  }

  /**
   * 手势/按键返回：依据 Web 持续上报的导航深度同步决策。
   * depth>0 时消费返回并让 Web 执行回退（抽屉→阅读→书架）；书架根目录走系统默认（退出）。
   */
  onBackPress(): boolean {
    const now = Date.now();
    if (now - lastBackHandledAt < BACK_DEBOUNCE_MS) {
      return true; // 手势重复派发：消费但不重复处理
    }
    lastBackHandledAt = now;
    const depth = AppStorage.get<number>('webNavDepth') ?? 0;
    hilog.info(DOMAIN, TAG, 'onBackPress depth=%{public}d', depth);
    this.getUIContext().getPromptAction().showToast({
      message: `返回 depth=${depth}`,
      duration: 1200,
    });
    if (depth <= 0) {
      // 书架根目录：真正退出应用
      const ctx = this.getUIContext().getHostContext();
      if (ctx) {
        (ctx as common.UIAbilityContext).terminateSelf();
      }
      return true;
    }
    AppStorage.setOrCreate('webNavDepth', depth - 1);
    try {
      this.controller
        .runJavaScript('window.__goBack && window.__goBack()')
        .catch((err: BusinessError) => {
          hilog.error(DOMAIN, TAG, 'goBack failed: %{public}s', JSON.stringify(err));
        });
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'goBack sync failed: %{public}s', JSON.stringify(err));
    }
    return true;
  }

  build() {
    Column() {
      Web({ src: $rawfile('web/index.html'), controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .fileAccess(true)
        .databaseAccess(true)
        .zoomAccess(false)
        .width('100%')
        .height('100%')
        .backgroundColor('#F7F4EE')
        .onControllerAttached(() => {
          const host = this.getUIContext().getHostContext();
          if (host) {
            this.controller.registerJavaScriptProxy(
              new Bridge(host, this.controller),
              'ohosBridge',
              ['getAppVersion', 'importBooks', 'listBooks', 'readBook', 'readBookBase64', 'readBookChunkBase64', 'writeBookBegin', 'writeBookAppend', 'renameBook', 'deleteBook', 'toast', 'setImmersive', 'reportNavDepth']
            );
          }
          // registerJavaScriptProxy 需要刷新一次页面才能让注入对象生效
          this.controller.refresh();
        })
        .onConsole((event) => {
          hilog.info(DOMAIN, TAG, 'console[%{public}s] %{public}s',
            event.message.getMessageLevel(), event.message.getMessage());
          return false;
        })
        .onErrorReceive((event) => {
          hilog.error(DOMAIN, TAG, 'web error: %{public}s | %{public}s',
            event.error.getErrorInfo(), event.request.getRequestUrl());
        })
    }
  }
}
