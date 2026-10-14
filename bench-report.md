# dsh-exec-optimizer 测评数据

生成于 2026-10-14T10:50:32.243Z（node v24.21.0）

| 项目 | 指标 | 前 | 后 | 省 | 省% | 口径 |
|---|---|---:|---:|---:|---:|---|
| 结果上限 | cap(repo-source) | 25914 | 6932 | 18982 | 73.2 | measured |
| 结果上限 | cap(repo-source-via-bash) | 25914 | 6941 | 18973 | 73.2 | measured |
| 结果上限 | cap(test-runner) | 31273 | 6932 | 24341 | 77.8 | measured |
| 结果上限 | cap(grep-hits) | 88769 | 6930 | 81839 | 92.2 | measured |
| 结果上限 | cap(json-dump) | 34564 | 6930 | 27634 | 80 | measured |
| 结果上限 | cap(minified-bundle) | 60007 | 6936 | 53071 | 88.4 | measured |
| 结果上限 | cap(dir-listing) | 35900 | 6932 | 28968 | 80.7 | measured |
| 结果上限 | cap(build-log) | 26364 | 6930 | 19434 | 73.7 | measured |
| 不动已发内容 | 会被内置裁剪器改写的结果数 | 8 | 0 | 8 | 100 | measured |
| 并行工具调用 | 3 个独立调用：串行 vs 一条消息 | 240000 | 0 | 240000 | 100 | computed |
| 并行工具调用 | 5 个独立调用：串行 vs 一条消息 | 480000 | 0 | 480000 | 100 | computed |
| 并行工具调用 | 8 个独立调用：串行 vs 一条消息 | 840000 | 0 | 840000 | 100 | computed |
| 纪律段落成本 | 并行纪律 | 0 | 581 | -581 | 0 | measured |
| 纪律段落成本 | 失败重放说明 | 0 | 396 | -396 | 0 | measured |
| 纪律段落成本 | 按需加载说明 | 0 | 428 | -428 | 0 | measured |
| 工具 schema 成本 | retry_tool 常驻 | 0 | 575 | -575 | 0 | measured |
| 工具 schema 成本 | load_tools 常驻 | 0 | 364 | -364 | 0 | measured |
| 失败重放 | 重发 vs 补丁（edit） | 1075 | 147 | 928 | 86.3 | measured |
| 失败重放 | 重发 vs 补丁（bash） | 454 | 128 | 326 | 71.8 | measured |
| 失败重放 | 重发 vs 补丁（workflow） | 2002 | 144 | 1858 | 92.8 | measured |
| 复读抑制 | 判定灵敏度 | 0 | 4 | -4 | 0 | measured |
| 复读抑制 | 拦下 9 轮空转省下的重发 | 1200000 | 120173 | 1079827 | 90 | computed |
| 按需加载 | 每个请求的工具 schema（13 个工具） | 4840 | 2700 | 2140 | 44.2 | measured |
| 按需加载 | 每轮固定省下的 token | 1210 | 563 | 647 | 53.5 | measured |
| 提前自动压缩 | 宿主的自动压缩线（复算，仅参考） | 678464 | 678464 | 0 | 0 | measured |
| 提前自动压缩 | 同 20 轮里的输入 token | 9784640 | 4190400 | 5594240 | 57.2 | computed |

### 结果上限 · 逐条素材（实测）

| 素材 | 走哪个工具 | 原始字符 | 裁剪后 | 全文可回读 |
|---|---|---:|---:|---|
| repo-source | read | 25914 | 6932 | 是（逐字节一致） |
| repo-source-via-bash | bash | 25914 | 6941 | 是（逐字节一致） |
| test-runner | bash | 31273 | 6932 | 是（逐字节一致） |
| grep-hits | grep | 88769 | 6930 | 是（逐字节一致） |
| json-dump | bash | 34564 | 6930 | 是（逐字节一致） |
| minified-bundle | read | 60007 | 6936 | 是（逐字节一致） |
| dir-listing | bash | 35900 | 6932 | 是（逐字节一致） |
| build-log | bash | 26364 | 6930 | 是（逐字节一致） |

### 推算用的假设

```json
{
  "parallelContextChars": 120000,
  "autoCompactLine": 300000,
  "autoCompactHostLine": 678464,
  "autoCompactPerRoundTokens": 150000,
  "autoCompactRounds": 20
}
```

换算口径：`CHARS_PER_TOKEN = 4`、`BLOCK_OVERHEAD = 4`，与宿主 `dsh-token-meter` 一致。
