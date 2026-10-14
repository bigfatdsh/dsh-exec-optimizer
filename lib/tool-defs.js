/**
 * 本插件注册的两个工具定义。
 *
 * ## 为什么是裸定义而不是 `defineTool`
 *
 * `defineTool` 来自 `@deepseek-ai/dsh-tools`，而插件是 `link:` 进 profile 的，真实路径
 * 下解析不到宿主的 `node_modules`（同机其它插件也都只用 node 内置模块）。宿主的
 * `tools.register()` 只要求 `{name, description, parameters, output:{schema, render}, execute}`，
 * `parameters` 是**原始 JSON Schema**，所以自己拼一个对象就够了，代价是入参校验要自己做。
 *
 * ## 常驻成本
 *
 * 每个注册的工具，每一轮请求都要付它的 schema。所以两个描述都压到最短，而且只在对应
 * 开关打开时才注册——关掉就是零成本。
 *
 * @module dsh-exec-optimizer/tool-defs
 */

/**
 * `retry_tool`：只发改动的字段，重放上一次失败的调用。
 *
 * @param {object} handlers - `{ execute(args, exec): Promise<object> }`。
 * @returns {object} 注册表可用的工具定义。
 */
export function retryTool(handlers) {
  return {
    name: 'retry_tool',
    // 描述就是每一轮都要付的常驻成本：一句说清"干什么"，细节交给系统提示词里那段纪律。
    // 输出 schema **不进**模型上下文（供应商只收 name/description/input_schema），
    // 所以那里可以写清楚，不用省。
    description: 'Replay the last failed tool call with only the changed arguments (edit-and-replay).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Failed tool to replay; default: the most recent one.' },
        patch: {
          type: 'object',
          properties: {},
          additionalProperties: true,
          description: 'Fields to change; merged into the failed arguments, `null` deletes a field.',
        },
        args: {
          type: 'object',
          properties: {},
          additionalProperties: true,
          description: 'Replacement arguments; used instead of `patch`.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: 'Whether the tool itself reported success.' },
          tool: { type: 'string', description: 'The tool that was replayed.' },
          replay: { type: 'string', description: 'What the replayed call returned.' },
          error: { type: 'string', description: 'Why the replay could not be attempted.' },
        },
        required: ['ok', 'replay'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.replay ?? '') }],
    },
    isConcurrencySafe: () => false,
    execute: handlers.execute,
  }
}

/**
 * `load_tools`：把藏起来的工具 schema 取回来。
 *
 * @param {object} handlers - `{ execute(args, exec): Promise<object> }`。
 * @returns {object} 注册表可用的工具定义。
 */
export function loadTool(handlers) {
  return {
    name: 'load_tools',
    description: 'Reveal unlisted tool schemas: {"list":true} prints an index, {"names":[...]} loads them.',
    parameters: {
      type: 'object',
      properties: {
        list: { type: 'boolean', description: 'Print the index of unlisted tools.' },
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Unlisted tool names to load.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          listed: { type: 'boolean' },
          loaded: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    isConcurrencySafe: () => true,
    execute: handlers.execute,
  }
}
