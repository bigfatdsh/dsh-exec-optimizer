/**
 * 任务轻重判定：一段用户文本 → 一个**轻重组**（bucket）。
 *
 * ## 为什么是规则，不是模型
 *
 * 让模型自己判"该想多久"要额外发一次请求：多一跳、多一份 token、还可能失败。规则表
 * 是纯函数，判定以微秒计，所以可以在**每个** turn 起点无脑跑一次。
 *
 * ## 为什么只输出四个组
 *
 * 组是**跨模型**的概念；落到哪个档位由 `efforts.js` 按该模型真实支持的档位决定。
 * 分得越细误判越多，而相邻档位的实际差异很小。
 *
 * 判不出"重"就判"轻"是刻意的：轻活多想一点，比重活想得太少安全得多。
 *
 * @module dsh-exec-optimizer/classify
 */

/** 轻重组，从省到费。 */
export const BUCKETS = ['quiet', 'light', 'standard', 'heavy']

/** 只看前 8000 字符：更长的消息自带"重"信号，细节对判定没有额外价值。 */
const SCAN_LIMIT = 8000

/**
 * 信号表。`weight` 累加成分数；`action` 表示"要动手"，`read` 表示"要读东西"——
 * 两者都让最省档停在「轻」，因为省掉的是思考，不是正确性。
 */
