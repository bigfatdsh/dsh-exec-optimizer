/**
 * 插件配置。
 *
 * 用 Standard Schema v1（`~standard.validate`）。**未知键一律拒绝**：配置写错当场报错，
 * 不会静默失效（实测教训：把 `enabled` 写错时看起来"配了却没生效"）。
 *
 * @module dsh-exec-optimizer/schema
 */

/** 一次校验里收集到的问题。 */
class Field {
  /**
   * @param {object} [options] - `{ default, optional }`。
   */
  constructor(options = {}) {
    this.default = options.default
    this.optional = options.optional === true
  }

  /**
   * @param {unknown} value - 待校验的值。
   * @param {string} path - 报错路径。
   * @param {string[]} issues - 问题收集。
   * @returns {unknown} 通过后的值。
   */
  check(value, path, issues) {
    void value
    void path
    void issues
    return undefined
  }
}

/** 布尔字段。 */
class BooleanField extends Field {
  check(value, path, issues) {
    if (typeof value === 'boolean') return value
    if (value === undefined && this.optional) return undefined
    if (value === undefined && this.default !== undefined) return this.default
    issues.push(`${path}: expected a boolean, got ${value === undefined ? 'nothing' : typeof value}`)
    return this.default
  }
}

/** 非负数字字段。 */
class NumberField extends Field {
  check(value, path, issues) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    if (value === undefined) {
      if (this.optional) return undefined
      if (this.default !== undefined) return this.default
    }
    issues.push(`${path}: expected a non-negative number`)
    return this.default
  }
}

/** 非空字符串字段。 */
class StringField extends Field {
  check(value, path, issues) {
    if (typeof value === 'string' && value !== '') return value
    if (value === undefined) {
      if (this.optional) return undefined
      if (this.default !== undefined) return this.default
    }
    issues.push(`${path}: expected a non-empty string`)
    return this.default
  }
}

/**
 * 可空字符串字段。
 *
 * 与 `StringField` 的区别只有一条：**空串是合法值**。这一点很关键——`tierModelQuiet: ''`
 * 的语义是"这一档不换模型"，如果把它判成非法，`resolveConfig` 会整份配置退回默认，
 * 用户看到的就成了"我明明只留空了一个字段，别的开关全被打回去了"。
 */
class TextField extends Field {
  check(value, path, issues) {
    if (typeof value === 'string') return value
    if (value === undefined || value === null) {
      if (this.optional) return this.default
      if (this.default !== undefined) return this.default
    }
    issues.push(`${path}: expected a string`)
    return this.default
  }
}

