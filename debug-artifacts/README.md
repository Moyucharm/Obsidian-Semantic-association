# 调试材料放置说明

以后如果需要快速定位 Obsidian 里的运行问题，请把最新导出的调试文件直接放到这个目录。

建议至少提供：

- `runtime-log.json`
- `error-log.json`
- `index-store.json`

可选但很有帮助：

- `console.txt`
  - 从 Obsidian 开发者控制台复制出来的报错或堆栈
- `repro-notes.md`
  - 记录复现步骤、点击顺序、是否打开设置页、是否断网、是否首次下载模型

推荐命名方式：

- `runtime-log.json`
- `error-log.json`
- `index-store.json`
- `console.txt`
- `repro-notes.md`

如果你想保留多次记录，可以按日期新建子目录，例如：

- `2026-03-09-runtime-stall/runtime-log.json`
- `2026-03-09-runtime-stall/error-log.json`
- `2026-03-09-runtime-stall/index-store.json`
- `2026-03-09-runtime-stall/console.txt`

本目录的目的只有一个：让后续排查时不需要再到处找文件。
