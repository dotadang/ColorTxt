/* 连接 ArkWeb DevTools 协议，检查页面运行时状态 */
import WebSocket from "ws";

const wsUrl = process.argv[2];
const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
let id = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === "Runtime.consoleAPICalled") {
    const args = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    console.log(`[console.${msg.params.type}]`, args);
  } else if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    console.log("[exception]", d.text, d.exception?.description ?? "");
  } else if (msg.method === "Log.entryAdded") {
    console.log(`[log.${msg.params.entry.level}]`, msg.params.entry.text, msg.params.entry.url ?? "");
  }
});

ws.on("open", async () => {
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  // 先挂好监听再刷新页面，确保捕获从第一行代码开始的异常/日志
  await send("Page.reload");
  await new Promise((r) => setTimeout(r, 2500));

  const evalJs = async (expr) => {
    const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
    return res.result?.result?.value ?? res.result?.result?.description ?? JSON.stringify(res.result);
  };

  console.log("readyState      =", await evalJs("document.readyState"));
  console.log("title           =", await evalJs("document.title"));
  console.log("#app childCount =", await evalJs("document.getElementById('app')?.childNodes.length"));
  console.log("#app html head  =", await evalJs("document.getElementById('app')?.innerHTML.slice(0,120)"));
  console.log("scripts         =", await evalJs("Array.from(document.scripts).map(s=>s.src).join(', ')"));
  console.log("Vue mounted     =", await evalJs("!!document.querySelector('.m-root')"));
  console.log("ohosBridge      =", await evalJs("typeof window.ohosBridge"));
  console.log("localStorage ok =", await evalJs("(()=>{try{localStorage.setItem('__t','1');const v=localStorage.getItem('__t');localStorage.removeItem('__t');return v==='1'}catch(e){return 'ERR:'+e.message}})()"));
  console.log("performance res =", await evalJs("performance.getEntriesByType('resource').map(r=>r.name.split('/').pop()+':'+r.transferSize).join(', ')"));
  console.log("body text head  =", await evalJs("document.body.innerText.slice(0,80).replace(/\\n/g,'|')"));
  ws.close();
  process.exit(0);
});

ws.on("error", (e) => {
  console.error("WS error:", e.message);
  process.exit(1);
});
