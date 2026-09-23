# Personal-life-secretary

飞书个人生活秘书 · outsourced brain

通过飞书聊天记下待办，用兼容 OpenAI Chat Completions 的模型理解自然语言，使用 SQLite 保存任务并发送提醒。适合个人或小团队自托管，当前为早期版本。

## 功能

- 单聊和允许的群聊接收文字；群聊无需 @ 需要飞书全量群消息权限。
- 按应用、群和用户账号隔离数据；私聊与群内待办分开。
- 自然语言创建、修改、完成任务，持久化提醒、免打扰时段和晚间清单。
- 按事项描述拟取消；晚间清单成功发送后等待 24 小时再正式取消，期间可以恢复。
- 仅指定群允许替明确指定的其他成员新增待办；归属不明确时询问。
- 启动及每日 09:00、21:00 检查当天已保存聊天的漏记候选，确认后才创建。
- Excel/CSV 计划表预览后确认导入。
- Docker 部署、连接健康检查、数据库快照与恢复。

## 不包含什么

此仓库不含任何部署者的账号绑定、App Secret、API Key、聊天记录、待办、数据库或服务器配置。示例账号及测试内容均为占位或虚构数据。旧企业微信接入和私有部署历史不在发布范围内。

## 本地启动

需要 Node.js 24、Python 3.10+。

```bash
npm ci
python3 -m venv .venv
.venv/bin/pip install -r requirements-cloud.txt
cp assistant.example.json assistant.local.json
cp feishu.example.json feishu.local.json
```

Windows 使用 `python -m venv .venv` 和 `.venv\Scripts\pip.exe`。Linux 设置 `ASSISTANT_PYTHON` 为虚拟环境 Python 的绝对路径；Windows 默认使用项目下的 `.venv\Scripts\python.exe`。

在本地配置文件中填入模型配置、飞书 App ID 和 App Secret，不要提交它们。

飞书后台：启用机器人，导入 `feishu-scopes.json`，选择长连接，订阅 `im.message.receive_v1`，发布版本并确保权限审批生效。

```bash
export ASSISTANT_PYTHON="$PWD/.venv/bin/python"
npm start
```

### 成员绑定

初始 `allowed_users` 为空，消息不会交给模型或建立任务。用户先向机器人发送单聊消息，或在目标群发送消息；管理员在本机 `data/feishu/state.json` 的 `unbound` 查看账号和群 ID，经身份核对后更新配置：

```json
{
  "app_id": "YOUR_APP_ID",
  "app_secret": "YOUR_APP_SECRET",
  "allowed_users": [
    {"open_id": "USER_A_OPEN_ID", "name": "用户甲"},
    {"open_id": "USER_B_OPEN_ID", "name": "用户乙"}
  ],
  "allowed_groups": ["GROUP_CHAT_ID"],
  "cross_assign_groups": ["GROUP_CHAT_ID"],
  "owner_open_id": "USER_A_OPEN_ID",
  "enabled": true
}
```

成员和群白名单会动态读取；绑定前的消息不自动重放，请绑定后重新发送。`owner_open_id` 为预留字段，不赋予跨用户读写权。
默认使用“提醒助手”作为机器人名称；群消息中的人名应与配置一致。仅在可信成员群开启代加功能。

## 使用例子

```text
添加 买牛奶
明天下午三点提醒我交材料
待办
取消 买牛奶
不取消 买牛奶
明天下午一点提醒用户甲阅读资料
测试提醒
```

编号仍兼容，但取消可以使用名称片段；多项匹配时询问。正式取消是逻辑归档，历史与备份不会自动擦除。

## 隐私和限制

- 本地 SQLite **不加密**；这不是端到端加密产品，管理员能够访问文件。
- 配置云模型后，相关聊天、任务和记忆会发送给模型提供方；群回复对群成员可见。
- 飞书接入尚未实现音频转写，语音需转文字后发送。
- 只复查已接收的消息；尚未自动补取断线期间的全部历史。
- 单实例运行；不要让不同服务器同时处理同一应用和独立数据库。
- 模型可能误解或返回无效结构。建议先用非重要事项验证，不把此工具作为唯一提醒渠道。
- 跨用户代加是两个数据库间的操作，目前不具备分布式事务保证。
- 无管理员网页、自动账号注册、云托管服务或外部故障告警。

## 部署、测试与贡献

见 [部署说明](DEPLOYMENT.md)、[隐私说明](PRIVACY.md)、[贡献说明](CONTRIBUTING.md)。

```bash
npm test
python -m unittest test_parse_sheet.py
```

测试使用临时/内存数据库与虚构数据，不需要真实 App Secret、API Key 或联网调用模型。

MIT 许可；依赖项目保留各自许可证。本项目不属于飞书或 DeepSeek 官方产品。

## 秘书能力

支持空闲时间建议、早晚复盘、部分完成与剩余工作量、用户确认后的按日分摊计划。详见 [秘书迭代说明](SECRETARY.md)。