/** 配置字段表。 */
export const Config = {
  /** 把界面开关写到 `<DSH_HOME>/exec-optimizer.json`，重启后保持上次选择。 */
  persist: new BooleanField({ default: true }),
  /** 每次挂载/装配/失败打一行 warn（排查"到底生效没生效"时打开 info）。 */
  log: new BooleanField({ default: false }),
  /** 状态文件路径；留空就用 `<DSH_HOME>/exec-optimizer.json`。 */
  file: new TextField({ default: '', optional: true }),

  // ---- 八个开关的默认值 ---------------------------------------------
  //
  // 取舍只有一条标准：**失败方向必须是"跟原来一样"**。
  //   * 只加文字、不改任何既有行为的（并行纪律）→ 默认开；
  //   * 改了工具结果、但全文一定落盘且可原样取回的（结果上限）→ 默认开；
  //   * 会让工具表变化、或改写会话历史、或换模型的 → 默认关，
  //     因为它们的代价（缓存重建 / 一次摘要调用 / 花钱的档位）必须由用户点头。

  /** 并行纪律：要求模型把互不依赖的工具调用合并进一条消息。 */
  parallelDefault: new BooleanField({ default: true }),
  /** 失败重放：注册 `retry_tool`，失败结果后面挂一行"只补这几个字段"。 */
  retryDefault: new BooleanField({ default: true }),
  /** 结果上限：超过上限的工具结果截头留尾，全文落盘并给出取回路径。 */
  resultCapDefault: new BooleanField({ default: true }),
  /** 对齐内置裁剪器阈值：把上限压到内置裁剪器的线上，让它再也改不动已发内容。 */
  cacheSafeDefault: new BooleanField({ default: true }),
  /** 复读抑制：连续空转的助手回合插提醒，越过硬线就停这一步。 */
  repeatGuardDefault: new BooleanField({ default: true }),
  /** 按需加载工具说明：默认只发核心工具的 schema，其余用 `load_tools` 取。 */
  lazyToolsDefault: new BooleanField({ default: false }),
  /** 提前自动压缩：越过自定线就调宿主的 `compactNow`，不等宿主的 67.8 万。 */
  autoCompactDefault: new BooleanField({ default: false }),
  /** 按任务轻重换模型/推理档：走官方 `agent/request` 瀑布，手选优先。 */
  modelTierDefault: new BooleanField({ default: false }),

  /** 结果上限（字符）；`cacheSafe` 打开时实际取它与内置裁剪器阈值的较小值。 */
  resultCapChars: new NumberField({ default: 8192 }),
  /** 提前自动压缩的触发线（token）。宿主默认线约 678,464。 */
  autoCompactTokens: new NumberField({ default: 300000 }),
  /** 复读连击到这个数就停这一步；0 = 只提醒不停。 */
  repeatStopAfter: new NumberField({ default: 4 }),
  /** 核心工具名单（逗号/空白分隔，留空用内置默认）。 */
  lazyCore: new TextField({ default: '', optional: true }),
  /** 没写映射时，是否按目录里的档位标记自动挑模型（同供应方内）。 */
  tierAuto: new BooleanField({ default: true }),
  /** 档位映射：`provider/model`；留空=交给自动挑。 */
  tierModelQuiet: new TextField({ default: '', optional: true }),
  tierModelLight: new TextField({ default: '', optional: true }),
  tierModelStandard: new TextField({ default: '', optional: true }),
  tierModelHeavy: new TextField({ default: '', optional: true }),
  /** 档位推理强度：`off` / `low` / `high` / `max`；留空=不动。 */
  tierEffortQuiet: new TextField({ default: 'off', optional: true }),
  tierEffortLight: new TextField({ default: 'low', optional: true }),
  tierEffortStandard: new TextField({ default: '', optional: true }),
  tierEffortHeavy: new TextField({ default: '', optional: true }),
}

Object.defineProperty(Config, '~standard', {
  value: {
    version: 1,
    vendor: 'dsh-exec-optimizer',
    /**
     * @param {unknown} value - 待校验配置。
     * @returns {{ value?: object, issues?: {message: string}[] }} 校验结果。
     */
    validate(value) {
      if (value === undefined || value === null) value = {}
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'config: expected an object' }] }
      }
      const source = /** @type {Record<string, unknown>} */ (value)
      const issues = []
      const known = new Set(Object.keys(Config))
      for (const key of Object.keys(source)) {
        if (!known.has(key)) issues.push({ message: `${key}: unknown option` })
      }
      const resolved = {}
      for (const [key, field] of Object.entries(Config)) {
        resolved[key] = field.check(source[key], key, issues)
      }
      if (issues.length > 0) return { issues }
      return { value: resolved }
    },
  },
})

/**
 * 解析配置：把校验结果落成一份带默认值的完整配置。
 *
 * @param {unknown} raw - 原始配置。
 * @returns {object} 带默认值的完整配置。
 */
export function resolveConfig(raw) {
  const result = Config['~standard'].validate(raw)
  if (result.issues !== undefined || result.value === undefined) {
    // 配置非法时退回"全默认"：宁可默认行为，也不要半截配置。
    const fallback = {}
    for (const [key, field] of Object.entries(Config)) fallback[key] = field.default
    return /** @type {any} */ (fallback)
  }
  return /** @type {any} */ (result.value)
}
