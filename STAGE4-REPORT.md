# 阶段 4 交付报告：分发

**交付时间**：2026-09-17
**状态**：完成。接收者**不需要装任何东西**

---

## 一句话

解压 → 双击 `install.cmd` → 完事。**不需要预装 Node，不需要命令行，不需要管理员权限。**

---

## 做了什么

### 1. 便携 Node 运行时（自动下载）

安装脚本按这个顺序找运行时：

1. `%APPDATA%\dsh-wps\runtime\node.exe` —— 之前下过的
2. 系统已安装的 `node.exe`（只认真 exe，不认 `.cmd` shim）
3. **都没有 → 自己下一个**

下载走国内镜像（`registry.npmmirror.com`），动态查最新版本，解压后**只保留 `node.exe` + `LICENSE`**
（npm / npx / corepack / 文档全部删掉，省约 9 MB 和一堆文件）。

实测：`node-v24.9.0-win-x64.zip`，**34.71 MB，22 MB/s，几秒下完**。
解出来的 `node.exe`（89.7 MB，自包含）**单独一个文件就能把服务跑起来** —— 已验证。

> 为什么用 `curl.exe` 而不是 PowerShell 的 `Invoke-WebRequest`：
> 实测这个环境里 `Invoke-WebRequest` 连不上外网（TLS 被拦），而 `curl.exe`（Win10 1803+ 自带）正常。
> 而且 curl 自带进度条 —— 34 MB 下载不至于让用户以为卡死了。

### 2. 一键安装

`install.cmd` 双击即可，四步都有明确输出：

| 步骤 | 说明 |
|---|---|
| 1. 准备 Node 运行时 | 见上 |
| 2. 注册加载项 | 写 `publish.xml`，注册 wps/et/wpp 三个组件。**先备份原文件**，不覆盖别人的条目 |
| 3. 注册开机自启 | 用 `.vbs` 隐藏窗口启动，日志写 `service.log` |
| 4. 启动服务 | 立刻可用 |

### 3. 发布打包 + **强制密钥扫描**

```bash
node dev/build-release.mjs      # → dist/dsh-wps-<版本>.zip
```

这不是简单的压缩。**扫到疑似密钥就直接失败、不出包。**

```
[1/4] 扫描源目录里的密钥…
[2/4] 复制文件…
[3/4] 复扫成品…          ← 复制之后再扫一遍，防止搬运途中被带进来
[4/4] 打包…
```

扫描项：

| 特征 | 说明 |
|---|---|
| `sk-` 开头的长串 | 主流厂商 Key 格式 |
| `Bearer <长串>` | 硬编码 token |
| `apiKey` 后的长赋值 | 硬编码凭据 |
| `-----BEGIN ... PRIVATE KEY-----` | 私钥块 |
| `C:\Users\<用户名>\AppData` | 本机用户名路径（顺带防止泄漏环境信息） |

含 `fake` / `dummy` / `fixture` / `not-a-credential` 之类标记的值会跳过 ——
否则测试夹具里的假 Key 会让扫描变成"狼来了"，久而久之没人看。

**这个机制是有效的**：第一次跑就把我自己测试文件里的 3 个假 Key 抓了出来。

---

## 你的 API Key：三层防护

你特别交代了"不要把我的 api 公开"。现在是这样：

| 层 | 机制 |
|---|---|
| **1. 存放位置** | Key 只在 `%APPDATA%\dsh-wps\credentials.json` —— **在用户目录，不在项目里** |
| **2. 版本控制** | `.gitignore` 屏蔽 `credentials.json` / `*.key` / `.env` / `dev/testhome*` / `dist/` |
| **3. 打包强制扫描** | 打到包里就**拒绝出包**，不是提醒，是直接失败 |

### 验证结果

```
源目录扫描       ✔ 无 sk- 形式密钥
凭据文件         ✔ 无
压缩包           ✔ 无
发布 zip 内容     ✔ 41 个文件，不含 credentials/.env/.key/.log/testhome/runtime/node_modules/publish.xml
你的 Key 所在     C:\Users\<你>\AppData\Roaming\dsh-wps\credentials.json（用户目录）
```

---

## 验证清单

| 项 | 结果 |
|---|---|
| 便携 Node 下载 | ✅ 实测 34.71 MB，22 MB/s |
| 解压后只剩 node.exe + LICENSE | ✅ 98.3 MB → 89.7 MB，去掉了 npm/corepack/文档 |
| 便携 node.exe 能跑起服务 | ✅ 起在 43133，`/api/ping` 返回 v0.1.0 |
| 找不到 Node 时给明确指引 | ✅ 网络失败 → 提示两条路（换网络 / 自装 Node） |
| 发布包密钥扫描 | ✅ 源目录 + 成品两次扫描 |
| 发布包内容 | ✅ 125 KB，41 个文件，零敏感文件 |
| 全量回归 | ✅ **76 项全绿** |

---

## 还没做的

| 项 | 说明 |
|---|---|
| **单文件 exe** | 用 Node SEA 把服务和加载项打进一个 exe，彻底去掉那 35 MB 下载。可选优化，不是阻塞项 |
| **一键升级** | 现在升级要重新解压 + 重跑 install.cmd |
| **表格 / 演示组件** | 文档工具目前只适配了文字组件 |
| **接 DSH 运行时** | 之前评估过：性价比不如预期（工具生态不匹配 + 分发变重），运行时的接缝已经留好 |
