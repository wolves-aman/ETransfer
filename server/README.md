# ETransfer Go 信令服务

Go + Fiber 实现的纯信令服务，同时托管 `client/dist`。支持 WebSocket 与 POST+SSE，环境变量控制启动哪一种。**文件、图片、聊天、音视频全部走 WebRTC，不经过这里。**

## 运行

```bash
cd server
go run .

# 或先构建
go build -o etransfer-server .
./etransfer-server
```

默认监听 `0.0.0.0:9090`，静态目录默认 `client/dist`（在 `server` 目录运行时回退到 `../client/dist`）。

```bash
STATIC_DIR=../client/dist PORT=9090 go run .
```

## 传输模式

```bash
SIGNAL_TRANSPORT=both go run .   # WebSocket + SSE（默认）
SIGNAL_TRANSPORT=ws go run .     # 只开 WebSocket
SIGNAL_TRANSPORT=sse go run .    # 只开 SSE
```

| 模式 | `/ws` | `/api/events` | `/api/signal` |
|---|---|---|---|
| `both` | ✅ | ✅ | ✅ |
| `ws` | ✅ | 404 | 404 |
| `sse` | 不接受 upgrade | ✅ | ✅ |

客户端默认 WebSocket；SSE 模式使用 `window.SIGNAL_TRANSPORT = 'sse'` 或 `?transport=sse`。

## 信令协议

客户端 -> 服务端：

| action | 字段 |
|---|---|
| `CREATE_ROOM` | `room_id?`, `password?`, `expires_in?`, `one_time?`, `max_users?`, `name?` |
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

房间号 4~12 位，只允许字母、数字、`_`、`-`，统一转大写。密码 4~64 位，使用 bcrypt 存储。

一次性房间人数固定为 2，任一成员离开即关闭。普通房间房主离开时迁移给最早加入的成员。过期房间由后台定时清理。

## HTTP

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查，返回当前传输模式 |
| `GET` | `/api/events` | SSE 下行，首帧下发 client_id/token |
| `POST` | `/api/signal` | SSE 上行，JSON body |

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `9090` | 监听地址 |
| `STATIC_DIR` | `client/dist` | 前端构建目录 |
| `SIGNAL_TRANSPORT` | `both` | `both` / `ws` / `sse` |
| `ALLOWED_ORIGINS` | 空 | CORS 白名单 |
| `MAX_USERS` | `8` | 单房间人数 |
| `MAX_ROOM_ID_LENGTH` | `12` | 房间号最大长度 |
| `DEFAULT_EXPIRY_MINUTES` | `180` | 默认有效期 |
| `MAX_EXPIRY_MINUTES` | `1440` | 最长有效期 |
| `MAX_PAYLOAD` | `65536` | 单条消息最大字节数 |
| `HEARTBEAT_INTERVAL` | `30000` | 心跳间隔（毫秒） |
| `SWEEP_INTERVAL` | `30000` | 过期房间清理间隔（毫秒） |

## 测试

```bash
cd server
go test ./...
go vet ./...
```