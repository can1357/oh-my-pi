export const browserRelay = {
	hint: "此扩展连接到本地 omp-browser-relay 进程。这里的值必须与启动中继时使用的参数一致。",
	labels: { language: "语言", port: "中继端口", token: "令牌", tokenOptional: "可选" },
	language: { auto: "自动", chinese: "简体中文", english: "English" },
	optionsTitle: "OMP Browser Relay 设置",
	save: "保存",
	status: { invalidPort: "端口无效", saved: "已保存" },
	title: "OMP Browser Relay",
} as const;
