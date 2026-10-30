# 项目记忆扩展

这是一个可由 OMP 插件管理器安装的项目记忆扩展。OMP 18.13.2 已包含所需的包导出，无需克隆或重新构建 OMP 源码。

在 WSL 终端安装：

```sh
omp plugin install github:baixiedai/omp_extensions#main
```

重启 OMP 后扩展会自动加载。也可以把整个目录放入用户扩展目录 `~/.omp/agent/extensions/project-memory/`，或者在 `~/.omp/agent/config.yml` 的 `extensions:` 列表中配置其绝对路径。

扩展通过 OMP 导出的 `@oh-my-pi/pi-coding-agent/memory-backend/redact` 子路径复用凭据脱敏函数。`package.json` 中的 `omp.extensions` 字段告诉 OMP 插件加载器使用 `index.ts` 作为扩展入口。

扩展在最近的 Git 根目录下创建 `.omp/project-memory/`；没有 Git 时使用启动目录。`memory.json` 保存项目摘要、队列、冲突、水位和事件，每条事实单独写入 `facts/<id>.md`，使用 JSON front matter 保存属性、Markdown 正文保存内容。更新通过 OMP 跨进程文件锁和临时文件替换串行化。该目录可能包含项目对话，是否将它加入版本管理由项目自行决定。

主会话结束后，配对的用户消息和成功结束的助手消息进入持久队列，按会话分组，静默 30 秒后调用当前 OMP 模型提取；连续输入时默认最迟在首条待处理消息入队后 300 秒开始处理，实际还受模型调用和队列处理时间影响。压缩前会把该分支中尚未记录的消息加入队列。纯确认用户消息及其助手回复会一起过滤。待处理队列默认上限为 1000 个会话上下文，同会话更新会合并；纠正、确认、决定、目标、偏好和身份等信号上下文及压缩前快照可越过上限。失败时队列保留，后续输入、下次启动或执行 `/project-memory sync` 可重试。`sync` 优先处理最早到期的一个会话批次，其余批次继续由队列处理。

提取调用使用 OMP 当前模型、模型注册表提供的凭据和请求头，通过独立请求发送系统规则与单独的待处理数据，不读取当前会话历史。记忆与对话字段会转义 XML 结构字符，避免内容伪造提示区块。该调用会消耗当前模型提供方的用量。待处理批次仅包含配对的用户消息和成功结束的助手消息；纯确认用户消息及其助手回复一起过滤。最近六条用户消息中的纠正、确认、决定、目标、偏好和身份表达会成为提示词线索，只有模型确认事实后才写入。

项目摘要、有效事实和冲突会按预算注入。默认使用 OMP 内置 `cl100k_base` tokenizer 计数，上限 2000 token，前 500 token 优先用于纠正类事实。其他模型采用不同分词器时，此数值只是估算。新抽取事实的置信度低于 0.7 时不会保存；活动事实默认上限为 100，超过上限会按置信度从低到高淘汰，淘汰事实正文从事实库移除，事件中只留 ID、置信度和原因。

使用 `/project-memory injected` 查看当前会话最近一次由本扩展提交给 OMP 的完整注入文本、时间、摘要和事实数量以及 token 估算。它展示注入时记录的快照，不会根据后来修改的记忆重新计算。尚未发送消息时会提示没有快照；某轮未注入任何记忆时也会明确显示。快照按会话隔离，仅保存在当前 OMP 进程内，重启后需要正常发送消息才能重新记录。它记录的是本扩展返回的提示词区块，不是模型提供方接收请求的凭证。

默认 90 天后，非保护类别事实可进入陈旧复核；至少 3 个候选才会随正常记忆更新交给模型判断。模型有依据提出废止的事实会被移除，延长建议受配置上限约束。可选的相似去重和有损合并默认关闭。

新入队消息和新生成的事实、摘要使用 OMP 自带的凭据形态脱敏函数；已有待处理消息不会被重写，脱敏也不能保证识别所有敏感信息。持久队列只保留尚未成功处理、经过凭据形态脱敏的对话，成功处理后即移除，失败时保留供重试。`queueMaxDepth` 默认限制为同一项目内 1000 个待处理会话上下文，同会话的多条消息合并计数，信号上下文和压缩快照可以越过上限；`status` 显示的待处理消息条数是另一个计数。

首次使用时，扩展会在当前项目下自动创建 `.omp/project-memory/`。`memory.json` 保存摘要、待处理队列和管理信息，每条事实保存在 `facts/<id>.md`。安装或更新扩展后，退出并重新启动 OMP。可以使用编辑器或 PyCharm 只读查看这些文件。

在 OMP 中执行：

