# 牛津树单词骑士 (Oxford Word Knight)

基于牛津树 G1→G2 分级体系的单词学习游戏。

## 快速开始

### 1. 安装依赖
```bash
cd oxford-word-knight
npm install
```

### 2. 启动服务器
```bash
npm start
```

### 3. 打开游戏
浏览器访问: http://localhost:3000

## 字库导入

### CSV 格式要求
文件必须包含以下三列（英文逗号分隔）：
```
oxford_level,word,hint
G1,run,快速移动
G1,jump,离开地面的动作
G2,algorithm,解决问题的步骤
```

- `oxford_level`: 仅支持 `G1` 或 `G2`
- `word`: 英文单词（必填）
- `hint`: 中文提示（可选）

### 导入方式
1. 在 Excel 中编辑字库
2. 文件 → 另存为 → CSV (逗号分隔)
3. 在游戏页面点击上传按钮选择 CSV 文件

或直接调用 API:
```bash
curl -X POST http://localhost:3000/api/import \
  --data-binary @sample-words.csv
```

## 🎧 音素 · 音节特训（practice.html）

在原有拼写闯关之外，新增一条"语音意识"练习线，入口在主页面底部的 **🎧 音素特训** 按钮，或直接访问 `/practice`。

### 四种题型

| 类型 | 说明 | 判定 |
|---|---|---|
| `SYLLABLE_COUNTING` 音节计数 | 看单词 / 听发音，数音节，拍手读 | 选数字（正确答案 ±1 为干扰项） |
| `PHONEME_DISCRIMINATION` 音素辨析 | 听发音，在最小对立对中二选一 | ship / sheep、right / light … |
| `PHONICS_CONTEXT_MATCH` 拼读规则 | 牛津树原句挖空，选同规则家族词 | 字母组合 sh/ch/th/ee/igh… |
| `SIGHT_WORD_FLASH` 视觉词闪现 | 单词闪现 800ms 后消失，选中文意思 | Dolch 高频词 |

发音用浏览器原生 **Web Speech API**（`speechSynthesis`，en-GB），无需音频文件。

### 人物与题干一致性

两个模块顶部都有常驻切换标签 **`⛏️ Word Adventure` / `🎧 Phonics`**。

角色栏共 5 个牛津树形象：**Biff · Chip · Kipper · Wilma · Floppy（宠物狗）**。

出题时会读取句子里出现的人名（`charactersIn()`）：

| 句子 | 在 Biff 名下 | 在 Floppy 名下 |
|---|---|---|
| `This book is for you, said Biff.` | ✅ 本人台词，优先抽中 | ❌ 不出现 |
| `Floppy ran out of the garden.` | ❌ 不出现 | ✅ 本人台词，优先抽中 |
| `They walked across the old bridge.` | ✅ 旁白，兜底 | ✅ 旁白，兜底 |

- **绝不**把他人专属台词放进当前角色（`Biff 名下不会出现 Wilma 的句子`）
- 台词归属优先：同一规则内若有本人出场句，权重 ×3，尽量让角色"说自己说过的话"
- 过滤后若不足 4 条，自动回退全库，保证永远出得满 8 题

> 当前字库中 164 条句子：**56 条含人名、108 条为旁白**。Floppy 只有 4 句（`out / asleep / brown / dog`），
> 若想让宠物戏份更足，往词库 CSV 里补含 `Floppy` 的句子即可，无需改代码。


### 反馈闭环（核心）

```
出题（按薄弱项加权） → 答题 → 即时反馈 + 讲解 → 写回学情表 → 下一题更偏向薄弱项 → 学情页展示 + 靶向推荐
```

- **答错**：给出正确切分 / 音素对比 / 规则家族词，`phoneme_state.error_weight` **累加**
- **答对**：`error_weight` **回落**（秒答回落更多），形成正负双向调节
- **推荐**：按权重最高的字母组合，从当前字库中挑出全部含该组合的词（等价"诊断即推书"）
- **每轮 8 题**，固定覆盖 4 种题型各 2 次

