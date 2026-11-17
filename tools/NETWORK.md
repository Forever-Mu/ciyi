# 网络与 GitHub 推送说明

## 规则

**需要访问 GitHub 时，先打开 HZVPN，让用户手动点连接。**
不要自己想办法绕（试代理端口、换 TLS 后端、走 API 等），那是浪费时间。

## HZVPN

**用快捷方式启动**（用户指定的方式，保留工作目录等设置）：

```
C:\ProgramData\Microsoft\Windows\Start Menu\Programs\HZVPN\HZVPN.lnk
```

```powershell
Start-Process "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\HZVPN\HZVPN.lnk"
```

快捷方式指向：`C:\Program Files\HZVPN\HZVPN.exe`（参数为空，工作目录 `C:\Program Files\HZVPN`）。
非要直接用 exe 时：`Start-Process "C:\Program Files\HZVPN\HZVPN.exe"`。

启动后窗口会出现在桌面，**由用户点连接**——不要尝试自动操作它的界面。

## 标准流程

```
需要 GitHub
  ↓
Start-Process 打开 HZVPN.lnk
  ↓
告诉用户「HZVPN 打开了，请点连接」
  ↓
等用户说好了
  ↓
验证连通性（见下）
  ↓
再做推送 / 下载
```

## 为什么要这么做

本机直连 GitHub 很不稳定，表现各不相同：

| 现象 | 实际原因 |
|---|---|
| `Failed to connect to github.com:443` | 连接被重置 |
| `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` | 沙箱访问不到证书存储，TLS 建不起来 |
| `curl` / `Invoke-RestMethod` 返回 HTTP 000 | .NET 和 curl 都走 schannel，同样挂 |
| `git push` 报 `couldn't create signal pipe, Win32 error 5` | 沙箱挡住 sh.exe 命名管道 |

**特征**：同一条命令昨天能跑、今天就失败，时好时坏。

## 判断 VPN 是否生效

```powershell
# 三个都该是 200
curl.exe -s -o NUL -w "%{http_code}`n" --max-time 15 https://github.com
curl.exe -s -o NUL -w "%{http_code}`n" --max-time 15 https://api.github.com/rate_limit
git ls-remote --heads origin
```

`api.github.com` 通但 `github.com` 不通，或者反过来，都说明链路还没稳，等一会儿或者让用户换个节点。

## 环境里已知的坑

- **git 全局配置了代理 `http://127.0.0.1:1088`**，那是别的工具留下的，HZVPN 不开时这个端口是死的。
  临时绕开：`git -c http.proxy= -c https.proxy= ...`
- **`.ps1` 脚本必须纯 ASCII**：PowerShell 5.1 按 ANSI 读 BOM-less 文件，中文会破坏引号配对。
- **备用的推送方案**（VPN 实在用不了时）：
  - `tools/read_gh_token.ps1` —— 用 Win32 `CredRead` 从凭据管理器取 GitHub token
  - `tools/push_via_api.ps1` —— 走 Git Data API 提交，git 不通时可用
  - 注意：`api.github.com` 和 `github.com` 是两个域名，可能一个通一个不通
- **下载 Actions 产物**：artifact 的下载地址会 302 到 `*.blob.core.windows.net` 的签名地址，
  重定向时**不能带 Authorization 头**，否则 401。用 Python 的 urllib 手动处理跳转最省事。
