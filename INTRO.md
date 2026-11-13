# 词忆 · CiYi

> **一个完全离线的移动端英语单词记忆应用。**
> A fully offline mobile app for English vocabulary memorization.

---

## 一句话简介 / One-liner

**中文**：导入你的 Word 单词表，自动核对释义、规划进度、按遗忘曲线复习——全程不需要联网。

**English**: Import your Word vocabulary list — CiYi verifies the definitions, plans your pace, and schedules reviews by forgetting curve. No network required.

**GitHub 仓库简介 / Repo description**：
`离线英语单词记忆 App｜Word 导入 · 词典核对 · 学习计划 · SM-2 复习 · 307 项自动化测试`
`Offline English vocabulary app — Word import, dictionary verification, study plans, SM-2 spaced repetition, 307 automated tests`

---

## 完整介绍 / Full Introduction

### 中文

词忆是一个完全离线的移动端背单词应用，解决的是"自己的单词表没法好好背"这个具体问题。

导入你现有的 Word 文档（.docx）或直接粘贴文本，App 会自动识别英文单词、词性、音标和中文释义——不管你的表格是两列、三列还是四列，列的顺序是怎么排的，它都能自己判断。然后它用内置的 58,226 词条离线英汉词典逐个核对翻译是否准确。

核对不是简单的字符串比对。一个词在词典里往往有七八个义项，你只写其中一个是**对的**，不该被判成错误；而中文同义改写（"实现"和"完成"）也不该被误报。所以判定分成五档：**正确 / 基本正确但不完整 / 可能存在错误 / 确认错误 / 无法确认**。拿不准的时候它说拿不准，不硬给结论。原始释义永远不会被自动覆盖，必须你确认才生效。

定好节奏——每天背多少词、要不要拼写题——按下"开始学习计划"一次，之后每天打开 App 当天的任务就已经排好了，不用再点。答错的词当天会被重新排队强化，答对的词进入 SM-2 间隔重复：1 天 → 3 天 → 7 天 → 按难度系数递增。当天重复做对的题**不会**被算作长期记忆成功——否则今天错三次、第三次蒙对，就会被错误地推到一周后。

所有数据存在本机的 SQLite 数据库里，学习过程完全不需要网络。

### English

CiYi is a fully offline mobile vocabulary app. It solves one concrete problem: your own word lists are hard to actually study.

Import your existing Word document (.docx) or paste text directly. The app automatically detects the English word, part of speech, phonetic transcription and Chinese definition — regardless of whether your table has two columns, three, or four, and regardless of column order. It then verifies each translation against a built-in 58,226-entry offline English–Chinese dictionary.

Verification is not naive string comparison. A word typically has seven or eight senses in a dictionary; writing only one of them is **correct**, and should not be flagged as an error. Chinese synonym rewording ("实现" vs "完成") must not trigger false alarms either. So results are graded in five levels: **correct / basically correct but incomplete / possibly wrong / confirmed wrong / cannot verify**. When it can't be sure, it says so instead of guessing. The original definition is never overwritten without your explicit confirmation.

Set your pace — words per day, spelling questions on or off — and tap "Start Study Plan" once. From then on, each day's tasks are already scheduled when you open the app. Missed words are requeued for same-day reinforcement; correct ones enter an SM-2 spaced-repetition schedule: 1 day → 3 days → 7 days → scaled by difficulty factor. Crucially, repeating a correct answer *within the same day* does **not** count as long-term success — otherwise failing three times and guessing right on the third attempt would wrongly push the word out a week.

Everything lives in a local SQLite database. Studying never requires a network connection.

---

## 基于什么 / Built Upon

这里逐条说明白：哪些是别人做好的基础，哪些是本项目写的。

### 中文

