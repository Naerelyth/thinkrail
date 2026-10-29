# 从自己的 fork 构建 Linux 安装包

以下命令均在仓库根目录执行，适用于在 Linux x86_64 或 aarch64 机器上构建、自行安装和升级。
无需配置上游发布工作流、签名服务、GitHub Release 或发布凭据。

脚本在构建机器上调用 Electrobun，再封装为 RPM/AppImage。默认版本读取自
`packages/shared/src/version.ts`，也可用 `--version=版本号` 覆盖。原生构建前会把本次版本和渠道
临时注入该文件，让应用内部版本、原生元数据和外层包版本一致。ThinkRail 的名称、标识及原有
分析与更新配置保持不变，RPM 默认包名仍为 `thinkrail-desktop`。

## 准备构建机器

安装根目录 `package.json` 中 `packageManager` 指定的 Bun，以及 Node.js ≥ 22.19，然后安装依赖：

```bash
bun install --frozen-lockfile
```

`--version` 是可选参数，支持 `1.2.3-nightly.8+fork.2` 等 SemVer 预发布和构建后缀，不带 `v`
前缀。不传时使用源码中的版本；当前源码默认值是 `0.0.0-dev`。显式留空或格式无效时会在构建前
报错，不要求提交带 Git tag。下文的 `1.2.3` 均为示例，请替换为你确定的版本。

打包需要 `desktop-file-validate`，stable/canary 归档解包需要 tar 和 zstd，RPM 还需要
`rpmbuild` 及随 RPM 工具提供的 `rpmdeps` 依赖扫描器。例如：

```bash
sudo dnf install rpm-build desktop-file-utils tar zstd git xdg-utils
# Ubuntu 24.04+：
sudo apt install rpm desktop-file-utils tar zstd git xdg-utils
```