### 新增 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/practice` | 特训页面 |
| GET | `/api/practice/next?level=G2&type=phoneme&player=biff` | 出题（type 可选，缺省随机） |
| POST | `/api/practice/answer` | `{player, card, response, response_ms}` → 判定 + 反馈 + 写回学情 |
| GET | `/api/practice/profile?player=biff` | 学情画像（薄弱音素 / 困难词 / 正确率） |
| GET | `/api/practice/recommend?level=G2&player=biff` | 靶向回流推荐 |
| GET | `/api/practice/reset?player=biff` | 清空该玩家学情 |

### 新增数据表

```sql
phoneme_state(player_id, phoneme, grapheme, error_weight, correct, wrong, last_seen)
word_state(player_id, word, error_count, correct, expected, actual, last_seen)
practice_events(id, player_id, card_type, word, focus, is_correct, response_ms, created_at)
```

> 原设计方案基于 Neo4j 知识图谱；本项目是 SQLite，故用上述关系表等价建模
> （`phoneme_state.error_weight` ≈ `STRUGGLES_WITH`，`practice_events` ≈ 事件流）。
> 出题只用**当前字库里的真实单词**，未引入外部词表。

### 音节切分准确率

内置启发式切分（元音组 + 辅音丛归属 + 词尾静音 e + C+le 规则）+ 常见不规则词覆盖表。
对 60 个常用牛津词汇实测 **60/60 = 100%**（见 `test_syllable.js` 口径）。

---

## API
- `GET /api/words?level=G1` - 随机获取10个单词
- `GET /api/stats` - 查看字库统计
- `POST /api/import` - 导入CSV字库
- `GET /api/dashboard` — 后台看板数据（`summary` / `recent` / `daily` / `practice`）
- `GET /api/dashboard/clear` — 清空 `game_logs` 与三张特训表

## 📊 后台数据看板

浏览器打开 **http://localhost:3000/dashboard**（同 `/admin`）。

| 区块 | 内容 | 数据源 |
|---|---|---|
| 📥 上传字库 CSV | 导入 `word,hint,sentence` | `words` |
| 🏆 角色总览 | 局数 / 总分 / 均分 / 最高连击 / 对错超时 | `game_logs` |
| 📅 每日统计 | 按天聚合 | `game_logs` |
| 📜 最近闯关 | 最近 50 局明细 | `game_logs` |
| 🎧 **Phonics 总览** | 总答题 / 正确率 / 平均用时 / 参与角色 | `practice_events` |
| 📊 **分题型统计** | 四类题型各自的题数、正确率（带进度条）、平均用时 | `practice_events` |
| 👤 **分角色（玩家）** | 每个 player 的题数、正确率、耗时、最后活动 | `practice_events` |
| 🎯 **薄弱音素 Top 20** | 音素 / 字母组合 / 错误权重 / 对错次数 | `phoneme_state` |
| 📕 **易错词 Top 20** | 错得最多的词 | `word_state` |
| 📜 **最近答题日志** | 最近 80 条逐题记录（题型 / 题目 / 考点 / 对错 / 用时） | `practice_events` |

`practice` 块字段：`total / correct / accuracy / avgMs / players / byType / byPlayer / daily / recent / weakPhonemes / troubleWords`。

## 📱 平板 / 响应式

针对 **iPad Chrome（iPadOS 走 WebKit）** 做了断点适配：

| 视口 | root 字号 | 容器宽度 |
|---|---|---|
| 手机 <768px | 16px（默认） | 全宽，沿用原紧凑规则 |
| **iPad 竖屏 768×1024** | **17px** | 940px（卡片 760px） |
| **iPad 横屏 1024×768** | **18px** | 1060px（卡片 840px） |

所有尺寸原本就是 `em` 相对单位，所以只放大 `html` 的 font-size 即可整体等比缩放。
另加 `-webkit-text-size-adjust:100%`（防 iOS 自动缩放）、`touch-action:manipulation`（去 300ms 点击延迟）。
横屏纵向吃紧时（`max-height:840px`）自动压缩间距。
词库/看板等宽表格在窄屏改为面板内横向滚动，不挤压列。

实测（CDP 模拟）：768 与 1024 两个宽度下均**无横向溢出**。

## 🚫 特训轮内去重（跨题型）

**曾经的真实 bug**：一轮 8 题里，同一个词会同时出现在「音素辨析（听音）」和「拼读规则（填空）」两个题型里。
实测 20 轮中有 **8 轮（40%）** 命中。

