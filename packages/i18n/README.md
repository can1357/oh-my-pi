# @oh-my-pi/pi-i18n

oh-my-pi 的共享国际化基础设施。核心包不依赖 React、TUI 或浏览器 API，使用标准 `Intl` 提供 locale 解析、消息插值、复数和日期/数字格式化。

```ts
import { createI18n, resolveLocale } from "@oh-my-pi/pi-i18n";

const locale = resolveLocale({ explicit: "auto", environment: ["zh-CN"] });
const i18n = createI18n(locale);

i18n.t("common.greeting", { name: "Ada" });
```

固定用户界面文案放在 `src/messages/<locale>/` 的语义域文件中。英文资源提供 key 结构，其他语言必须保持相同 key、占位符和复数分支；使用根命令 `bun run i18n:check` 验证资源。

完整的 locale 优先级、Web 存储约定和各 UI 包接入边界见 `../../docs/i18n.md`。
