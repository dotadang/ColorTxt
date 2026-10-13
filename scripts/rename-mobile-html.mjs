import { renameSync } from "node:fs";

// vite 对 HTML 入口保留源文件名；壳工程固定加载 $rawfile('web/index.html')，这里统一改名
const target = "harmony/entry/src/main/resources/rawfile/web";
renameSync(`${target}/mobile.html`, `${target}/index.html`);
console.log("renamed mobile.html -> index.html");
