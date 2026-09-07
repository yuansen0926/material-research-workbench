import { fileURLToPath } from "node:url";
import { getConfig } from "./server/config.mjs";
import { openStore } from "./server/db.mjs";
import { createWorkflow } from "./server/workflow.mjs";
import { createHttpServer } from "./server/http.mjs";
import { acquireInstance } from "./server/instance.mjs";
const config = getConfig();
let releaseInstance;
try { releaseInstance = acquireInstance(config.dataDir); }
catch (error) { console.error(error.message); process.exit(1); }
const store = openStore(config.dataDir);
const workflow = createWorkflow(store, config);
const server = createHttpServer({ config, store, workflow, root: fileURLToPath(new URL(".", import.meta.url)) });
server.on("error", error => { console.error(error.code === "EADDRINUSE" ? `端口 ${config.port} 已占用，请在 .env 设置其他 PORT。` : error.message); store.close(); releaseInstance(); process.exitCode = 1; });
server.listen(config.port, "127.0.0.1", () => console.log(`研序工作台：http://127.0.0.1:${server.address().port}\n模型：${config.apiKey ? config.model : "未配置，可使用演示案例"}\n数据：${config.dataDir}`));
function shutdown() {
  workflow.stop();
  server.close(() => { store.close(); releaseInstance(); process.exit(0); });
  server.closeAllConnections();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