AppImage 需要本机架构的 [appimagetool](https://github.com/AppImage/appimagetool/releases)。
将其放入 `PATH`，或设置 `APPIMAGETOOL=/绝对路径/appimagetool`。若它本身是 AppImage，而构建机器
没有 FUSE，可先通过 `--appimage-extract` 解包，再将 `APPIMAGETOOL` 指向解包后的 `AppRun`。
`APPIMAGETOOL_RUNTIME_FILE` 可指定已下载的 AppImage runtime，供离线打包使用。脚本不会安装或
下载打包工具；首次安装项目依赖和准备 Electrobun SDK 仍需要网络。

## 构建与输出

```bash
bun run desktop:package:linux --check # 只检查打包依赖、版本参数和输入，不注入源码
bun run desktop:package:linux         # 使用源码版本，构建一次，生成 RPM 和 AppImage
bun run desktop:package:rpm           # 只生成 RPM
bun run desktop:package:appimage      # 只生成 AppImage
bun run desktop:package:linux --version=1.2.3 --channel=stable
bun run desktop:package:linux --version=1.2.3-nightly.8 --channel=nightly
bun run desktop:package:linux --version=1.2.3 --output-dir=./dist/linux
```

渠道默认 `stable`。`--channel=nightly` 对应 Electrobun 的 canary 环境，`--channel=dev` 对应
dev 环境；也保留 `--env=stable|canary|dev` 写法。两种参数一起使用时必须指向同一渠道，否则报错。
名称规则沿用原有构建：nightly 的 RPM 包名为 `thinkrail-desktop-nightly`，dev 为
`thinkrail-desktop-dev`。

构建时只临时替换共享模块的 `version` 和 `channel`，保留 `commit`、`posthogProjectKey` 及其他
源码内容。原生构建成功、失败或处理到中断信号后都会恢复原文件；已有的本地修改也会保留。
备份放在系统临时目录，避免被 Electrobun 清理。同一工作目录中的构建应串行执行，构建期间不要
编辑该版本文件。

默认输出目录为 `apps/desktop/artifacts/linux/`：

- `thinkrail-desktop-<rpm-version>-<release>.<x86_64|aarch64>.rpm`
- `thinkrail-desktop-<version>-<x86_64|aarch64>.AppImage`
- 每个产物对应的 `.sha256` 校验文件。

例如 `--version=1.2.3` 时，外层包版本为 `1.2.3`；`--version=1.2.3-nightly.8` 时，RPM
按其版本语法表示为 `1.2.3~nightly.8`；其他连字符转换为点号。这只是 RPM 的版本表示转换，
应用内和 AppImage 仍使用完整 SemVer。重新封装同一版本的 RPM 时，可以增加打包修订号：

```bash
RPM_RELEASE=2 bun run desktop:package:rpm --version=1.2.3
```

若只需重新封装已有应用，可跳过原生构建；这一步不需要安装 Electrobun 构建依赖，也不会准备 SDK：

```bash
bun run desktop:package:linux --version=1.2.3 --skip-build
```

stable/canary 从 Electrobun 生成的应用归档读取内容，不依赖 release 包装后可能被移除或替换的
展开目录。例如 x64 stable 使用 `apps/desktop/artifacts/stable-linux-x64-ThinkRail.tar.zst`，
canary 使用 `apps/desktop/artifacts/canary-linux-x64-ThinkRail-canary.tar.zst`。脚本在临时目录解包，
保留应用文件及元数据，不修改原归档。

如果原生构建已成功，只是在后续封装时失败，可在构建机器上直接重试，无需重建 Web 或应用：

```bash
bun run desktop:package:rpm --version=1.2.3 --skip-build
# 或：
bun run desktop:package:appimage --version=1.2.3 --skip-build
```

`--skip-build` 不注入源码，也不改写应用。已有产物的元数据版本必须等于本次解析出的版本，渠道和
架构也必须匹配；不匹配时会报错，应去掉 `--skip-build` 重新构建，不能仅重标外层版本。
如果原生构建时传了版本或渠道，重试封装时也应传入相同参数。dev 使用展开目录
`apps/desktop/build/dev-linux-<arch>/ThinkRail-dev`；通过 `bun run desktop:build` 得到的也是 dev
应用，重新封装它时应使用 `--env=dev --skip-build`。`--skip-build --check` 可以只检查重封装需要的
工具和输入。

## 安装与手动验证

RPM/AppImage 安装后的「软件更新」会直接显示对应的手动升级指引，不会调用原生安装器或显示
失败后的重试按钮。请从自己的构建来源获取或重新构建新版本：RPM 使用系统软件安装器升级，
AppImage 替换旧文件；替换前退出 ThinkRail，升级完成后重新启动。

将产物及其 `.sha256` 文件一起复制到目标机器，在产物所在目录校验后安装：

```bash
sha256sum -c thinkrail-desktop-*.rpm.sha256
sudo dnf install ./thinkrail-desktop-*.rpm
thinkrail-desktop
```

安装后也可以从桌面菜单启动 ThinkRail。RPM 将应用放在 `/opt/<package-name>`，并提供同名的
启动命令；已有的 `thinkrail` 浏览器 CLI 命令保持不变。后续构建可用同样的 `dnf install` 命令
升级；相同应用版本的重构建通过递增 `RPM_RELEASE` 区分。

AppImage 可直接运行：

```bash
sha256sum -c thinkrail-desktop-*.AppImage.sha256
chmod +x ./thinkrail-desktop-*.AppImage
./thinkrail-desktop-<version>-<arch>.AppImage
```

请将占位文件名换成实际产物。没有 FUSE 时可使用 `--appimage-extract-and-run`。
AppImage 沿用原生应用的系统依赖：glibc 2.38+、GTK 3、WebKitGTK 4.1、Ayatana AppIndicator 3、
librsvg 2，以及 git 和 xdg-utils；它不额外捆绑这些系统库。RPM 保留这些系统依赖和自动检测的
ABI 要求。已捆绑的私有库（例如 `libasar.so`）会通过 RPM 自身的扫描器识别，其对应能力不再要求
系统另行提供，也不会作为全局共享库向其他 RPM 提供。应用里的私有库文件保持原样。

在目标机器手动检查安装、桌面菜单启动、终端和 agent 启动、正常退出及 RPM 升级即可。
