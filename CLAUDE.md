# MinBrowser 项目约定

个人隐私浏览器（Electron + TypeScript）。最重要的原则：**私密、安全**。设计见 `docs/DESIGN.md`，安全审查见 `docs/SECURITY.md`。

## 每次改动都必须做

1. **同步更新用户手册 `docs/用户手册.md`**：新增、修改或删除任何用户能看到的功能（按钮、菜单、快捷键、设置、启动方式、行为变化），都要在同一个提交里更新手册对应章节；涉及快捷键的同时更新第 16 节快捷键表。手册必须始终和实际功能一致。
2. **升版本号**：`npm run version:minor -- "改了什么"`（大改版用 `version:major`），会同时更新 package.json、package-lock.json 和 CHANGELOG.md；然后把手册开头“本手册适用于 vN.N”改成新版本。
3. **测试**：`npx tsc --noEmit`、`npm test`（单元测试）、`npm run test:e2e`（无图形界面时用 `xvfb-run -a`，不能以 root 运行 Electron 时用其他方式验证）。新功能要加对应的测试。
4. 架构或安全相关的变化，同步更新 `docs/DESIGN.md` / `docs/SECURITY.md`（包括测试数量）。

## 不要做

- 不要提交 `bookmarks-output/`（用户的个人收藏数据）和 `.screens/`。
- 不要用 `--no-sandbox` 绕过沙箱问题；不要伪装 User-Agent 绕过 Google 登录检测（用户已决定不做）。
- 导出文件（历史、收藏）一律 `mode: 0o600`，并在界面上提醒“导出的文件不加密”。

## 发布

开发分支推送后同步到 `main`：`git push origin <分支>:main`。

## 翻译功能的测试

- 普通端到端测试用假的翻译引擎（`MINBROWSER_FAKE_TRANSLATOR=1`，只在开发版生效）。
- 真实引擎测试：准备一个目录，内含 `changesets/translations-wasm-v2.json`、`changesets/translations-models-v2.json`（Mozilla Remote Settings 的 changeset）和 `attachments/<location>`（对应的 .zst 文件），然后 `MINBROWSER_E2E_MODELS=<目录> npm run test:e2e`。
- 更新引擎：见 `vendor/bergamot/README.md`，加载文件和 WASM 必须配套，`src/main/translation-models.ts` 里锁定的 WASM 哈希要一起改。