根因：去重键是 `题型|词`，同一个词换个题型就绕过去了；后来重构时这条去重甚至整个丢了。

**现在的做法**：前端维护 `roundWords`，每次请求下次题时用 `&exclude=w1,w2,…` 把本轮已考过的词带给后端，
`nextTask()` 发现生成的卡片命中 exclude 就重抽（最多 14 次）。

实测：**40 轮 × 8 题零重复**；不传 `exclude` 的对照实验里 12 轮有 6 轮重复，
证明去重确实由这条链路承担。静态版（`docs/phonics.html`）走同一套逻辑。

> 主游戏（`/api/challenges`）在服务端按词去重，不需要 exclude。

## 🧠 Agent A / C：语境脚手架 + HITL 证据溯源

### Spec A — 语境脚手架生成（Context-Aware Scaffolding）

`POST /api/agent/scaffold`

```json
{"player_id":"Tom","target_word":"fright","oxford_stage":3,
 "identified_phoneme_weakness":"/r/","error_context":"fright -> flight","character":"floppy"}
```

流程：**图谱事实 → 语料检索 → 受控提示 → 结构化输出**

```json
{"status":"success","scaffolding_type":"ort_context_hint","target_word":"fright",
 "grounded_sentence":"Floppy had a fright in the dark.",
 "grounded_from":{"character":"floppy","stage":2,"source":"seed","score":17.35},
 "pedagogical_hint":"floppy 在故事里遇到过这个词；这次是 fright，拆开字母是 f · r · igh · t；重点听 /r/ 这个音；刚才 fright -> flight 差了一个音。",
 "graph_facts":{"phonemes":["/f/","/r/","/aɪ/","/t/"],"graphemes":["f","r","igh","t"]},
 "retrieval":{"guard":"strict_vocab(913 words)"}}
```

**与原始 Spec 的两处偏离（必须知道）**

| Spec 假设 | 实际实现 |
|---|---|
| ChromaDB 稠密向量检索 | **确定性打分检索**：同词 8 分 / 共享拼读组合 ×2.5 / 同角色 +2 / 同首字母 +1 / stage 距离惩罚。零依赖、可复现。换向量库只需替换 `retrieve()` |
| 真实 ORT 绘本语料 | 语料由既有词库的 507 条句子种子化，**多数是工程生成的示范句，不是 ORT 原文**。`source` 字段如实标注 `seed` / `agent` / `imported` |

**严格词表守卫**：目标词不在词库（913 词）→ `rejected_by_guard`；检索只收 `oxford_stage <= 请求 stage`；
句子里的非人物名生词不进语料。人物名（Biff/Chip/Kipper/Wilma/Floppy/Mum/Dad/Gran…）视为专有名词放行。

**语料与角色绑定**：`corpus.character` 由句子中出现的人物自动标注，检索时同角色 +2 分。
当前分布：旁白 450 / Biff 15 / Kipper 14 / Chip 11 / Wilma 6 / Floppy 5 / Mum 3 / Dad 2 / Gran 1。

### Spec C — HITL 证据溯源与动态边生成

`GET /api/agent/discover?windowDays=30&threshold=0.85&create=1`

从 `session_events` 里真实答错的 (`target`, `typed`) 提取音素差异对，统计闸门：

```
confidence = 0.6 × min(1, freq/6) + 0.4 × min(1, users/4)
硬下限：freq ≥ 6 且 users ≥ 3
```

> 为什么不是"命中率"：我们没有"每次遇到该词都错"的分母，只有错误事件本身，
> 算命中率等于伪造分母。只用可观测的频次与受众广度，并让小样本自然被压低。

达门槛 → 生成 `PROP_YYYY_MMDD_NN` 提案（**不写生产图谱**），附最近 5 条真实错误片段。

```json
{"proposal_id":"PROP_2026_1023_01","edge_type":"CONFUSED_WITH",
 "source":"Phoneme_r","target":"Phoneme_l","confidence":0.74,"status":"pending_review",
 "grounding_evidence":[{"player":"demo_kid_1","target_word":"right","user_input":"light"}],
 "action_endpoints":{"approve":"/api/proposals/approve?id=...","reject":"/api/proposals/reject?id=..."}}
```

