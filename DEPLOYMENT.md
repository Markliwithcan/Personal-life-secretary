# 部署与更新

建议单台 Linux 主机运行一个实例。需要 Docker Engine 和 Compose 插件。
无需公网回调地址；长连接要求访问飞书 API，模型调用还需访问模型服务商。

## 首次部署

1. 下载源代码。创建 `cloud-config` 和 `cloud-data`。
2. 复制 assistant.example.json、feishu.example.json 到 cloud-config 下，并分别改名为 assistant.local.json、feishu.local.json，填写自己的配置。
3. 容器运行身份为 UID/GID 1000:1000。确保 cloud-config 对其可读，cloud-data 对其可写。配置文件权限建议 600；目录建议 700。
4. `docker compose build` 构建镜像。
5. `bash deploy-cloud.sh v0.1.0` 启动并等待健康检查。
6. 配置飞书事件、发布应用、绑定用户，实测文字接收和测试提醒。

Docker 的 build context 使用白名单，不包含 local.json、数据库、日志或私钥。
数据和配置通过独立目录挂载，升级程序不会覆盖这些目录。

## 从其他部署迁移

先停止源实例，使用 Node.js 24 导出一致性快照：

```bash
node cloud-backup.mjs backup /path/to/source/data/feishu /path/to/empty-snapshot
```

通过可信方式传输快照。在停止目标实例的情况下恢复到空目录：

```bash
node cloud-backup.mjs restore /path/to/snapshot /path/to/cloud-data/feishu
```

恢复会验证校验和并拒绝覆盖非空目标。配置和凭据需单独传输。源与目标不要同时运行。
切换窗口消息需按 message_id 对账补取；本项目尚未实现通用自动回补。

## 升级与回退

使用独立版本号运行 `bash deploy-cloud.sh v0.2.0`。脚本先构建，再停机、备份并启动。
成功版本记录在 .env；不要重复使用相同版本号覆盖旧镜像。
没有数据库兼容性问题时，可用 `ASSISTANT_IMAGE=feishu-assistant:OLD_VERSION docker compose up -d --no-build --wait` 回退，再同步修改 .env。
有数据库结构变更时，必须评估迁移兼容性并保留当前与历史快照，不能盲目覆盖数据。

## 运维边界

- `docker compose ps` 查看状态；`docker compose logs --tail 100 assistant` 查看日志。
- `docker compose stop assistant` 正常停机，会等待当前处理并刷写 WAL。
- 健康检查验证 SDK 连接、状态心跳和处理进度；unhealthy 不会自动触发 Docker 重启。
- restart 策略处理进程退出，SDK 负责网络重连。外部监控告警需自行配置。
- 每用户库有 14 天同机备份，完整迁移快照还需包含路由与消息队列。
- 同机备份不能抵御整机故障，另行配置异地备份。
- 时区按 assistant.local.json 设置，服务器系统时区不会自动替换业务时区。

## 发布验证

构建者应执行实际 Docker 构建和容器收发验收。仅通过单元测试不代表已完成云端验收。
