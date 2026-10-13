import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const configDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * 彩读鸿蒙版 Web 构建入口。
 * 产物直接输出到 harmony 壳工程的 rawfile/web/，随 HAP 一起打包。
 * 注意：不要引入 electron.vite.config.ts 里的 Monaco 补丁插件——移动端不含 Monaco。
 */
export default defineConfig({
  root: resolve("src/renderer"),
  plugins: [
    vue(),
    // ArkWeb 的 resource:// 源下 module/crossorigin 资源会因 CORS 被拦，
    // 输出的 IIFE 脚本与 CSS 以经典方式引用
    {
      name: "classic-script-html",
      transformIndexHtml(html) {
        // module → classic 后需补 defer：经典脚本在 head 里会先于 <body> 执行
        return html
          .replace(' type="module" crossorigin', " defer")
          .replace(' crossorigin', "");
      },
    },
  ],
  resolve: {
    alias: {
      "@shared": resolve("src/shared"),
    },
  },
  base: "./",
  publicDir: false, // 桌面版的阅读纹理暂不进移动包；后续按需拷贝
  // @shared/packageDerived.ts 依赖的编译期常量（桌面版由 electron-vite define 注入）
  define: {
    __APP_DISPLAY_NAME__: JSON.stringify("彩读"),
    __GITHUB_REPO_URL__: JSON.stringify("https://github.com/ssnangua/ColorTxt"),
  },
  build: {
    outDir: resolve("harmony/entry/src/main/resources/rawfile/web"),
    emptyOutDir: true,
    target: "chrome110",
    // ArkWeb 的 resource:// 源下 ES module 脚本会因 CORS 被拦，
    // 输出 IIFE 经典脚本绕开（单入口无动态分割，可行）
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        // 输出名必须是 index.html：壳工程 Index.ets 固定加载 $rawfile('web/index.html')
        index: resolve("src/renderer/mobile.html"),
      },
      output: {
        format: "iife",
        inlineDynamicImports: true,
      },
    },
  },
});

function resolve(p: string): string {
  return fileURLToPath(new URL(p, import.meta.url));
}