### HITL 审阅台

**http://localhost:3000/portal**（需要后端，不能上静态 Pages）

- 待审提案卡片：边/语料、置信度、证据链、通过/拒绝
- 「运行发现」：可调时间窗与门槛，实时看候选与闸门结果
- 「新增语料」：提交即进待审队列，**通过后才会进语料库**
- 已生效混淆边表

审批语义：
- `graph_edge` 通过 → 写入 `phoneme_edge`（带 `proposal_id` 溯源）
- `corpus_sentence` 通过 → 再过一次词表守卫 → 写入 `corpus`
- 拒绝 → 只改状态，无副作用
- 重复审批 → 拒绝（`该提案已是 approved`）

### 数据表

| 表 | 用途 |
|---|---|
| `corpus` | 语料库（sentence/word/stage/character/source/status） |
| `proposals` | HITL 待审提案（kind/payload/confidence/evidence/status） |
| `phoneme_edge` | 审议通过的混淆边（source/target/confidence/proposal_id） |

## 🛠️ 线上后台（静态快照）

**https://jackeywing.github.io/oxford-word-knight/dashboard.html**

Pages 没有后端，所以构建时 `build-pages.js` 会临时拉起后端（:3999）抓一份真实数据，
把 `/api/dashboard`、`/api/access-log`、`/api/session-events`、`/api/stats` 四个响应内嵌进页面 ——
**保证与本地口径完全一致**，只是数据冻结在构建时刻。

页面顶部有橙色横幅说明：快照不可实时刷新、不能上传/清空。
需要实时数据请用本地 `http://localhost:3000/dashboard`。

### 所有日志表都带来源 IP

| 表 | IP 列 |
|---|---|
| 角色总览 | `📍 来源 IP` 第一列 |
| 每日统计 | `📍 来源 IP` 第二列 |
| 最近闯关 | `📍 来源 IP` 第二列 |
| 最近答题日志（特训） | `📍 来源 IP` 第二列 |
| 访问日志 | 有 |
| 会话事件流 | 有 |

`practice_events` 也补了 `ip` 列（`POST /api/practice/answer` 写入 `clientIp(req)`），
所以特训答题日志现在也能追溯到来源 IP。旧记录没有 IP，显示 `—`。

## 🔒 角色锁定

一轮进行中不允许中途换人：

- 点其他角色 → 弹确认「角色已锁定 —— 切换角色会重新开始本轮，确定吗？」
- 取消 → 什么都不变，继续当前这轮
- 确认 → 角色切换 + 本轮重置回起始页（特训页还会清空 `roundWords`）
- 点当前角色 → 无反应（不弹确认）

主游戏与特训页行为一致（`playing` 标记：开局置 true，结算/重置置 false）。

## 🧭 会话事件流（按 IP + session）

看板最上方第一张表已改为 **`📍 来源 IP` 第一列、`角色` 第二列**（`GROUP BY ip, character_name, level`）。

`game_logs` 新增 `ip` / `sid` 两列，每次结算都会带上来源 IP 与 session id。

### 记录的事件

前端在 `sessionStorage` 生成一个 `owk_sid`，每个动作 `POST /api/track`，服务端按 `IP + sid` 归组：

| 事件 | 触发点 | detail |
|---|---|---|
| `visit` | 进入页面 | level / page |
| `character_switch` | 点角色头像 | `{from, to}` |
| `round_start` | 点开始 | count / character |
| `answer_wrong` | 答错（**不推进，清空输入可重试**） | `{word, attempt, typed}` |
| `answer_ok` | 答对 | `{word, retries, left}` |
| `flash_replay` | 视觉词回看 | word |
| `round_finish` | 一轮结束 | score / correct / total |
| `round_restart` | 重玩 | — |

看板新增「🧭 会话事件流」区：事件总数 / 会话数 / 独立 IP / 事件类型，每个 session 一行
（IP、session 前缀、**角色切换链 `Biff → Chip → Wilma`**、事件数、起止时间、做过哪些事），
另有来源 IP 汇总与事件类型统计。

接口：`POST /api/track`、`GET /api/session-events?limit=200`（含 `sessions` / `timelines` / `byKind` / `byIp`）。