| 环节 | 基于什么 | 说明 |
|---|---|---|
| **词典数据** | [ECDICT](https://github.com/skywind3000/ECDICT)（MIT 开源英汉词典） | 原库 77 万词条。本项目按"常用度"筛选（有考试标签 / 柯林斯星级 / 牛津核心 / 词频排名任一满足），抽出 **58,226 条**编成子集，去掉 `[网络]`、`[医]` 这类次要标注，从中文释义里反推词性 |
| **中文近义词表** | 从 ECDICT 自身的英汉对应关系推导 | 不是手工编的，也不是调外部服务。做法：若两个中文义项被多个相同的英文词共用（比如 `accomplish` 同时译作「完成」和「实现」），就判定为近义。共现 ≥2 次的保留，得到 **49,658 个义项**的近义关系 |
| **间隔重复算法** | **SM-2**（SuperMemo 2，1987 年 Piotr Woźniak 提出） | 保留了核心的 ease factor 与间隔倍增机制，但做了三处工程化调整：① 初始 ease 2.3、范围钳制在 1.3~2.6；② 间隔序列固定为 1→3→7→×ease，上限 365 天；③ **区分短期强化与长期复习**——当天重复答对不推进长期间隔 |
| **本地数据库** | **SQLite**，通过 [sql.js](https://github.com/sql-js/sql.js) 1.13 编译成 WebAssembly | 是真的 SQLite 引擎，不是模拟的 ORM 或 JSON 存储。**10 张业务表、14 个索引**，外键、事务、部分唯一索引都用上了 |
| **翻译核对** | 自研的**义项匹配 + 近义词扩展**算法 | **不依赖任何大模型或翻译 API**。先用字符有效重叠做初筛，再用近义词表处理同义改写，最后按匹配率与覆盖率分档。纯确定性算法，同样的输入永远得到同样的结果 |
| **在线补充** | [dictionaryapi.dev](https://dictionaryapi.dev/) 公开接口 | 免费、无需密钥，提供英文释义、音标、例句。**可在设置中关闭**，关掉后核对仍能离线完成 |
| **Word 文档解析** | **OOXML** 标准（.docx 本质是 zip + `word/document.xml`） | 用 fflate 解压，直接正则扫描 XML 的表格/行/单元格/段落结构，自己判断每列是什么。不用任何 Word 解析库 |
| **解压** | [fflate](https://github.com/101arrowz/fflate) 0.8.2 | zip 与 gzip |
| **界面** | 原生 **HTML + CSS + ES Modules** | **没有用任何前端框架**（无 React / Vue / 构建工具）。纯静态文件，改完刷新即生效 |
| **Android 宿主** | **系统 WebView** + 手工构建流水线 | 页面通过 `shouldInterceptRequest` 从 APK 内 assets 读取，不产生真实网络流量。构建走 `aapt2 → javac → d8 → zipalign → apksigner`，**不用 Gradle**（本机 maven.google.com 不可达） |
| **iOS 宿主** | **WKWebView + WKURLSchemeHandler** | 自定义 `ciyi://` scheme 映射到 app bundle，做法参考 Capacitor。用自定义 scheme 而非 `file://`，是因为后者下 IndexedDB 不可靠，而本项目的数据库就存在 IndexedDB 里。工程用 XcodeGen 生成，不手写 pbxproj |
| **测试** | 自研轻量断言 + Node 内置能力 | 没有引入 Jest / Vitest。UI 端到端测试在一个约 400 行的测试文件里（含自写的 DOM 垫片），于 Node 中真实执行 `web/app.js` |

**一句话概括**：词典数据和记忆算法站在前人的肩膀上（ECDICT + SM-2），其余——导入解析、翻译核对、任务调度、界面、两套宿主——都是本项目自己写的。

### English

| Component | Built upon | Notes |
|---|---|---|
| **Dictionary data** | [ECDICT](https://github.com/skywind3000/ECDICT) (MIT-licensed EN–ZH dictionary) | The upstream has ~770k entries. This project filters by "commonness" (exam tags / Collins stars / Oxford core / frequency rank) down to **58,226 entries**, strips secondary labels, and derives part-of-speech from the Chinese definitions |
| **Chinese synonym table** | Derived from ECDICT's own EN–ZH mappings | Not hand-authored, not an external service. If two Chinese senses are shared by several of the same English words (e.g. `accomplish` translates to both 「完成」 and 「实现」), they are treated as synonyms. Pairs co-occurring ≥2 times are kept — **49,658 senses** in total |
| **Spaced repetition** | **SM-2** (SuperMemo 2, Piotr Woźniak, 1987) | Keeps the core ease factor and interval-multiplication mechanism, with three engineering adjustments: ① initial ease 2.3, clamped to 1.3–2.6; ② interval sequence fixed at 1→3→7→×ease, capped at 365 days; ③ **short-term reinforcement is separated from long-term review** — repeating a correct answer on the same day does not advance the long-term interval |
| **Local database** | **SQLite** compiled to WebAssembly via [sql.js](https://github.com/sql-js/sql.js) 1.13 | A real SQLite engine, not a simulated ORM or a JSON store. **10 business tables and 14 indexes**; foreign keys, transactions and partial unique indexes are all in use |
| **Translation verification** | A purpose-built **sense-matching + synonym-expansion** algorithm | **No LLM and no translation API involved.** Effective-character overlap as a first pass, a synonym table to absorb rewording, then grading by match and coverage ratios. Fully deterministic — the same input always yields the same verdict |
| **Online enrichment** | The public [dictionaryapi.dev](https://dictionaryapi.dev/) endpoint | Free, no API key; supplies English definitions, phonetics and examples. **Can be switched off in settings** — verification still completes offline |
| **Word parsing** | The **OOXML** standard (.docx is a zip containing `word/document.xml`) | Unzipped with fflate, then a regex scan extracts table / row / cell / paragraph structure; column roles are inferred from content statistics. No Word-parsing library used |
| **Decompression** | [fflate](https://github.com/101arrowz/fflate) 0.8.2 | zip and gzip |
| **UI** | Plain **HTML + CSS + ES Modules** | **No frontend framework** (no React / Vue / bundler). Pure static files; edit and refresh |
| **Android host** | **System WebView** + manual build pipeline | Pages are served from APK assets via `shouldInterceptRequest`, generating zero real network traffic. Built with `aapt2 → javac → d8 → zipalign → apksigner`, **no Gradle** (maven.google.com is unreachable here) |
| **iOS host** | **WKWebView + WKURLSchemeHandler** | A custom `ciyi://` scheme mapped to the app bundle, following Capacitor's approach. A custom scheme rather than `file://` because IndexedDB is unreliable under the latter — and the app's database lives in IndexedDB. The Xcode project is generated by XcodeGen rather than hand-written pbxproj |
| **Testing** | A small self-contained assertion library on top of Node | No Jest / Vitest. The end-to-end UI test runs the real `web/app.js` inside Node against a ~400-line test file that includes a hand-written DOM shim |

**In one sentence**: the dictionary data and the memory algorithm stand on prior work (ECDICT + SM-2); everything else — import parsing, translation verification, task scheduling, the UI, and both native hosts — is written for this project.

---

## 核心特性 / Key Features

| 中文 | English |
|---|---|
| **Word / 粘贴导入**，自动识别列角色与表头，支持 2~4 列表格和纯段落 | **Word / paste import** with automatic column-role and header detection; supports 2–4 column tables and plain paragraphs |
| **去重合并**：同一单词的不同义项与词性求并集，重复导入保留原有学习记录 | **Deduplication**: unions multiple senses and parts of speech; re-importing preserves existing study records |
| **翻译核对**：A–E 五档判定 + 中文近义词表，原始释义永不自动覆盖 | **Translation verification**: five-level grading with a Chinese synonym table; the original is never auto-overwritten |
| **学习计划**：设定每天词数，实时估算需要多少天、哪天背完 | **Study plan**: set words per day, see live estimate of total days and finish date |
| **每日自动排任务**：开始计划后不用每天再点，未完成的自动继承 | **Automatic daily scheduling**: tap once to start; unfinished words carry over |
| **错词当天强化**：重新排队、最多 3 次、不会立刻重考 | **Same-day reinforcement** for missed words: requeued, max 3 times, never immediately repeated |
| **SM-2 间隔重复**：1→3→7→×ease，当天重复不污染长期间隔 | **SM-2 spaced repetition**: 1→3→7→×ease, with same-day repeats kept separate from long-term intervals |
| **四种题型**：看英文选中文 / 看中文选英文 / 看中文拼英文 / 看英文选释义，拼写模式可开关 | **Four question types** with a toggleable spelling mode |
| **纯离线**：58,226 词条内置词典，学习全程不联网 | **Fully offline**: 58,226-entry built-in dictionary; studying needs no network |
| **真实统计**：记忆状态分布、正确率、近 14 天趋势，全部实时从数据库计算 | **Real statistics**: memory-state distribution, accuracy, 14-day trend, all computed live from the database |

---

## 技术栈 / Tech Stack

| 层次 | 技术 |
|---|---|
| **界面 / UI** | 原生 HTML + CSS + ES Modules，移动端优先，浅色/深色主题 |
| **本地数据库 / Database** | SQLite 编译成 WebAssembly（sql.js 1.13），10 张业务表、14 个索引 |
| **离线词典 / Dictionary** | [ECDICT](https://github.com/skywind3000/ECDICT)（MIT）子集，58,226 词条 |
| **近义词表 / Synonyms** | 从 ECDICT 共现关系推导，49,658 个义项 |
| **在线补充 / Online** | [dictionaryapi.dev](https://dictionaryapi.dev/)（免费、无需密钥，可在设置中关闭） |
| **解压 / Unzip** | fflate 0.8.2 |
| **Android** | 原生 WebView 壳，`aapt2 → javac → d8 → zipalign → apksigner` 手工流水线（不用 Gradle） |
| **iOS** | WKWebView + `WKURLSchemeHandler`，XcodeGen 工程，GitHub Actions 产出未签名 ipa |

---

## 项目规模 / Project Scale

| 项目 | 数值 |
|---|---|
| 核心逻辑 / Core logic | `core/` 12 个模块，约 97 KB |
| 界面 / UI | `web/` 约 71 KB |
| 自动化测试 / Automated tests | **307 项**（核心 235 + UI 端到端 51 + 在线词典 21） |
| 离线词典 / Offline dictionary | 58,226 词条，1.51 MB（gzip） |
| Android APK | 2.60 MB |
| 构建产物静态校验 / Static verification | APK 41 项、iOS 70 项 |

---

## 平台支持 / Platform Support

| 平台 | 状态 |
|---|---|
| **浏览器（推荐先试）** | ✅ 运行 `python serve.py`，打开 `http://127.0.0.1:8899/index.html` |
| **Android** | ✅ `android/build/词忆.apk`（2.60 MB，已签名，minSdk 26） |
| **iOS** | ⚠️ 完整工程已就绪，需在 macOS 上编译（仓库内附 GitHub Actions 流水线可产出未签名 ipa） |

---

## 设计上的几个取舍 / Design Notes

**核对宁可保守。** 字符重叠判断不出"实现"和"完成"是同义的，所以从 ECDICT 自身的英汉对应关系反推出近义词表。判定拿不准时返回"无法确认"，而不是硬给一个错误的结论。

**短期与长期必须分离。** 当天重复答对只算短期强化，不推进长期间隔。这是间隔重复算法最容易被做错的地方。

**没有释义的词不进任务。** 一个没有中文释义的词，出题时只会得到一道没有答案、只有一个空选项的废题。所以在出题、排任务两层都做了拦截。

**原始释义不可变。** 库里同时保存 `original_translation` / `suggested_translation` / `confirmed_translation` 三份，自动核对只写 suggested，只有用户确认才写 confirmed。

---

## 许可 / License

代码部分自行使用。词典数据来自 [ECDICT](https://github.com/skywind3000/ECDICT)（MIT License）；在线查询使用 [dictionaryapi.dev](https://dictionaryapi.dev/) 的公开接口。
