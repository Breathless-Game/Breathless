<!-- Draft text for a desktop release (release.yml puts it on the draft). Edit "What's new", delete this line, then Publish. -->

## 屏息 Breathless 桌面版

**下载**（看下面的 Assets）

| 系统 | 文件 |
| --- | --- |
| Windows | `Breathless-Setup-…-win-x64.exe`（安装版）或 `Breathless-Portable-…-win-x64.exe`（免安装） |
| macOS（Apple 芯片 M1–M4） | `Breathless-…-mac-arm64.dmg` |
| macOS（Intel） | `Breathless-…-mac-x64.dmg` |
| Linux | `Breathless-…-linux-x86_64.AppImage` 或 `Breathless-…-linux-amd64.deb` |

桌面版打开的就是 https://breathless.gotclass.xyz ，所以需要联网，游戏更新后不用重新下载。在双显卡笔记本上会请求用独立显卡。桌面版里的钱包登录还没做好，需要钱包的话暂时请用浏览器。

**更新内容**

- （填写）

**第一次打开**：安装包没有代码签名，系统会弹警告，这是正常的。

- **Windows**：出现“Windows 已保护你的电脑”时，点 **更多信息** → **仍要运行**。
- **macOS**：打开 dmg，把 Breathless 拖进“应用程序”，然后右键（或按住 Control 点按）应用 → **打开** → **打开**。macOS 15 及以上：先双击一次，再到 **系统设置 → 隐私与安全性**，往下找到“已阻止 Breathless”，点 **仍要打开**。如果还是打不开（或提示“已损坏”），在“终端”里运行一次：
  `xattr -dr com.apple.quarantine /Applications/Breathless.app`
- **Linux**：先给 AppImage 加上可执行权限再运行：`chmod +x Breathless-*.AppImage && ./Breathless-*.AppImage`；或者安装 deb：`sudo apt install ./Breathless-*.deb`。

**用的是哪块显卡？** 看日志 `breathless.log` 里的 `GPU active:` 和 `GPU renderer:` 两行。日志位置：Windows `%APPDATA%\Breathless\logs\`，macOS `~/Library/Logs/Breathless/`，Linux `~/.config/Breathless/logs/`。Windows 笔记本如果还是集成显卡：**设置 → 系统 → 屏幕 → 显示卡**，添加 `Breathless.exe`，选 **高性能**。

---

## 屏息 Breathless desktop app

**Download** (see Assets below)

| OS | File |
| --- | --- |
| Windows | `Breathless-Setup-…-win-x64.exe` (installer) or `Breathless-Portable-…-win-x64.exe` (no install) |
| macOS (Apple silicon, M1–M4) | `Breathless-…-mac-arm64.dmg` |
| macOS (Intel) | `Breathless-…-mac-x64.dmg` |
| Linux | `Breathless-…-linux-x86_64.AppImage` or `Breathless-…-linux-amd64.deb` |

The app opens https://breathless.gotclass.xyz, so it needs the internet and stays up to date without a new download. On dual-GPU laptops it asks for the discrete GPU. To log in, the app opens your browser so your wallet extension can approve; then you're back in the app.

**What's new**

- (fill in)

**First launch**: the builds are not code-signed, so your OS warns you. That is expected.

- **Windows**: on "Windows protected your PC", click **More info** → **Run anyway**.
- **macOS**: open the dmg, drag Breathless to Applications, then right-click (Control-click) the app → **Open** → **Open**. On macOS 15 and later: try to open it once, then go to **System Settings → Privacy & Security**, scroll to "Breathless was blocked…" and click **Open Anyway**. If it still won't open (or says it is "damaged"), run this once in Terminal:
  `xattr -dr com.apple.quarantine /Applications/Breathless.app`
- **Linux**: make the AppImage executable, then run it: `chmod +x Breathless-*.AppImage && ./Breathless-*.AppImage`; or install the deb: `sudo apt install ./Breathless-*.deb`.

**Which GPU is it using?** See the `GPU active:` and `GPU renderer:` lines in `breathless.log`, in `%APPDATA%\Breathless\logs\` (Windows), `~/Library/Logs/Breathless/` (macOS) or `~/.config/Breathless/logs/` (Linux). If a Windows laptop still uses the integrated GPU: **Settings → System → Display → Graphics**, add `Breathless.exe` and choose **High performance**.