> 说明：主游戏的「答错」不推进题目，输入框清空后可重试——所以 `answer_wrong` 会带 `attempt: 1,2,3…`，
> 这正好就是"失败重试"的记录。旧的 `game_logs` 记录没有 IP，会显示为 `—`。

## 🌐 访问日志

`/dashboard` 新增「访问日志」区块，记录每次访问与来源 IP。

- 数据表 `access_log`：`ts / ip / method / path / status / ua / referer / ms`
- IP 取值顺序：`X-Forwarded-For` 第一段 → socket 远端地址（`::ffff:`、`::1` 已归一化）
- 静态资源（css/js/图片/字体）不记录，避免噪音
- 自动保留最近 **90 天**，启动时清理过期记录
- 展示：总访问 / 独立 IP / 今日访问 / 记录天数，来源 IP 汇总、每日访问、热门路径、最近 200 条明细
- 接口：`GET /api/access-log?limit=200`、`GET /api/access-log/clear`

> 本机访问的 IP 永远是 `127.0.0.1`——要有真实访客 IP，必须把后端部署到公网（或走隧道）。

## 🗂️ 词库浏览（`/lexicon`）

浏览器打开 **http://localhost:3000/lexicon**，用于核对题库真实内容：

- **总览磁贴**：总行数 / 唯一单词 / 重复冗余 / 短语数 / 平均词长 / 有例句数 / 含人物名数
- **分布**：级别、音节数直方图、首字母直方图
- **检索**：按单词/提示/句子搜索，可按级别、类型（单词/短语/重复）筛选与排序
- **词条表**：单词 / 级别 / 音节 / 字母数 / 音素组合 / 中文提示 / 所在句
- **重复告警**：若有重复词条会红字标出（正常应为 0）

接口：`GET /api/lexicon` → `{ stats, words }`。

### 词库现状（实测）

| 指标 | 值 |
|---|---|
| 唯一词 | **912**（含人工录入的生词） |
| 级别 | G1 **492** · G2 **420** |
| stage 分布 | S1 **177** · S2 **291** · S3 **284** · S4 **160** |
| 有例句 | 505 / 912 = **55%**（其余用中文提示做填空） |
| 音节分布 | 1 音节 557 · 2 音节 278 · 3 音节 72 · 4 音节 4 |
| 平均词长 | 5.1 |
| 含空格短语 | 10（`more than` / `each one` / `too … to` …，仅主游戏可用，特训题库自动排除） |
| 含人物名句子 | 57（biff/kipper/chip/wilma/floppy/mum/dad/gran） |
| 重复词 | **0** |

### 词库来源与可信度

| 来源 | 内容 | 说明 |
|---|---|---|
| `g2-words.csv` / `sample-words.csv` | 项目原有 164 行 | 带牛津树风格例句；`sample-words.csv` 的句子是**已挖空**格式，导入时自动把词填回 |
| `data/core-sight.csv` | Dolch 220 / Fry 常用词 | 公开通用高频词表 —— **不是**牛津树官方词表 |
| `data/core-nouns.csv` | 具象名词（家具/动物/食物/场景） | 唯一允许套模板生成例句的一类 |
| `data/core-phonics.csv` | 拼读家族（ight/ake/ee/oa/ai/ou/ow/sh/ch/th/ar/or）+ 形容词动词 | |
| `data/core-extra.csv` | 常用动词/名词/形容词补全 | |
| `data/sentences.csv` | 117 条手写例句 | 优先级低于原有词库的真实句子 |
| `user_words` 表 | 人工录入的高权重生词 | 见下节 |

> **stage 的含义**：按词频与拼读难度划分的阅读阶梯（1 最基础 → 4 内容词），
> **不是**牛津树官方的 Stage 编号。牛津树官方为 **800+ 本书、12+ 个 Stage**，
> 本项目词库是覆盖高频核心的**重建**，不是官方 Stage 词表的逐级照搬。

```bash
node backend/import-words.js --dry    # 看去重差异，不写库
node backend/build-lexicon.js --dry   # 看合并/去重/例句生成结果，不写库
node backend/build-lexicon.js         # 重建词库（合并 → 还原挖空 → 补例句 → 写库 + words-merged.csv）
node backend/test/dedup.test.js       # 200 轮 × 10 题，断言轮内无重复 + 规模 ≥800
```

