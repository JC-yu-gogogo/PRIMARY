# 语文幼小衔接 · 跨设备同步服务

一个零依赖的 Node 服务，让「语文幼小衔接工作台」在**手机端和网页端之间实时同步学习进度**（积分、打卡、解锁故事、练习成绩、学习日志）。

服务**同时托管前端页面和同步 API**：一台能跑 Node 的主机 + 一个地址，手机和网页打开同一个地址即可同步。

---

## 目录结构

```
.
├── server.js      # 后端：Node + SQLite 数据库 + 同源静态托管 + 同步 API
├── index.html     # 前端：语文幼小衔接工作台（已内置云同步层）
├── package.json   # npm start = node server.js
├── Procfile       # Railway / Render 通用启动命令
├── railway.json   # Railway 部署配置 + 健康检查
├── render.yaml    # Render Blueprints 部署配置
├── .gitignore     # 排除 yw.db / yw.json / node_modules
└── README.md
```

---

## 本地快速开始

需要 **Node ≥ 22**（Node 22 用 `--experimental-sqlite` 跑真实 SQLite；Node ≥ 24 该标志已移除，脚本会自动适配；不支持时回退到 JSON 文件存储，功能一致）。

```bash
# 进入本目录
node server.js
# 或 npm start
```

然后浏览器 / 手机打开 `http://<这台主机的地址>:3000` 即可。

前端 `SYNC_BASE` 默认留空（同源模式），**无需改代码**。

---

## 一键部署到 Railway

1. 把本目录内容推送到一个 GitHub 仓库；
2. Railway 控制台 → New Project → Deploy from GitHub repo，自动识别 Node 并用 `Procfile` 启动；
3. （推荐）加一个 Volume 挂到 `/data`，并在 Variables 中设置 `DB_PATH=/data/yw.db`，让数据持久化。

## 一键部署到 Render

1. 把本目录内容推送到一个 GitHub 仓库；
2. Render 控制台 → New → Blueprints → 选择该仓库（自动读取 `render.yaml`）；
3. 免费档文件系统是临时的，重启会清空数据库；要长期保存请在付费档加 Disk 挂到 `/data`（`render.yaml` 已设 `DB_PATH=/data/yw.db` 与之对应）；
4. 可选：在控制台给 `SYNC_KEY` 填一个值（前端也要带相同密钥才放行）。

部署完成后，Railway / Render 会给你一个公网地址（如 `xxx.up.railway.app` 或 `xxx.onrender.com`），手机和网页打开它即完成跨设备同步。

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务监听端口 | `3000` |
| `PUBLIC_DIR` | 前端静态文件目录 | `server.js` 所在目录 |
| `DB_PATH` | SQLite 数据库文件路径 | `./yw.db` |
| `SYNC_KEY` | 共享密钥；设置后前端须带相同 `x-sync-key` 才能访问 `/api` | 空（不校验） |

---

## 同步 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/ping` | 健康检查 |
| GET | `/api/users` | 列出所有用户（昵称、头像、最近活跃时间） |
| POST | `/api/users` | 创建 / 注册用户（昵称 + 头像 + 状态） |
| GET | `/api/users/:name` | 拉取某用户的完整状态 |
| POST | `/api/users/:name` | 合并推送（字段级合并：积分/连续天数取大、数组去重并集、练习与成绩按日期择优） |
| DELETE | `/api/users/:name` | 删除用户 |

---

## 持久化提醒（重要）

Railway / Render 的磁盘默认是**临时文件系统**，不挂卷的话 `yw.db` 会在每次重启 / 重新部署时丢失。演示无所谓；要长期保存学习数据，务必挂载 Volume / Disk 并设 `DB_PATH=/data/yw.db`（本项目已预置该路径）。

---

## 同步以「昵称」为用户键

请为每个小朋友使用**唯一昵称**（同名会被合并到同一账号）。担心被随意改写可设置 `SYNC_KEY`（服务端 + 前端须一致）。