export const SIGNALS = [
  // --- 纯客套：整句都是客套且很短，命中即最省档 ---
  // 「什么是事件循环」不是客套，「ok 帮我改」也不是。
  {
    id: 'chatter',
    exclusive: true,
    maxChars: 8,
    weight: 0,
    pattern: /^(?:hi|hey|hello|yo|你好|您好|早上好|下午好|晚上好|嗨|哈喽|哈啰|在吗|谢谢|多谢|感谢|辛苦|好的|好嘞|收到|明白|了解|okay|thanks|thank you|thx|嗯+)[\s!！。.~～?？,，]*$/i,
  },

  // --- 提问：只认句首疑问词、句尾语气词，或真正的疑问标点 ---
  {
    id: 'ask',
    weight: 2,
    pattern: /^(?:是什么|什么是|为什么|为何|如何|怎么理解|which|what|how|why|when|who)\b|[什么谁哪如何]|[\s?？。！!]*[吗呢]\s*$|\?|？/i,
  },

  // --- 要动手的活 ---
  {
    id: 'imperative',
    weight: 2,
    action: true,
    pattern: /(帮我|请帮|帮忙|替我|麻烦|给我(?:写|做|改|查|找|跑|看|生成|整理|翻)|写一个|做一个|搞一个|实现|开发|搭建|部署|安装|配置|改造|重构|修复|修一下|调试|排查|查一下|查查|搜一下|搜索|下载|导出|导入|转换|翻译|整理|汇总|统计|计算|跑一下|运行|执行|测试|生成|创建|新建)/i,
  },
  {
    id: 'transform',
    weight: 3,
    action: true,
    pattern: /(转成|转为|转换成|改成|换成|拆成|分成|整理成|合并成|存到|放到|移到|挪到|导出到|导入到|删掉|删除掉|重命名|改名|写进|贴进|填进|打印出来|读出来)/i,
  },
  {
    id: 'disposal',
    weight: 1,
    action: true,
    pattern: /把[^\s，,。;；]{0,24}(?:转|改|换|拆|分|合并|删|加|写|存|放|移|挪|导|填|贴|打印|读|重命名|优化|修)/,
  },
  {
    id: 'bare-verb',
    weight: 1,
    pattern: /(加|删|改|换|拆|补|移|挪|复制|回滚|重试|重命名|优化|简化|拆分|接上|降级|限流|加锁)/,
  },

  // --- 要读/要看 ---
  {
    id: 'read',
    weight: 1,
    read: true,
    pattern: /(看看|看一下|看下|读一下|打开|查看|检查|审查|review|过一遍|列一下|列出来|总结|摘要|翻译|解释|说明|介绍|科普)/i,
  },

  // --- 出问题了 ---
  {
    id: 'problem',
    weight: 3,
    pattern: /(bug|报错|错误|崩溃|失败|异常|不生效|没反应|不工作|坏了|卡住|超时|泄漏|死循环|regression|crash|error|exception|fails?|broken|stuck|leak)/i,
  },

  // --- 大工程：一条就够「重」 ---
  {
    id: 'project',
    weight: 6,
    action: true,
    pattern: /(架构|设计一套|整套|全流程|端到端|从零|重写|大改|迁移|重构整个|系统性|方案设计|可行性|技术选型|性能瓶颈|安全审计|深度分析|多阶段|分阶段)/i,
  },

  // --- 需要权衡的判断 ---
  {
    id: 'decide',
    weight: 1,
    pattern: /(要不要|该不该|行不行|可以吗|好不好|是否(?:要|需要|应该)|值得(?:吗|么)|有必要|如何选择|选哪个|利弊|优缺点|trade-?off)/i,
  },

  // --- 有锚点的具体活 ---
  { id: 'path', weight: 1, pattern: /(?:^|[\s"'`(])(?:[~./]|\/)[\w./~-]{2,}|\.(?:js|mjs|cjs|ts|tsx|jsx|json|ya?ml|md|py|css|html|sh|toml|sql|rs|go|java)\b/i },
  { id: 'url', weight: 1, pattern: /https?:\/\/|www\./i },
  { id: 'tech', weight: 1, pattern: /(代码|函数|接口|模块|组件|依赖|缓存|索引|队列|数据库|服务|端口|日志|配置|脚本|插件|测试|类型|构建|编译|命令|终端|仓库|分支|提交)/ },
  { id: 'symbol', weight: 1, pattern: /[A-Za-z_$][\w$]*\s*\(|=>|\bfunction\b|::|`[^`]{2,}`/ },

  // --- 要"做到最好"：用户在明确要求质量优先，这种活值得多想 ---
  {
    id: 'quality',
    weight: 3,
    pattern: /(极致|极致地|做到最好|尽善尽美|完美|最优|最佳|精细|精心|精品|打磨|严谨|认真|仔细|慎重|周到|深度|深入|透彻|详尽|全面|逐项|逐一|一条条|每条|字斟句酌)/i,
  },

  // --- 要验收：写完之后还得逐项核过才算完 ---
  {
    id: 'verify',
    weight: 2,
    pattern: /(验收|核对|校验|验证|复核|复查|回归|自测|跑通|端到端测试|边界情况|边界条件|corner case|edge case|逐条|逐页|逐行|逐帧)/i,
  },

  // --- 有后果：这次的结果会被人/被生产用到 ---
  {
    id: 'deliver',
    weight: 2,
    pattern: /(交付|上线|发布|合并|提交给|发给|给客户|给老板|对外|生产环境|正式环境|签收|定稿|最后版本)/i,
  },

  // --- 越是不确定，越要多想 ---
  { id: 'hedge', weight: 1, pattern: /(不确定|可能|也许|大概|似乎|好像|或者|还是说|随便|都行|看情况|帮我判断|你决定)/i },
]

/**
 * 长度权重：**只取最高一档**，不叠乘。
 *
 * 门槛定在 21 字是刻意的：绝大多数真请求都比这长，所以这一档等于"这不是一句客套"；
 * 真正的重活靠信号加分，不靠字数堆。只取最高档是为了防止"长"被重复计费。
 */
const LENGTH_TIERS = [
  { min: 800, weight: 10 },
  { min: 200, weight: 6 },
  { min: 21, weight: 2 },
]

/**
 * 分数 → 组。
 *
 * 阈值按实测分布调：纯客套 0 分；一句提问 2 分前后；带动作词的活 5~9 分；
 * 大工程 / 出问题 / 明确要"做到极致"才上 10 分以上。
 */
const THRESHOLDS = [
  { max: 0, bucket: 'quiet' },
  { max: 2, bucket: 'light' },
  { max: 8, bucket: 'standard' },
  { max: Infinity, bucket: 'heavy' },
]

/**
 * 这段文本的长度权重。
 *
 * @param {number} length - 已扫描文本的字符数。
 * @returns {number} 加多少分。
 */
function lengthWeight(length) {
  for (const tier of LENGTH_TIERS) {
    if (length >= tier.min) return tier.weight
  }
  return 0
}

/** 一条信号命中的结果。 */
function score(text) {
  for (const signal of SIGNALS) {
    if (signal.exclusive !== true || signal.pattern.test(text) !== true) continue
    if (signal.maxChars !== undefined && text.length > signal.maxChars) continue
    return { exclusive: signal.id }
  }
  let total = 0
  let action = false
  let reading = false
  for (const signal of SIGNALS) {
    if (signal.exclusive === true) continue
    if (!signal.pattern.test(text)) continue
    total += signal.weight
    if (signal.action === true) action = true
    if (signal.read === true) reading = true
  }
  return { exclusive: undefined, total, action, reading }
}

/**
 * 一段文本的总分（信号分 + 长度分）。
 *
 * 单独导出是为了让"权重表"能被测试直接钉住——改权重时先看分数，再看组。
 *
 * @param {string} text - 纯文本。
 * @returns {{ total: number, signals: string[], exclusive: boolean }} 分数、命中的信号 id、是否客套。
 */
export function scoreText(text) {
  const scanned = text.slice(0, SCAN_LIMIT)
  const scoring = score(scanned)
  if (scoring.exclusive !== undefined) return { total: 0, signals: [scoring.exclusive], exclusive: true }
  const hits = []
  for (const signal of SIGNALS) {
    if (signal.exclusive === true) continue
    if (signal.pattern.test(scanned)) hits.push(signal.id)
  }
  return { total: scoring.total + lengthWeight(scanned.length), signals: hits, exclusive: false }
}

/**
 * 把一段文本归到某个组。
 *
 * @param {string} text - 纯文本。
 * @returns {string} 轻重组。
 */
export function classifyText(text) {
  const scanned = text.slice(0, SCAN_LIMIT)
  const scoring = score(scanned)
  if (scoring.exclusive !== undefined) return 'quiet'
  const total = scoring.total + lengthWeight(scanned.length)
  const hit = THRESHOLDS.find((step) => total <= step.max)
  const bucket = hit === undefined ? 'standard' : hit.bucket
  // 要动手、要读东西的活，最省也停在「轻」。
  if (bucket === 'quiet' && (scoring.action || scoring.reading)) return 'light'
  return bucket
}

/** 短追问的上限：超过这个长度，消息自带足够信号，不需要继承。 */
const INHERIT_MAX_CHARS = 120

/** 承接语。以它开头就是"接着刚才那件事"。 */
const CONTINUATION = /^(?:继续|接着|然后呢|然后|还有呢|还有|再来|再看看|再看下|再看一眼|再改|再调|下一步|重试|再试|go on|continue|next\b|then\b)/i

/** 指代/省略的措辞。 */
const REFERENT = /(?:这个|那个|它|其|上面|上边|前面|之前|刚才|刚刚|上述|以上|前述|此处|这里|这样|那样|this|that|it\b|those|these|above|previous|same)/i

/** 继承时把上一轮的重活压到「标准」：接着做的事不会因为一句"继续"变得更费。 */
const CARRY = { quiet: 'quiet', light: 'light', standard: 'standard', heavy: 'standard' }

/**
 * 判定一条用户消息，并处理"短追问继承上一轮"。
 *
 * @param {string} text - 已经取出的纯文本。
 * @param {{ bucket?: string }} [context] - `bucket` 是上一轮的组。
 * @returns {{ bucket: string, inherited: boolean }} 组与"是否靠继承得出"。
 */
export function classifyMessage(text, context = {}) {
  const previous = typeof context.bucket === 'string' ? context.bucket : undefined
  const trimmed = text.trim()
  if (trimmed === '') {
    return previous === undefined ? { bucket: 'standard', inherited: false } : { bucket: previous, inherited: true }
  }
  if (trimmed.length <= INHERIT_MAX_CHARS && previous !== undefined) {
    if (CONTINUATION.test(trimmed) || REFERENT.test(trimmed)) {
      return { bucket: CARRY[previous] ?? previous, inherited: true }
    }
  }
  return { bucket: classifyText(trimmed), inherited: false }
}
