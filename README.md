# truncgap

**查一下你的 coding agent 到底看到了多少工具输出——以及它在半截证据上有没有直接下结论。**

`truncgap` 读一份本地会话 transcript，找出被截断 / 静默砍断的 tool result，
算出丢了多少，然后看接下来几轮里 agent 是换了更窄的命令重试，还是直接说
「没有其他调用点」「这是环境抖动」。零依赖，不调模型，不联网。

```bash
$ node src/cli.mjs scan demo/session-lossy.jsonl

truncgap 0.1.0   demo/session-lossy.jsonl
turns 9   tool results 6   truncated 4 (67%)   lost >= 3,354 lines   1 unknown-size

 line  turn  tool                  evidence                                        follow-up
 2     1     Bash                  1,234 lines omitted (marked)                    retried, narrower @turn 2
 6     3     Bash                  output truncated, no count (marked)             conclusion @turn 4, no retry
 9     5     Read                  lines 2,001-4,120 missing (marked)              retried, narrower @turn 6
 13    7     mcp__repo__search...  payload is cut JSON, does not parse (unmarked)  conclusion @turn 8, no retry

4 truncated · 2 recovered · 2 unverified conclusions · 0 silent
top tools: Bash 2, Read 1, mcp__repo__search_code 1
exit 0 (no --fail-on)
```

上面这份 transcript 是 `demo/session-lossy.jsonl`，**合成数据**，可以直接 clone 下来复现。
同一份文件加 `--fail-on=loss`，有截断就 exit 1，能塞进验收脚本。

## 为什么

Agent 跑长任务时，工具输出会在三个地方被砍：harness 的字符/行数上限、
MCP server 自己的 `slice(0, 8000)`、以及上下文压缩器。砍完之后模型不知道
自己少看了东西，于是基于半截日志给出很自信的结论。

`truncgap` 只回答三个问题：

1. 哪些 tool result 不完整？（有标记的 / 长度正好撞上整数上限的 / JSON 被切断的）
2. 丢了多少？（拿得到计数就算，拿不到标 `unknown`，不猜）
3. 丢了之后 agent 干了什么？换了更窄的命令重试，还是直接下结论？

## 安装

需要 Node >= 22，没有其他依赖。

```bash
git clone https://github.com/kylemarvin884/openbot-truncgap
cd openbot-truncgap

node src/cli.mjs scan demo/session-lossy.jsonl        # 先跑通 demo
node src/cli.mjs scan ~/.claude/projects/<p>/<s>.jsonl  # 再换成你自己的会话
```

或者本地 link 成命令：

```bash
npm install -g .
truncgap scan session.jsonl
```

## 它会报什么

| 证据类型 | 含义 |
| --- | --- |
| `N lines omitted (marked)` | 结果里带明确计数，丢失量可信 |
| `output truncated, no count (marked)` | 有标记但没有计数，只知道不完整 |
| `lines A-B missing (marked)` | 形如 `showing lines 1-2000 of 4120` |
| `payload is cut JSON, does not parse` | 以 `{` / `[` 开头但 JSON 解析失败，通常是被硬切 |
| `length 30000 chars = common hard cap` | 长度正好等于常见上限，**没有标记**，最容易被忽略 |

follow-up 只有三种：`retried, narrower`、`conclusion, no retry`、`silent`。
第三种是「既没重试也没下结论」，通常意味着这段输出后面被忽略掉了。

## 支持的 transcript

- Claude Code JSONL（`tool_use` / `tool_result` block）
- 简化形态：每行 `{ "role": "assistant"|"user"|"tool", "content": "..." }`
- `function_call` / `function_call_output` 形态

其他格式直接报错，不做模糊猜测。

## 用法

```bash
# 人看的表格
node src/cli.mjs scan session.jsonl

# 机器读
node src/cli.mjs scan session.jsonl --json

# 验收：有截断就失败
node src/cli.mjs scan session.jsonl --fail-on=loss

# 只有出现「截断后直接下结论」才失败（更严）
node src/cli.mjs scan session.jsonl --fail-on=unverified

# 调整关联窗口（默认 6 轮）
node src/cli.mjs scan session.jsonl --max-follow=10
```

退出码：`0` 通过 / `1` 命中 `--fail-on` / `2` 参数错误 / `3` 输入读不了。

## 局限（请先读这段）

- **只检测能从文本判断的截断。** 静默硬截断如果既没有标记、长度又不撞整数上限，
  本工具看不见。检出率没有在公开语料上验证过，标为**未验证**。
- **没在真实会话语料上验证过格式支持。** 本机 `~/.claude/projects/` 的样本里
  没有 `tool_result` 记录（只有 `api-request-blob` 形态），所以三种格式只对
  `demo/` 里的合成 fixture 跑通过。解析出 0 条 tool result 时工具会打
  `warning`，不会假装干净。如果你的真实 transcript 读不出来，请开 issue 附一行
  脱敏样本。
- **`conclusion, no retry` 不等于结论是错的。** 它只说明「这段不完整的输出之后，
  下一条 assistant 文本里有断言，而且没有更窄的重试」。判断真值需要人看一眼。
- **「截断导致失败的比例」未验证。** 有一份公开实测说截断对失败率的解释力是 0
  （[viraj-vekariya/03-pathfinder-agent](https://github.com/viraj-vekariya/03-pathfinder-agent)），
  所以本项目不承诺任何「提升成功率」的数字，它只是把证据缺口标出来。
- 不解析 harness 源码去反推真实上限，也不做跨会话聚合。

## 3 个真实用例

1. **无人值守夜跑之后**：早上先扫一遍昨晚的会话，看有没有「基于半截日志下的判断」。
2. **MCP server 交付验收**：确认自己的工具没有在返回前就把 payload 切掉。
3. **改了压缩策略后的回归**：对比改动前后两份 transcript 的丢失比例。

## 测试

```bash
npm test        # node:test，无网络
npm run demo    # 跑两份 fixture：一份干净的，一份到处是截断的
```

## License

MIT