**例句生成纪律**（避免教错）：
- 原有词库的真实句子 > `data/sentences.csv` 手写句 > 具象名词模板
- **动词、副词、抽象名词、虚词一律不套模板** —— 模板必然写出 `She likes to open.` / `Do you worry it?` 这类病句
- 所有例句都必须包含该词本身，否则克漏字挖不到空，自动退化为中文提示填空

### ⚖️ 图谱权重（`/lexicon` 的「权重」列）

权重来自知识图谱里的**关系边**，不是随便打的分数。当前有数据支撑的边：

| 关系边 | 属性 | 落库位置 |
|---|---|---|
| `Player -[struggles_with]-> Phoneme` | `error_weight` | `phoneme_state` |
| `Player -[struggles_with]-> PhonicsRule` | `fail_count` | 由音素边按 `grapheme` 聚合 |
| `Player -[NEEDS_PRACTICE]-> Word` | `error_count` | `word_state` |
| `User -[MANUAL_PRIORITY]-> Word` | `weight` | `user_words`（单独显示 ★） |

节点路径是 `Word -COMPOSED_OF-> Syllable -COMPOSED_OF-> Phoneme`，所以**词权重由它包含的音素边推出**：

```
实测权重 = Σ_全部玩家 [ 该词音素组合的 error_weight 之和 + 错词次数 × 2 ]
```

按你的选择：**全部玩家加总**，得到一个全局权重。

#### 三态依据（避免"没考过的词假装被测过"）

| 依据 | 含义 | 当前 |
|---|---|---|
| 🔴 **直连** | 这个词**本身**被考过（`NEEDS_PRACTICE` 边存在） | 17 词 |
| 🟠 **传播** | 词本身没考过，但含玩家薄弱音素（经 `COMPOSED_OF → struggles_with` 传播） | 467 词 |
| ⚪ **估算** | 完全没有数据，用理论权重兜底 | 428 词 |

#### 理论权重（兜底，界面标「估算」）

```
估算 = 1 + (词长-3)×0.25 + (音节数-1)×0.8 + 多字母组合数×0.4 + (4-stage)×0.3
```

系数集中在 `backend/lexicon-weight.js` 的 `EST` 对象里，可直接调。

> 实测最高：`everything` **16.4**（biff + floppy 的音素边 10.4 + 词边 3 次）
> 估算均值 2.41；`write` 因含 `/r/` 弱项以「传播」得 1.3

页面支持：按权重排序（默认）、按依据筛选（直连 / 传播 / 估算）、「权重」列带依据徽标。
静态版（Pages）在构建时从数据库读一次边并内嵌，与本地口径一致。

#### 权重计算规则与取值范围（实测数据）

**实测路径**（有答题历史时）：

```
图谱权重 = Σ_全部玩家 [ Σ_该词音素组合的 error_weight + 错词次数 × 2 ]
```

| 参数 | 来源 | 取值范围 | 变化方式 |
|---|---|---|---|
| `error_weight` | `phoneme_state` | **0.1 ~ 7.9**（当前最高 biff 的 /iː/） | 答错 +1.2 / +1.6，答对 −0.3（犹豫）或 −0.7（秒答），下限 0 |
| `error_count` | `word_state` | **1 ~ 3**（整数） | 每错一次 +1 |
| 词级边系数 | `WORD_EDGE_FACTOR` | **2** | 错 1 次 ≈ 2 个音素权重单位 |

**理论路径**（无任何历史时兜底，界面标「估算」）：

```
估算 = 1 + (词长−3)×0.25 + (音节数−1)×0.8 + 多字母组合数×0.4 + (4−stage)×0.3
```

| 参数 | 系数 | 当前数据范围 | 该项贡献 |
|---|---|---|---|
| 基准值 `base` | 1 | — | 固定 1 |
| 词长 `perLetter` | 0.25 | 1 ~ 14 字母 | 0 ~ 2.75 |
| 音节 `perSyllable` | 0.8 | 1 ~ 5 音节 | 0 ~ 3.2 |
| 拼读组合 `perGrapheme` | 0.4 | 0 ~ 5 个 | 0 ~ 2.0 |
| 分级 `perStageGap` | 0.3 | stage 1 ~ 4 | 0.9 ~ 0 |

