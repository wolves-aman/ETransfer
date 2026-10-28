# ETransfer 信令服务

ETransfer 的 WebSocket 信令 + HTTP 辅助服务：负责房间生命周期、密码与有效期、成员管理、SDP / ICE 转发、链接预览和可选的文件中继。**普通文件、聊天与媒体不经过这里。**

## 目录

```
server/
├── server.js           # 启动入口：监听、信号、优雅关闭
├── app.js              # 连接生命周期、消息路由、心跳、限流、房间
├── config.js           # 环境变量
├── logger.js           # 单行 JSON 日志
├── protocol.js         # 消息解析、房间号/密码校验
├── http-api.js         # /health、/api/link-preview、/api/relay
├── relay-store.js      # 本地磁盘中继（可替换为 S3/OSS）
├── room/room.js        # Room / RoomRegistry
└── test/               # node:test
```

## 启动

```bash
npm install
npm start        # node server.js
npm run dev      # node --watch
npm test
```

默认监听 `0.0.0.0:9090`。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `9090` | 监听地址 |
| `MAX_PAYLOAD` | `65536` | 单条 WebSocket 消息最大字节数 |
| `MAX_CONNECTIONS` | `10000` | 最大并发连接 |
| `MAX_ROOMS` | `5000` | 最大房间数 |
| `MAX_USERS` | `8` | 单房间人数上限（前端提供 2/4/6/8） |
| `ROOM_ID_LENGTH` | `6` | 自动短码长度 |
| `DEFAULT_EXPIRY_MINUTES` | `180` | 默认有效期 |
| `MAX_EXPIRY_MINUTES` | `1440` | 最长有效期 |
| `HEARTBEAT_INTERVAL` | `30000` | 服务端 ping 间隔 |
| `RATE_LIMIT_WINDOW` / `RATE_LIMIT_MAX` | `10000` / `200` | 单连接限流 |
| `ALLOWED_ORIGINS` | 空 | 允许的 Origin，逗号分隔；空表示不校验 |
| `SWEEP_INTERVAL` | `30000` | 过期房间/中继清理间隔 |
| `LOG_LEVEL` | `info` | `debug/info/warn/error/silent` |
| `RELAY_ENABLED` | `true` | 是否启用 `/api/relay` |
| `RELAY_DIR` | `server/data/relay` | 中继文件目录 |
| `RELAY_MAX_BYTES` | `209715200` | 单文件中继上限（200MB） |
| `RELAY_TTL` | `86400000` | 中继文件 TTL（24h） |
| `PREVIEW_TIMEOUT` | `5000` | 链接预览抓取超时 |
| `PREVIEW_MAX_BYTES` | `524288` | 预览 HTML 最大读取量 |

## WebSocket 协议

客户端 -> 服务端：

| action | 字段 |
|---|---|
| `CREATE_ROOM` | `room_id?`, `password?`, `expires_in?`（分钟，0=永久）, `one_time?`, `max_users?`, `name?` |
| `JOIN_ROOM` | `room_id`, `password?`, `name?` |
| `LEAVE_ROOM` | - |
| `KICK` | `peer_id`（仅房主） |
| `CLOSE_ROOM` | -（仅房主） |
| `TRANSFER` | `target`, `type`（offer/answer/candidate）, `offer`/`answer`/`candidate` |
| `HEART_BEAT` | - |

服务端 -> 客户端：

- `CREATE_ROOM` / `JOIN_ROOM` 成功：`room_id`, `self_id`, `self_name`, `host`, `peers[]`, `host_id`, `has_password`, `one_time`, `max_users`, `expires_at`
- `PEER_JOINED` / `PEER_LEFT` / `HOST_CHANGED`
- `TRANSFER`：带 `from`，只转发白名单字段
- `KICKED` / `ROOM_CLOSED`
- `HEART_BEAT` ACK
- `ERROR`：`code` + `msg`

房间号 4~12 位，只允许字母、数字、`_`、`-`，统一转大写。密码可选，4~64 位，使用 scrypt + 随机盐存储。

一次性房间人数固定为 2，任一成员离开即关闭。普通房间房主离开时自动迁移给最早加入的成员。过期房间由 sweep 定时关闭。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查 |
| `GET` | `/api/link-preview?url=` | 服务端抓取 Open Graph，带 SSRF 防护（拒绝内网） |
| `POST` | `/api/relay` | 原样上传文件；`X-File-Name` / `X-File-Type` 头 |
| `GET` | `/api/relay/:id` | 下载中继文件，TTL 后失效 |

CORS：`ALLOWED_ORIGINS` 为空时允许 `*`，生产建议配置白名单。

## 部署

```nginx
location /ws {
    proxy_pass http://127.0.0.1:9090;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 120s;
}
location /api/ {
    proxy_pass http://127.0.0.1:9090;
}
```

```bash
HOST=127.0.0.1 PORT=9090 ALLOWED_ORIGINS=https://your-domain.com node server.js
```

## 测试

`npm test` 覆盖协议解析、房间密码/容量/过期/一次性、房主迁移、踢人、Mesh 定向转发、Origin 白名单、健康检查、SSRF 防护、中继上传下载。
