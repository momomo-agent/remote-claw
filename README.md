# RemoteClaw

远程设备控制系统。设备通过 WebSocket 连接到 Cloudflare Worker，Momo 可以远程执行命令。

## 架构

```
Momo (Mac mini) ──→ CF Worker (wss://remote.momomo.dev) ←── 设备 daemon (MacBook/iPhone/...)
                         ↑
                    Electron menubar app (查看状态/历史)
```

## 三个组件

### 1. Server (Cloudflare Worker + Durable Objects)
- `remote.momomo.dev`
- WebSocket 连接管理（Durable Object per device）
- 设备注册/认证（简单 token）
- 命令路由：接收命令 → 转发到目标设备 → 返回结果
- REST API：
  - `GET /devices` — 在线设备列表
  - `POST /exec` — 发送命令 `{device, command, timeout?}`
  - `GET /history` — 命令历史
  - `WSS /ws?device=xxx&token=xxx` — 设备连接

### 2. Device Daemon (Node.js)
- 轻量常驻进程，WSS 连接到 server
- 自动重连（指数退避）
- 命令执行器：收到命令 → spawn shell → 流式返回 stdout/stderr
- 注册 capabilities（shell, xcodebuild, screenshot, file-read...）
- 配置文件：`~/.remoteclaw/config.json`

### 3. Electron Menubar App
- macOS menubar 图标（绿色=已连接，灰色=离线）
- 点击展开面板：
  - 设备列表 + 在线状态
  - 命令历史（最近 50 条）
  - 快捷命令输入框
- 内嵌 daemon（不需要单独安装）

## 认证
- 简单 shared secret token（环境变量 `REMOTECLAW_TOKEN`）
- Server 验证每个连接的 token

## 优先级
1. Server + daemon 先跑通（能执行命令拿结果）
2. Electron app 第二步
