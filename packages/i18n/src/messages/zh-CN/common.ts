export const common = {
	greeting: "你好，{name}",
	fileCount: {
		one: "{count} 个文件",
		other: "{count} 个文件",
	},
	cancel: "取消",
	language: "语言",
	languageDescription: "选择界面使用的语言",
	cli: {
		usage: "用法",
		commands: "命令",
		arguments: "参数",
		flags: "选项",
		examples: "示例",
		unknownCommand: "未知命令：{command}",
		commandNotFound: "错误：找不到命令 {command}",
		usageError: "错误：{message}",
		runHelp: "运行 `{command} {name} --help` 查看详细信息。",
	},
} as const;