- `/project-memory status`：查看记忆与待处理消息数量。
- `/project-memory usage`：查看 OMP 记录的当前会话用量、项目记忆提取的累计用量、合计和提取占比。OMP 会话总量来自 OMP 的 `getUsageStatistics()`；扩展的独立模型请求不会自动计入 OMP 统计，因此按 OMP 会话 ID 单独保存提供方返回的用量。若提供方没有返回用量，扩展无法精确计入。OMP 统计按其会话记录口径累计，可能包含切换分支前的记录。
- `/project-memory show`：查看活动记忆和 ID。
- `/project-memory injected`：查看当前会话最近一次提交给 OMP 的完整记忆注入快照、时间和 token 估算。
- `/project-memory history`：查看已替换、已归档的事实以及旧摘要。
- `/project-memory events`：查看新增、替换、确认及复核等事实事件与原因。
- `/project-memory search 关键词`：默认使用 FTS5/BM25 查找最多 5 条有效事实，FTS5 不可用或无匹配时回退到子串检索；开启相关度配置后，按词语相关度和置信度排序。
- `/project-memory candidates`：查看候选及其替换关系。
- `/project-memory approve ID`：确认候选；若其依赖的旧事实已变化，保留候选并拒绝替换。
- `/project-memory review`：查看待复核的有效事实。
- `/project-memory keep ID`：保留待复核事实并重置复核时间。
- `/project-memory sync`：立即处理最早到期的会话批次。
- `/project-memory add 内容`：手动添加事实。
- `/project-memory update ID 内容`：更新事实，旧记录保留为过期状态。
- `/project-memory forget ID`：归档指定事实。

项目摘要、队列和事件保存在 JSON manifest 中；每条事实保存在独立 Markdown 文件，摘要更新保留旧版本，事实带有范围、有效期、来源、置信度和状态。当前指令和代码状态优先于记忆。精确重复不会重新写入；模型明确标识被取代的事实时，扩展保存新事实并保留旧事实的归档记录。不确定的冲突会在 `show` 和注入内容中列出双方 ID。事件历史记录每次新增、替换、确认和复核的来源与原因。

可在项目目录 `.omp/project-memory/config.json` 中按需设置以下字段，省略时使用显示的默认值：

```json
{
  "confidenceThreshold": 0.7,
  "injectionTokens": 2000,
  "correctionTokens": 500,
  "maxFacts": 100,
  "staleDays": 90,
  "staleMinCandidates": 3,
  "staleReviewEnabled": true,
  "staleMaxRemovals": 10,
  "staleProtectedCategories": ["correction"],
  "staleMaxLifetimeMultiplier": 20,
  "staleMaxExtensionDays": 3650,
  "debounceSeconds": 30,
  "maxWaitSeconds": 300,
  "queueMaxDepth": 1000,
  "signalPatterns": {},
  "nearDedupEnabled": false,
  "nearDedupThreshold": 0.7,
  "consolidationEnabled": false,
  "consolidationMinFacts": 8,
  "consolidationMaxGroups": 3,
  "consolidationMaxSources": 8,
  "retrievalRelevanceEnabled": false,
  "retrievalRelevanceWeight": 0.5,
  "retrievalDiversityWeight": 0
}
```

相似去重使用词元 Jaccard 相似度，会合并文本不完全相同的事实；有损合并由模型提出，启用后原事实仍保留为 `superseded`。可选的 query-aware 排名按当前请求、词语相关度和置信度排序，并可使用 MMR 惩罚近似事实；默认关闭。搜索使用 `.omp/project-memory/retrieval/facts.sqlite` 中的 FTS5/BM25 索引；索引按活动事实 ID 与正文核对，过期时重建，数据库不可用时回退到子串检索。活动事实默认最多 100 条。错误的配置会提示错误并保留待处理队列。PyCharm 请只读查看 JSON 和 Markdown；不要通过 PyCharm 同时打开 `retrieval/facts.sqlite`，避免占用索引文件。

`signalPatterns` 可按 `correction`、`reinforcement`、`decision`、`goal`、`preference`、`identity` 或 `trivial` 提供正则数组，未配置的类别使用内置模式。`correctionTokens` 不能超过 `injectionTokens`；只设置较小的 `injectionTokens` 时，纠正预算会随之缩小。相似去重使用 `Intl.Segmenter` 分词，和 DeerMem 的具体分词实现并不完全相同。

抽取提示词、消息筛选和事实更新流程参考 [DeerFlow](https://github.com/bytedance/deer-flow) 的 DeerMem；本扩展是 TypeScript 适配实现，并非直接运行 DeerMem Python 后端。项目级范围是有意保留的差异；队列持久化以便重启后重试。新抽取的低置信度事实按阈值拒绝。陈旧事实由模型按证据提出删除或延长建议。当前只做凭据形态脱敏，没有完整身份信息 PII 检测。[DeerFlow MIT 许可](./DEERFLOW-LICENSE.txt)