**实际值域**（912 词）：理论估算 **1 ~ 7.35**（均值 2.95）、实测 **0.1 ~ 16.4**（均值 2.66）。
系数全部集中在 `backend/lexicon-weight.js` 的 `EST` / `WORD_EDGE_FACTOR`，改这里即可调参。

#### 线上版（Pages）如何影响出题 —— localStorage 方案

Pages 是静态托管，没有服务器可写。**成本最低且真能生效**的做法：三个页面同源
（都在 `jackeywing.github.io`），共享 `localStorage['owk_user_words']`。

| 页面 | 写入 | 读取 |
|---|---|---|
| `lexicon.html` | 逐词手动权重 → `localStorage` | — |
| `index.html`（单词冒险） | — | 抽题时优先插入，**跨级别**生效 |
| `phonics.html`（音素特训） | — | 音节题加权 + 拼读题目标词偏向 |

实测（给 `dragon` 设 ★5）：

```
单词冒险：3/3 轮都出现在第一题
音素特训：6 个音节题里 4 个是 dragon（67%）
```

**限制**：只在**当前浏览器**生效，换设备/换浏览器/清缓存即失效；
音素辨析、视觉词闪现两类题有固定题库（最小对立组 / Dolch 表），普通生词进不去。
要全局生效（所有设备）仍需接一个后端或重新构建推送。

#### ⚠️ 哪个后台才真正影响出题

| 后台 | 影响本地出题 | 影响线上出题 |
|---|---|---|
| **`http://localhost:3000/lexicon`**（本地 Node 后台） | ✅ 是 | ❌ 否 |
| `https://jackeywing.github.io/.../lexicon.html`（Pages 静态页） | ❌ 否 | ❌ 否 |

**线上出题在构建时就写死了**（词库与权重内嵌进 `docs/*.html`），任何后台操作都不会改变线上题目。
要改线上出题，必须 `node build-pages.js` 重新构建 + `git push` 让 Pages 重新发布。

本地后台之所以生效，是因为 `/api/challenges` 会读 `user_words` 表。

#### 逐词手动权重

本地 `/lexicon` 词条表新增「手动★」列，每行一个输入框：

- 填 **1–5** → 该词进入优先池，每轮答题最多占 40%，权重高的优先
- 填 **0** 或清空 → 取消手动加权
- **不受 level 限制**：给 G1 的词加权，玩 G2 时也会出现（早期版本会被 level 过滤掉，已修）

### ⭐ 我的重点生词（`/lexicon` 页面手动录入）

在词库浏览页顶部可录入想重点练的生词：单词 / 中文提示 / 例句 / 权重（★1–★5）。

- 录入后自动同步进主词库，并进入抽题池
- **权重越高越优先**：每轮答题中高权重生词最多占 **40%**，按权重降序优先占位
- 主词条表里会显示 `★N` 标记，便于核对
- 接口：`GET /api/user-words` · `POST /api/user-words` · `POST /api/user-words/delete`

当词库重建（`build-lexicon.js`）时，服务启动会自动把 `user_words` 补回 `words` 表，
人工生词不会因为重建而丢失。

## 🚀 GitHub Pages 静态版

```bash
npm run pages     # 重新生成 docs/phonics.html（内嵌引擎 + 164 词 + localStorage）
```

- `docs/index.html` — 单词冒险（164 词，含人物台词过滤）
- `docs/phonics.html` — 音素特训（纯前端，零后端依赖，构建带语法自检）

## 项目结构
```
oxford-word-knight/
├── backend/
│   ├── server.js       # Node.js 后端
│   └── practice.js     # 音素/音节特训引擎
├── frontend/
│   ├── index.html      # 游戏前端
│   └── practice.html   # 音素·音节特训
├── sample-words.csv    # 示例字库
└── package.json
```

## 依赖
- Node.js v18+（已在 v26 验证）
- better-sqlite3 `^13` (SQLite数据库) — *v11 无法在 Node 26 编译，已升级*
- csv-parse (CSV解析)

> ⚠️ 后台看板依赖 Node + SQLite，**GitHub Pages 静态版没有**（静态版学情存在浏览器 localStorage，可用特训页的「📈 我的学情」查看本人数据）。
