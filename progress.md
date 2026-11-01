## 2026-11-01 - Task: Add Cloudflare Containers deployment path
### What was done：新增 Workers + Durable Objects + Cloudflare Containers 部署入口，将 Web 管理页、noVNC 登录桌面和现有定时调度放入单容器，并通过容器快照保存可变状态。
### Testing
- PASS `npm run cf:types` with Wrangler 4.156.0 and Node.js 24.22.1.
- PASS Worker bundle with Wrangler's esbuild dependency.
- PASS `python3.11 -m compileall -q core webui utils scripts main.py login_desktop_server.py`.
- PASS `python3.11 -m unittest discover -s tests -p test_deployment_contract.py -v` (21 tests).
- PASS `bash -n DouYinSparkFlow/scripts/cloudflare-entrypoint.sh`.
- PASS `git diff --check`.
- NOT RUN full Python test suite: the system Python is 3.9.6 and lacks FastAPI; provisioning the Python 3.11 dependencies did not complete because the Playwright wheel download was unavailable from the configured mirror.
- BLOCKED `npm run cf:deploy -- --dry-run`: Wrangler requires a Docker CLI/engine to build the configured image; Docker is not installed in this environment.
- NOT RUN Cloudflare account deployment.
### Notes
- `.dev.vars.example`：新增本地 checkpoint secret 示例。
- `.gitignore`：忽略本地 secret、Node 安装目录和 Wrangler 生成类型。
- `README.md`：增加 Cloudflare Containers 部署说明入口。
- `DouYinSparkFlow/scripts/cloudflare-entrypoint.sh`：启动 Web、noVNC 和 cron runner，并在正常关闭时保存文件系统快照。
- `cloudflare/worker.ts`：新增 Worker 路由、Durable Object 容器启动/恢复、快照和定时唤醒。
- `wrangler.jsonc`：配置 Container 镜像、DO 绑定及五分钟 Cron Trigger。
- `package.json`：增加 Wrangler 命令和 Node.js 22 运行要求。
- `package-lock.json`：锁定 Wrangler 工具依赖。
- `docs/cloudflare-containers.md`：记录部署步骤、持久化行为、网络限制和云端运行风险。
- `progress.md`：记录本轮结果与验证限制。
- 回滚点：在仓库根目录执行 `git restore -- .gitignore README.md && rm -r cloudflare && rm .dev.vars.example DouYinSparkFlow/scripts/cloudflare-entrypoint.sh docs/cloudflare-containers.md package.json package-lock.json wrangler.jsonc`。

## 2026-11-01 - Task: Preserve Cloudflare snapshots across incompatible image updates
### What was done：发现新镜像会使旧 Container 快照不兼容；现在拒绝自动丢弃快照并从空目录启动，避免静默丢失账号状态。
### Testing
- PASS Worker bundle with Wrangler's esbuild dependency.
- PASS `npm run cf:types` with Wrangler 4.156.0 and Node.js 24.22.1.
- PASS `git diff --check`.
### Notes
- `cloudflare/worker.ts`：遇到不匹配镜像的已有快照时停止启动并保留快照。
- `docs/cloudflare-containers.md`：说明镜像更新需要回滚兼容版本或人工迁移状态。
- `progress.md`：追加本轮状态保护及验证记录。
- 回滚点：仅回退本补充时，可反向应用本节对应改动；原始 Cloudflare 部署改动仍由上一节回滚点管理。
