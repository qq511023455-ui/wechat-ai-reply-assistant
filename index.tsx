/**
 * 微信聊天 AI 助手 — WeChat Chat AI Assistant for iOS Scripting
 *
 * 功能：从剪贴板获取微信聊天记录 → 解析记录 → 总结当天聊天内容
 * → 提供多种风格的 AI 回复供用户选择 → 一键复制回复
 *
 * 支持 3 个 AI 接口配置（LongCat / 硅基流动 / 自定义），各有独立 URL/Key/模型
 * 支持输入用户心里想法、聊天前因后果作为 AI 参考
 * 生成时显示安慰/开导窗口（AI 生成，非内置），帮助用户更好地接受回复建议
 */

import {
  Button,
  Capsule,
  Color,
  Divider,
  HStack,
  Image,
  List,
  Navigation,
  NavigationStack,
  RoundedRectangle,
  Script,
  Section,
  SecureField,
  Slider,
  Spacer,
  Text,
  TextField,
  Toggle,
  VStack,
  ZStack,
  fetch,
  useEffect,
  useObservable,
} from "scripting"

const Tg = Toggle as any

// ───────────────────────────────────────────────────────────────────────────
// 0. Shape 类型别名
// ───────────────────────────────────────────────────────────────────────────

const Round = RoundedRectangle as any
const ZS = ZStack as any
const VS = VStack as any
const HS = HStack as any
const Btn = Button as any
const T = Text as any
const TF = TextField as any
const SF = SecureField as any
const Sec = Section as any
const Lst = List as any
const Img = Image as any
const Cap = Capsule as any

// ───────────────────────────────────────────────────────────────────────────
// 1. 常量与类型
// ───────────────────────────────────────────────────────────────────────────

const KEY_PREFIX = "wechat_ai_"
const KEY_SETTINGS = KEY_PREFIX + "settings"

const ENDPOINTS = ["longcat", "siliconflow", "custom"] as const
type EndpointId = typeof ENDPOINTS[number]

function keyUrl(id: EndpointId) { return KEY_PREFIX + id + "_url" }
function keyModel(id: EndpointId) { return KEY_PREFIX + id + "_model" }
function keyApiKey(id: EndpointId) { return KEY_PREFIX + id + "_key" }

const DEFAULTS: Record<EndpointId, { url: string; model: string }> = {
  longcat: { url: "https://api.longcat.chat/openai/v1/chat/completions", model: "LongCat-2.0-Preview" },
  siliconflow: { url: "https://api.siliconflow.cn/v1/chat/completions", model: "deepseek-ai/DeepSeek-R1" },
  custom: { url: "", model: "" },
}

const ALL_STYLES = [
  { id: "casual", label: "随意轻松", color: "#34D399", emoji: "😎" },
  { id: "friendly", label: "友好亲切", color: "#60A5FA", emoji: "😊" },
  { id: "professional", label: "专业正式", color: "#A78BFA", emoji: "💼" },
  { id: "humorous", label: "幽默风趣", color: "#FB923C", emoji: "😂" },
  { id: "warm", label: "温暖贴心", color: "#F472B6", emoji: "🥰" },
  { id: "concise", label: "简洁直接", color: "#38BDF8", emoji: "⚡" },
  { id: "empathetic", label: "共情理解", color: "#818CF8", emoji: "🤗" },
  { id: "encouraging", label: "鼓励支持", color: "#2DD4BF", emoji: "💪" },
  { id: "playful", label: "俏皮撒娇", color: "#FB7185", emoji: "😘" },
  { id: "thoughtful", label: "深思熟虑", color: "#94A3B8", emoji: "🤔" },
] as const

type ReplyStyle = typeof ALL_STYLES[number]["id"]

type AppSettings = {
  activeEndpoint: EndpointId
  replyCount: number
  temperature: number
  maxTokens: number
  showComfort: boolean
}

const DEFAULT_SETTINGS: AppSettings = {
  activeEndpoint: "longcat",
  replyCount: 5,
  temperature: 0.7,
  maxTokens: 2000,
  showComfort: true,
}

type ChatMessage = {
  id: number
  sender: string
  content: string
  timestamp: Date
  isUser: boolean
}

type ReplyOption = {
  id: number
  content: string
  style: ReplyStyle
}

type ParsedChatResult = {
  messages: ChatMessage[]
  date: string
  totalCount: number
  participants: string[]
}

// 角色确认：用户选"我是谁"、输入对方身份描述
type RoleSetup = {
  myName: string        // 聊天里代表"我"的那个名字（旁观者模式下为空字符串）
  otherRole: string     // 对方的身份描述，如"上司"、"喜欢的人"
  isObserver: boolean   // true 表示用户不在这段对话里，只是旁观者/转发记录的查看者
}

// 角色选择列表里"我不在这段对话里"这个特殊选项的内部标记值，
// 用来和真实参与者名字区分开（不会和任何真实微信昵称重复）
const OBSERVER_MARK = "__OBSERVER__"

// ───────────────────────────────────────────────────────────────────────────
// 2. Keychain 持久化
// ───────────────────────────────────────────────────────────────────────────

function loadSettings(): AppSettings {
  try {
    const raw = Keychain.get(KEY_SETTINGS)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch { return { ...DEFAULT_SETTINGS } }
}

function saveSettings(s: AppSettings) {
  try { Keychain.set(KEY_SETTINGS, JSON.stringify(s)) } catch { /* */ }
}

function getEndpointUrl(id: EndpointId): string {
  return Keychain.get(keyUrl(id)) || DEFAULTS[id].url
}
function setEndpointUrl(id: EndpointId, url: string) {
  if (url) Keychain.set(keyUrl(id), url); else Keychain.remove(keyUrl(id))
}

function getEndpointModel(id: EndpointId): string {
  return Keychain.get(keyModel(id)) || DEFAULTS[id].model
}
function setEndpointModel(id: EndpointId, model: string) {
  if (model) Keychain.set(keyModel(id), model); else Keychain.remove(keyModel(id))
}

function getEndpointApiKey(id: EndpointId): string | null {
  return Keychain.get(keyApiKey(id))
}
function setEndpointApiKey(id: EndpointId, key: string): boolean {
  if (!key) return Keychain.remove(keyApiKey(id))
  return Keychain.set(keyApiKey(id), key)
}

function maskKey(key: string | null): string {
  if (!key) return "未配置"
  if (key.length <= 8) return "已配置 (••••)"
  return `已配置 (••••${key.slice(-4)})`
}

// ───────────────────────────────────────────────────────────────────────────
// 3. 工具函数
// ───────────────────────────────────────────────────────────────────────────

function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, "0")}月${String(d.getDate()).padStart(2, "0")}日`
}

function truncateError(text: string): string {
  return text.length > 500 ? text.slice(0, 500) + "…" : text
}

function styleLabel(style: string): string {
  return ALL_STYLES.find(s => s.id === style)?.label || style
}

function styleColor(style: string): string {
  return ALL_STYLES.find(s => s.id === style)?.color || "#94A3B8"
}

function styleEmoji(style: string): string {
  return ALL_STYLES.find(s => s.id === style)?.emoji || "💬"
}

// ───────────────────────────────────────────────────────────────────────────
// 4. 微信聊天记录解析器
// ───────────────────────────────────────────────────────────────────────────

function parseChineseDate(dateStr: string): Date {
  const m = dateStr.match(/(\d{4})年(\d{2})月(\d{2})日\s*(\d{2}):(\d{2})/)
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
  return new Date()
}

function parseChatContent(text: string, myName?: string): ParsedChatResult | null {
  if (!text?.trim()) return null

  // 归一化：统一换行符，清除零宽字符等不可见字符
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')

  // 保留原始行（含空行位置），单独维护一份去除首尾空白的版本用于匹配
  const rawLines = normalized.split('\n')
  const dateRe = /^(\d{4})年(\d{2})月(\d{2})日\s+(\d{2}):(\d{2})/

  // 第一步：找出所有"日期时间行"的行号
  const dateLineIndexes: number[] = []
  for (let idx = 0; idx < rawLines.length; idx++) {
    if (dateRe.test(rawLines[idx].trim())) dateLineIndexes.push(idx)
  }

  if (dateLineIndexes.length === 0) return null

  // 第二步：对每个日期行，向上找最近的非空行作为发送者名（跳过"-"前缀）
  function findSenderAbove(dateIdx: number): string {
    for (let j = dateIdx - 1; j >= 0; j--) {
      const t = rawLines[j].trim()
      if (!t) continue
      // 跳过：如果这一行本身也是日期行（极端情况下连续两行日期），继续向上找
      if (dateRe.test(t)) continue
      return t.replace(/^-+\s*/, '').replace(/[.。]$/, '').trim()
    }
    return ""
  }

  // 第三步：每条消息的内容范围 = 当前日期行的下一行 起，到下一条消息的"发送者行"之前 止
  const messages: ChatMessage[] = []
  const participants = new Set<string>()
  let msgId = 0

  for (let k = 0; k < dateLineIndexes.length; k++) {
    const dateIdx = dateLineIndexes[k]
    const dateStr = rawLines[dateIdx].trim()
    const sender = findSenderAbove(dateIdx)
    if (!sender) continue

    // 内容范围：从 dateIdx+1 开始，到下一条消息的发送者行之前结束
    // 下一条消息的发送者行 = 下一个日期行向上找到的非空行，所以内容结束位置就是"下一个日期行的发送者行所在的行号"
    let endIdx: number
    if (k + 1 < dateLineIndexes.length) {
      const nextDateIdx = dateLineIndexes[k + 1]
      // 找下一条消息发送者所在的具体行号
      let senderLineIdx = nextDateIdx
      for (let j = nextDateIdx - 1; j >= dateIdx + 1; j--) {
        const t = rawLines[j].trim()
        if (!t) continue
        if (dateRe.test(t)) break
        senderLineIdx = j
        break
      }
      endIdx = senderLineIdx
    } else {
      endIdx = rawLines.length
    }

    const contentLines = rawLines.slice(dateIdx + 1, endIdx).map(l => l.trim()).filter(l => l)
    const content = contentLines.join('\n').trim()
    if (!content) continue

    const isUser = myName ? sender === myName : sender === "我"
    messages.push({ id: msgId++, sender, content, timestamp: parseChineseDate(dateStr), isUser })
    participants.add(sender)
  }

  if (!messages.length) return null
  return {
    messages,
    date: formatDate(messages[0].timestamp),
    totalCount: messages.length,
    participants: Array.from(participants),
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 5. AI 调用层
// ───────────────────────────────────────────────────────────────────────────

function buildPrompt(
  chat: ParsedChatResult,
  count: number,
  innerThoughts: string,
  role?: RoleSetup | null,
): string {
  const recentMessages = chat.messages.slice(-25)
  const lines = recentMessages
    .map((m, idx) => `${idx + 1}. [${formatDate(m.timestamp)} ${formatTime(m.timestamp)}] ${m.sender}: ${m.content}`)
    .join('\n')

  const lastMsg = recentMessages[recentMessages.length - 1]
  const lastMsgDesc = lastMsg ? `「${lastMsg.sender}」在 ${formatDate(lastMsg.timestamp)} ${formatTime(lastMsg.timestamp)} 说的最后一句话："${lastMsg.content}"` : ""

  let roleContext = ""
  let replyPerspective = ""
  if (role?.isObserver) {
    // 旁观者模式：用户不是对话中的任何一方，只是在看这段记录（比如转发记录、帮朋友看聊天）
    roleContext += `\n重要：用户不是这段聊天中的任何一方，只是旁观者，在查看这段对话记录（可能是被转发的、或帮别人看的）`
    replyPerspective = `由于用户是旁观者，"回复建议"应理解为：如果用户要插话评论这段对话，或者要把这段对话转述/反馈给别人时，可以怎么说。不要假装用户是对话中的某一方。`
  } else if (role?.myName) {
    roleContext += `\n聊天中"${role.myName}"是用户本人，回复应以${role.myName}的口吻撰写`
    replyPerspective = `回复建议是以"${role.myName}"的身份和口吻，回应最后一条消息。`
  }
  if (role?.otherRole) roleContext += `\n对方身份：${role.otherRole}`
  if (innerThoughts.trim()) roleContext += `\n用户的心里话和想法：${innerThoughts.trim()}`

  const styleNames = ALL_STYLES.map(s => `${s.label} (${s.id})`).join("、")

  return `以下是一段微信聊天记录，按时间顺序编号列出，请通读全部 ${chat.totalCount} 条消息（不要只看第一条），理解完整的对话脉络和情绪变化后再作答。

聊天记录 (${chat.date}，共 ${chat.totalCount} 条，已按时间顺序编号):
${lines}${roleContext}

当前需要回复的是最新这条消息：${lastMsgDesc}
${replyPerspective || "你需要生成的回复建议，都是用来回应这最后一条消息的，要让对话能自然地接续下去，而不是重新讨论聊天记录里前面的旧话题。"}

要求:
1. summary 字段：通读全部 ${chat.totalCount} 条消息后，按时间线简要梳理整段对话发生了什么，需要体现出对话的发展脉络，而不是只复述第一条消息的内容
2. comfort 字段：结合整段对话的情绪走向和最后一条消息，生成一句真诚、针对本次具体情境的安慰或鼓励的话，不要泛泛而谈
3. replies 字段：提供 ${count} 个不同风格的回复建议。可选风格：${styleNames}
   请选择最有价值的 ${count} 种风格，不要总是选同样的
4. 每个回复要自然流畅、贴合语境、适合微信聊天，且要与最后一条消息的话题相关
5. 每个回复控制在30字以内
6. 语气要符合每种风格的特点，并考虑用户与对方的关系

严格按以下JSON格式返回，必须遵守：
- 不要加任何markdown代码块标记（不要用三个反引号包裹），直接输出纯JSON文本
- JSON的冒号、逗号、引号必须全部使用英文半角符号（: , "），绝对不能使用中文全角符号（：，"）
- 每个对象之间用英文逗号分隔，不能有缺漏或多余的符号
- 输出前请在心里检查一遍JSON语法是否完整闭合、没有标点错误

{"summary": "通读全部消息后按时间线梳理的对话脉络总结", "comfort": "针对整段对话情绪的个性化安慰/开导话语", "replies": [{"style": "风格id", "content": "回复内容"}]}`
}

// 专门用于生成安慰语的独立提示词（主调用未返回 comfort 字段时使用）
function buildComfortOnlyPrompt(chat: ParsedChatResult, innerThoughts: string): string {
  const recent = chat.messages.slice(-15)
  const lines = recent
    .map((m, idx) => `${idx + 1}. ${m.sender}: ${m.content}`)
    .join('\n')
  let extra = innerThoughts.trim() ? `\n用户的心声：${innerThoughts.trim()}` : ""
  return `请通读以下全部 ${recent.length} 条微信聊天内容${extra ? "和用户心声" : ""}（不要只看第一条），理解整段对话的情绪走向后，生成一句温暖、有共情、针对具体情境的安慰或鼓励的话。不要泛泛而谈，要贴合聊天的整体内容。直接返回那句话，不要任何解释。

聊天内容（按时间顺序）:
${lines}${extra}`
}

// 尝试修复常见的AI生成JSON时的标点错误：
// 1. 全角冒号/逗号误用在JSON结构位置（如 "key：value" 应为 "key": "value"）
// 2. 紧邻的两个对象之间缺少逗号分隔，如 {...} {...} 应为 {...}, {...}
function repairJSON(text: string): string {
  let fixed = text
    // 修复 "content：xxx" 这种全角冒号紧跟在引号后充当JSON冒号的情况
    .replace(/"\s*：\s*/g, '": ')
    // 修复对象/数组之间缺逗号：}{ 或 } { 之间补逗号
    .replace(/}\s*{/g, '}, {')
    .replace(/]\s*\[/g, '], [')
  return fixed
}

function extractJSON(text: string): any | null {
  try { return JSON.parse(text) } catch { }
  const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (m) { try { return JSON.parse(m[1].trim()) } catch { } }
  const s = text.indexOf('{'), e = text.lastIndexOf('}')
  if (s >= 0 && e > s) {
    const slice = text.slice(s, e + 1)
    try { return JSON.parse(slice) } catch { }
    // 标准解析失败后，尝试修复常见标点错误再解析一次
    try { return JSON.parse(repairJSON(slice)) } catch { }
  }
  return null
}

// 当 replies 数组因JSON局部损坏而整体解析失败时，逐个对象单独抢救：
// 用正则把每个 {"style": "...", "content": "..."} 形状的片段单独抠出来再解析，
// 这样即使某一条坏了，其余条目依然能正常展示，而不是整体放弃
function salvageReplies(text: string): { style: string; content: string }[] {
  const results: { style: string; content: string }[] = []
  // 宽松匹配：style和content的值，允许中间冒号是全角或半角
  const re = /"style"\s*[:：]\s*"([^"]+)"\s*,\s*"content"\s*[:：]\s*"([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    results.push({ style: match[1], content: match[2] })
  }
  return results
}

// 内置降级回复已移除：AI 调用失败时直接展示错误信息，不再用固定文案掩盖问题

async function callAI(
  prompt: string,
  apiKey: string,
  apiUrl: string,
  model: string,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  let response: any
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      timeout: 30,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature,
        max_tokens: maxTokens,
      }),
    })
  } catch (netErr: any) {
    // 网络层失败：DNS、超时、连接被拒绝、域名不在白名单等
    throw new Error(`网络请求失败 (${apiUrl}): ${netErr?.message ?? String(netErr)}`)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`接口返回错误 ${response.status} ${response.statusText ?? ""}: ${truncateError(text || "(无响应内容)")}`)
  }

  const rawText = await response.text().catch(() => "")
  let data: any = null
  try { data = JSON.parse(rawText) } catch {
    throw new Error(`接口返回的不是合法 JSON: ${truncateError(rawText)}`)
  }

  const content = data?.choices?.[0]?.message?.content
  if (!content) {
    throw new Error(`接口返回中没有 choices[0].message.content，原始返回: ${truncateError(JSON.stringify(data))}`)
  }
  return content
}

// ───────────────────────────────────────────────────────────────────────────
// 6. App 组件
// ───────────────────────────────────────────────────────────────────────────

function App() {
  const savedSettings = loadSettings()

  // ── 核心状态 ──
  const status = useObservable<string>("idle")
  const isLoading = useObservable<boolean>(false)
  const error = useObservable<string>("")
  const rawDiagnosis = useObservable<string>("")  // 原始格式字符级诊断，临时调试用

  // 剪贴板与解析
  const clipboardText = useObservable<string>("")
  const parsedResult = useObservable<ParsedChatResult | null>(null)
  const chatSummary = useObservable<string>("")
  const comfortMsg = useObservable<string>("")
  const replyOptions = useObservable<ReplyOption[]>([])
  const selectedReplyId = useObservable<number | null>(null)

  // 角色确认状态
  const roleSetup = useObservable<RoleSetup | null>(null)
  const showRoleSetup = useObservable<boolean>(false)   // 解析后弹出确认面板
  const roleMyNameInput = useObservable<string>("")     // 用户正在选/输入的"我是谁"
  const roleOtherInput = useObservable<string>("")      // 用户输入的对方身份

  // 心里话 — 合并为一个字段，供 AI 参考
  const innerThoughts = useObservable<string>("")       // 已保存，传给 AI
  const innerThoughtsInput = useObservable<string>("")  // 输入框当前值（普通文本框）

  // 保留兼容旧代码引用，不再单独使用
  const chatContext = useObservable<string>("")
  const chatContextInput = useObservable<string>("")

  // ── 接口切换 ──
  const activeEndpoint = useObservable<EndpointId>(savedSettings.activeEndpoint)

  // 3 个接口各自独立：
  //   xxxUrl/xxxModel = 已保存的值（用于 AI 调用时读取，显示 mask）
  //   xxxUrlInput/xxxModelInput = 输入框中正在输入的值（与 Key 模式完全对齐）
  const longcatUrl = useObservable<string>(getEndpointUrl("longcat"))
  const longcatUrlInput = useObservable<string>("")
  const longcatModel = useObservable<string>(getEndpointModel("longcat"))
  const longcatModelInput = useObservable<string>("")
  const longcatKey = useObservable<string>("")
  const longcatMask = useObservable<string>(maskKey(getEndpointApiKey("longcat")))

  const siliconflowUrl = useObservable<string>(getEndpointUrl("siliconflow"))
  const siliconflowUrlInput = useObservable<string>("")
  const siliconflowModel = useObservable<string>(getEndpointModel("siliconflow"))
  const siliconflowModelInput = useObservable<string>("")
  const siliconflowKey = useObservable<string>("")
  const siliconflowMask = useObservable<string>(maskKey(getEndpointApiKey("siliconflow")))

  const customUrl = useObservable<string>(getEndpointUrl("custom"))
  const customUrlInput = useObservable<string>("")
  const customModel = useObservable<string>(getEndpointModel("custom"))
  const customModelInput = useObservable<string>("")
  const customKey = useObservable<string>("")
  const customMask = useObservable<string>(maskKey(getEndpointApiKey("custom")))

  // 设置
  const replyCount = useObservable<number>(savedSettings.replyCount)
  const temperature = useObservable<number>(savedSettings.temperature)
  const maxTokens = useObservable<number>(savedSettings.maxTokens)
  const showComfort = useObservable<boolean>(savedSettings.showComfort)

  // Keychain 刷新触发器
  const kcVersion = useObservable<number>(0)
  void kcVersion.value
  const bumpKC = () => kcVersion.setValue(kcVersion.value + 1)

  // ── getActiveObservables：返回当前接口的所有 Observable ──
  function getActiveObservables() {
    switch (activeEndpoint.value) {
      case "longcat":
        return {
          urlObs: longcatUrl,
          urlInputObs: longcatUrlInput,
          modelObs: longcatModel,
          modelInputObs: longcatModelInput,
          keyObs: longcatKey,
          maskObs: longcatMask,
        }
      case "siliconflow":
        return {
          urlObs: siliconflowUrl,
          urlInputObs: siliconflowUrlInput,
          modelObs: siliconflowModel,
          modelInputObs: siliconflowModelInput,
          keyObs: siliconflowKey,
          maskObs: siliconflowMask,
        }
      case "custom":
        return {
          urlObs: customUrl,
          urlInputObs: customUrlInput,
          modelObs: customModel,
          modelInputObs: customModelInput,
          keyObs: customKey,
          maskObs: customMask,
        }
    }
  }

  // ── 操作 ──

  // 解析成功后的公共处理：清空旧结果、打开角色确认面板
  function afterParsed(result: ParsedChatResult) {
    parsedResult.setValue(result)
    chatSummary.setValue("")
    comfortMsg.setValue("")
    replyOptions.setValue([])
    selectedReplyId.setValue(null)
    roleSetup.setValue(null)
    // 不预选，让用户主动点选
    roleMyNameInput.setValue("")
    roleOtherInput.setValue("")
    showRoleSetup.setValue(true)   // 弹出角色确认面板
  }

  // 解析后做一次轻量诊断，帮助判断是"剪贴板内容本身就少"还是"解析逻辑漏掉了"
  function diagnoseAndNotify(content: string, result: ParsedChatResult | null) {
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    const allLines = normalized.split('\n')
    const nonEmptyLines = allLines.filter(l => l.trim()).length
    const dateRe = /^(\d{4})年(\d{2})月(\d{2})日\s+(\d{2}):(\d{2})/
    const dateLineCount = allLines.filter(l => dateRe.test(l.trim())).length

    if (!result) {
      if (dateLineCount === 0) {
        error.setValue(`未能识别出任何日期时间行（格式需类似"2026年06月19日 21:47"）。剪贴板共 ${content.length} 字、${nonEmptyLines} 行非空内容，但没有一行匹配该日期格式，请检查复制的内容是否完整，或日期格式是否有差异（比如全角/半角冒号、多余空格）。`)
      } else {
        error.setValue(`识别到 ${dateLineCount} 个日期时间行，但未能匹配出对应的发送者。请确认每个日期行的上方紧邻有一行发送者名字（中间不要有多余的标点或空行干扰）。`)
      }
      return
    }

    // 粗略估算：每条消息至少占用2行（名字/日期 + 内容），若解析出的条数远少于日期行数，说明部分日期行没能配对成功
    if (result.totalCount < dateLineCount) {
      error.setValue(`提示：剪贴板中识别到 ${dateLineCount} 个日期时间行，但只成功解析出 ${result.totalCount} 条消息，有 ${dateLineCount - result.totalCount} 条可能因找不到发送者或内容为空被跳过。`)
    } else {
      error.setValue("")
    }
  }

  // 字符级诊断：把剪贴板原始内容的前N行逐行展示，标记出不可见字符和换行符类型
  // 用于排查"为什么这台设备上解析不出来"，结果可直接截图/复制反馈
  function handleDiagnoseRaw() {
    const raw = clipboardText.value
    if (!raw) { rawDiagnosis.setValue("（剪贴板为空）"); return }

    // 检测原始换行符类型（在 replace 之前检测，否则看不出原始类型）
    const hasCRLF = raw.includes('\r\n')
    const hasCROnly = !hasCRLF && raw.includes('\r')
    const hasLF = raw.includes('\n')
    const lineBreakType = hasCRLF ? "\\r\\n (CRLF)" : hasCROnly ? "\\r only (CR)" : hasLF ? "\\n (LF)" : "未检测到换行符！"

    const hasZeroWidth = /[\u200b\u200c\u200d\ufeff]/.test(raw)
    const hasFullWidthColon = raw.includes('：')
    const hasFullWidthDigit = /[０-９]/.test(raw)

    const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const lines = normalized.split('\n')
    const dateRe = /^(\d{4})年(\d{2})月(\d{2})日\s+(\d{2}):(\d{2})/

    // 展示前12行，每行标注：是否匹配日期格式、行内容、行长度
    const preview = lines.slice(0, 12).map((l, i) => {
      const trimmed = l.trim()
      const isDate = dateRe.test(trimmed)
      const tag = isDate ? "[日期✓]" : trimmed === "" ? "[空行]" : "[内容]"
      return `${i + 1} ${tag} "${trimmed}"`
    }).join('\n')

    const report = [
      `总字符数: ${raw.length}`,
      `总行数: ${lines.length}`,
      `换行符类型: ${lineBreakType}`,
      `含零宽/不可见字符: ${hasZeroWidth ? "是" : "否"}`,
      `含全角冒号(：): ${hasFullWidthColon ? "是" : "否"}`,
      `含全角数字: ${hasFullWidthDigit ? "是" : "否"}`,
      `匹配到的日期行数: ${lines.filter(l => dateRe.test(l.trim())).length}`,
      ``,
      `前12行内容预览:`,
      preview,
    ].join('\n')

    rawDiagnosis.setValue(report)
  }

  // 延迟辅助函数
  function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  async function handleGetClipboard() {
    isLoading.setValue(true); error.setValue("")
    try {
      // 关键修复：iOS 的 UIPasteboard.string（单数）只读取剪贴板里的"第一个 item"。
      // 微信多选复制多条消息时，很可能把每条消息写成了独立的 pasteboard item，
      // 导致 Pasteboard.getString() 只拿到第一条。
      // 优先尝试 Pasteboard.getStrings()（复数，对应 UIPasteboard.strings，读取全部 item），
      // 如果该 API 在当前 Scripting 版本不存在，则降级回 getString() 并保留原有的多次重试逻辑。
      let content = ""
      const pb = Pasteboard as any

      if (typeof pb.getStrings === "function") {
        try {
          const arr: string[] = await pb.getStrings()
          if (Array.isArray(arr) && arr.length > 0) {
            content = arr.filter(s => !!s).join('\n')
          }
        } catch {
          // getStrings 调用失败，忽略，继续走降级路径
        }
      }

      // 降级/兜底路径：多次重试 getString()，取字符数最长的一次
      if (!content) {
        let best = ""
        for (let attempt = 0; attempt < 3; attempt++) {
          const c = await Pasteboard.getString()
          if (c && c.length > best.length) best = c
          if (attempt < 2) await delay(150)
        }
        content = best
      }

      if (!content?.trim()) { error.setValue("剪贴板为空，请先复制微信聊天记录"); return }
      clipboardText.setValue(content)

      // 字符数过少时先提醒，避免误把"复制错内容"当成程序解析失败
      if (content.trim().length < 80) {
        error.setValue(`当前剪贴板内容只有 ${content.length} 个字符，看起来不像一段完整的聊天记录（内容预览："${content.slice(0, 50)}"）。iOS 系统对剪贴板多条目读取存在限制，建议直接长按下方文本框「粘贴」，这种方式更可靠。`)
        return
      }

      const result = parseChatContent(content)
      diagnoseAndNotify(content, result)
      if (result) afterParsed(result)
    } catch (err: any) {
      error.setValue(`获取剪贴板失败: ${err?.message ?? String(err)}`)
    } finally { isLoading.setValue(false) }
  }

  function handleParseText() {
    isLoading.setValue(true); error.setValue("")
    try {
      const result = parseChatContent(clipboardText.value)
      diagnoseAndNotify(clipboardText.value, result)
      if (result) afterParsed(result)
    } catch (err: any) {
      error.setValue(`解析失败: ${err?.message ?? String(err)}`)
    } finally { isLoading.setValue(false) }
  }

  // 角色确认：用户点确认后重新解析（带myName）并保存roleSetup
  function handleConfirmRole() {
    const isObserver = roleMyNameInput.value === OBSERVER_MARK
    const myName = isObserver ? "" : roleMyNameInput.value.trim()
    const otherRole = roleOtherInput.value.trim()

    if (!isObserver && !myName) { error.setValue("请选择你自己的名字，或选择「我不在这段对话里」"); return }

    // isObserver 时不传 myName，parseChatContent 内部判断 isUser 时永远为 false（因为没人叫"我"，
    // 也没传 myName 去匹配），效果就是聊天记录里所有人都被视为"对方"
    const result = parseChatContent(clipboardText.value, isObserver ? "__no_one__" : myName)
    if (result) {
      parsedResult.setValue(result)
      roleSetup.setValue({ myName: isObserver ? "" : myName, otherRole, isObserver })
      showRoleSetup.setValue(false)
      error.setValue("")
    } else {
      error.setValue("重新解析失败，请检查聊天记录")
    }
  }

  async function handleGenerateReplies() {
    const id = activeEndpoint.value
    const { urlObs, modelObs } = getActiveObservables()
    const apiKey = getEndpointApiKey(id)

    if (!apiKey) {
      const label = id === "longcat" ? "LongCat" : id === "siliconflow" ? "硅基流动" : "自定义"
      error.setValue(`请先配置 ${label} 的 API Key`)
      return
    }
    if (!parsedResult.value?.messages.length) { error.setValue("请先获取并解析聊天记录"); return }
    const urlVal = urlObs.value.trim()
    const modelVal = modelObs.value.trim()
    if (!urlVal) { error.setValue("API 地址不能为空"); return }
    if (!modelVal) { error.setValue("模型名称不能为空"); return }

    // 持久化保存当前 url/model
    setEndpointUrl(id, urlVal)
    setEndpointModel(id, modelVal)
    // 保存通用设置
    saveSettings({
      activeEndpoint: id,
      replyCount: replyCount.value,
      temperature: temperature.value,
      maxTokens: maxTokens.value,
      showComfort: showComfort.value,
    })

    isLoading.setValue(true); error.setValue(""); status.setValue("loading")
    comfortMsg.setValue("") // 清空旧安慰语

    try {
      const prompt = buildPrompt(
        parsedResult.value,
        replyCount.value,
        innerThoughts.value,
        roleSetup.value,
      )
      const aiRaw = await callAI(prompt, apiKey, urlVal, modelVal, maxTokens.value, temperature.value)
      const parsed = extractJSON(aiRaw)

      if (parsed?.replies?.length) {
        replyOptions.setValue(
          parsed.replies.map((r: any, i: number) => ({
            id: i + 1,
            content: r.content || "",
            style: (r.style || "casual") as ReplyStyle,
          }))
        )
        chatSummary.setValue(parsed.summary || "")
        if (parsed.comfort) {
          comfortMsg.setValue(showComfort.value ? parsed.comfort : "")
        } else if (showComfort.value) {
          // 单独生成安慰语（非阻塞，生成后更新）
          generateComfortAsync(apiKey, urlVal, modelVal)
        }
        status.setValue("success")
      } else {
        // 标准JSON解析失败（常见于AI偶发输出标点错误，如把英文冒号误写成中文全角冒号，
        // 或对象之间漏掉逗号）。这种情况下整段JSON语法虽然坏了，但内容本身大多是完整的，
        // 用正则把每条 {"style":..., "content":...} 单独抠出来，尽量抢救出可用结果，
        // 而不是直接报错让用户一无所获。
        const salvaged = salvageReplies(aiRaw)
        if (salvaged.length > 0) {
          replyOptions.setValue(
            salvaged.map((r, i) => ({
              id: i + 1,
              content: r.content,
              style: (r.style || "casual") as ReplyStyle,
            }))
          )
          // 单独尝试抢救 summary 和 comfort 字段
          const summaryMatch = aiRaw.match(/"summary"\s*[:：]\s*"([^"]*)"/)
          const comfortMatch = aiRaw.match(/"comfort"\s*[:：]\s*"([^"]*)"/)
          chatSummary.setValue(summaryMatch ? summaryMatch[1] : "")
          if (comfortMatch && showComfort.value) {
            comfortMsg.setValue(comfortMatch[1])
          } else if (showComfort.value) {
            generateComfortAsync(apiKey, urlVal, modelVal)
          }
          error.setValue(`提示：AI 返回的 JSON 格式有轻微错误（已自动修复），成功抢救出 ${salvaged.length} 条回复，内容可正常使用。`)
          status.setValue("success")
        } else {
          // 连兜底抢救都失败，说明返回内容严重损坏或完全不是预期格式，如实报告
          error.setValue(`AI 返回内容无法解析为预期格式，原始返回前300字: ${truncateError(aiRaw)}`)
          replyOptions.setValue([])
          chatSummary.setValue("")
          status.setValue("error")
        }
      }
    } catch (err: any) {
      const msg = truncateError(err?.message ?? String(err))
      error.setValue(msg); status.setValue("error")
      replyOptions.setValue([])
      chatSummary.setValue("")
      comfortMsg.setValue("")
    } finally { isLoading.setValue(false) }
  }

  // 【新增】单独异步生成安慰语，不阻塞主流程
  async function generateComfortAsync(apiKey: string, urlVal: string, modelVal: string) {
    if (!parsedResult.value) return
    try {
      const prompt = buildComfortOnlyPrompt(parsedResult.value, innerThoughts.value)
      // 安慰语 token 用量少，maxTokens 固定 200
      const raw = await callAI(prompt, apiKey, urlVal, modelVal, 200, 0.9)
      comfortMsg.setValue(raw.trim())
    } catch {
      // 安慰语生成失败静默处理，不影响主功能
      comfortMsg.setValue("")
    }
  }

  async function handleCopyReply(content: string) {
    try {
      await Pasteboard.setString(content)
    } catch (err: any) {
      error.setValue(`复制失败: ${err?.message ?? String(err)}`)
    }
  }

  function handleClear() {
    clipboardText.setValue(""); parsedResult.setValue(null); chatSummary.setValue("")
    comfortMsg.setValue(""); replyOptions.setValue([]); selectedReplyId.setValue(null)
    error.setValue(""); status.setValue("idle")
    innerThoughts.setValue(""); innerThoughtsInput.setValue("")
    chatContext.setValue(""); chatContextInput.setValue("")
    roleSetup.setValue(null); showRoleSetup.setValue(false)
    roleMyNameInput.setValue(""); roleOtherInput.setValue("")
  }

  // 保存 URL
  function handleSaveUrl(id: EndpointId) {
    const inputMap = { longcat: longcatUrlInput, siliconflow: siliconflowUrlInput, custom: customUrlInput }
    const savedMap = { longcat: longcatUrl, siliconflow: siliconflowUrl, custom: customUrl }
    const v = inputMap[id].value.trim()
    if (!v) { error.setValue("请输入 API 地址"); return }
    setEndpointUrl(id, v)
    savedMap[id].setValue(v)
    inputMap[id].setValue("")
    error.setValue("")
  }

  // 保存模型名称
  function handleSaveModel(id: EndpointId) {
    const inputMap = { longcat: longcatModelInput, siliconflow: siliconflowModelInput, custom: customModelInput }
    const savedMap = { longcat: longcatModel, siliconflow: siliconflowModel, custom: customModel }
    const v = inputMap[id].value.trim()
    if (!v) { error.setValue("请输入模型名称"); return }
    setEndpointModel(id, v)
    savedMap[id].setValue(v)
    inputMap[id].setValue("")
    error.setValue("")
  }

  // 保存心里话（合并为单个字段）
  function handleSaveThoughts() {
    const v = innerThoughtsInput.value.trim()
    if (!v) { error.setValue("请先输入你的想法"); return }
    innerThoughts.setValue(v)
    innerThoughtsInput.setValue("")
    error.setValue("")
  }

  // 清除心里话
  function handleClearThoughts() {
    innerThoughts.setValue(""); innerThoughtsInput.setValue("")
  }

  // 保存 API Key — 正确读取各自的 Observable
  function handleSaveKey(id: EndpointId) {
    const keyObsMap = {
      longcat: longcatKey,
      siliconflow: siliconflowKey,
      custom: customKey,
    }
    const maskObsMap = {
      longcat: longcatMask,
      siliconflow: siliconflowMask,
      custom: customMask,
    }
    const v = keyObsMap[id].value.trim()
    if (!v) { error.setValue("请输入 API Key"); return }
    const ok = setEndpointApiKey(id, v)
    if (!ok) { error.setValue("保存失败，请重试"); return }
    keyObsMap[id].setValue("")
    maskObsMap[id].setValue(maskKey(getEndpointApiKey(id)))
    bumpKC()
    error.setValue("")
  }

  function handleClearKey(id: EndpointId) {
    setEndpointApiKey(id, "")
    const maskObsMap = { longcat: longcatMask, siliconflow: siliconflowMask, custom: customMask }
    maskObsMap[id].setValue(maskKey(null))
    bumpKC()
  }

  // ── 渲染 ──
  const { urlObs, urlInputObs, modelObs, modelInputObs, keyObs, maskObs } = getActiveObservables()

  return (
    <NavigationStack>
      <Lst navigationTitle="微信聊天AI助手" navigationBarTitleDisplayMode="inline">

        {/* 状态卡片 */}
        <Sec>
          <StatusCard status={status} isLoading={isLoading} error={error}
            chatDate={parsedResult.value?.date ?? ""}
            messageCount={parsedResult.value?.totalCount ?? 0}
            participants={parsedResult.value?.participants ?? []} />
        </Sec>

        {/* 剪贴板操作 */}
        <Sec
          header={<SectionHeader title="聊天记录" />}
          footer={
            <T font="caption" foregroundStyle="secondaryLabel">
              在微信中复制聊天记录后，推荐直接长按下方文本框「粘贴」（比自动获取更稳定）。也可点击「自动获取剪贴板」尝试自动读取（已加入多次重试，但部分机型仍可能不完整）。
            </T>
          }
        >
          <VS spacing={10}>
            <Btn
              action={handleGetClipboard}
              buttonStyle="bordered"
              controlSize="large"
              tint="#0D9488"
              frame={{ maxWidth: "infinity" }}
            >
              <HS spacing={8} alignment="center" frame={{ maxWidth: "infinity" }}>
                <Img systemName="doc.on.clipboard" font="title3" foregroundStyle="#0D9488" />
                <T font="body" fontWeight="medium" foregroundStyle="#0D9488" lineLimit={1}>自动获取剪贴板（尝试3次）</T>
              </HS>
            </Btn>
            <VS spacing={6}>
              <T font="caption" fontWeight="medium" foregroundStyle="secondaryLabel" textCase="uppercase" kerning={0.6}>
                手动粘贴（推荐，更可靠）
              </T>
              <TF
                value={clipboardText.value}
                onChanged={(v: string) => clipboardText.setValue(v)}
                placeholder="长按此处「粘贴」，比自动获取更稳定"
                multiline
              />
              <HS spacing={10}>
                <Btn
                  action={handleParseText}
                  buttonStyle="borderedProminent"
                  controlSize="regular"
                  tint="#0D9488"
                  frame={{ maxWidth: "infinity" }}
                >
                  <HS spacing={6} alignment="center" frame={{ maxWidth: "infinity" }}>
                    <Img systemName="magnifyingglass" font="body" foregroundStyle="white" />
                    <T font="subheadline" fontWeight="semibold" foregroundStyle="white">解析聊天记录</T>
                  </HS>
                </Btn>
              </HS>
              {clipboardText.value ? (
                <HS spacing={10}>
                  <Btn
                    action={handleDiagnoseRaw}
                    buttonStyle="bordered"
                    controlSize="regular"
                    tint="#F59E0B"
                  >
                    <HS spacing={6} alignment="center">
                      <Img systemName="stethoscope" font="body" foregroundStyle="#F59E0B" />
                      <T font="subheadline" fontWeight="medium" foregroundStyle="#F59E0B">查看原始格式</T>
                    </HS>
                  </Btn>
                </HS>
              ) : null}
              {rawDiagnosis.value ? (
                <VS spacing={4} padding={10}
                  background={{ style: "secondarySystemFill" as any, shape: { type: "rect", cornerRadius: 10 } as any }}>
                  <T font="caption2" fontWeight="bold" foregroundStyle="secondaryLabel">原始格式诊断（可长按复制发给开发者）</T>
                  <T font="caption2" foregroundStyle="label" fontDesign="monospaced" textSelection>{rawDiagnosis.value}</T>
                </VS>
              ) : null}
            </VS>
          </VS>
        </Sec>

        {/* 解析结果 */}
        {parsedResult.value ? (
          <Sec
            header={
              <HS spacing={8} alignment="center">
                <T font="subheadline" fontWeight="semibold" foregroundStyle="label">解析结果</T>
                <Cap fill="#34D399" frame={{ width: 6, height: 6 }} />
                <T font="caption" foregroundStyle="secondaryLabel">
                  {parsedResult.value.date} · {parsedResult.value.totalCount} 条 · {parsedResult.value.participants.length} 人
                </T>
              </HS>
            }
          >
            <ChatMessageList messages={parsedResult.value.messages} />
            <Divider />
            <HS spacing={10} padding={{ vertical: 8 }}>
              <Btn
                action={handleGenerateReplies}
                buttonStyle="borderedProminent"
                controlSize="large"
                tint="#6366F1"
                frame={{ maxWidth: "infinity" }}
                disabled={isLoading.value}
              >
                <HS spacing={8} alignment="center" frame={{ maxWidth: "infinity" }}>
                  <Img systemName="sparkles" font="title3" foregroundStyle="white" />
                  <T font="body" fontWeight="semibold" foregroundStyle="white" lineLimit={1}>
                    {isLoading.value ? "AI 正在思考..." : "生成 AI 回复"}
                  </T>
                </HS>
              </Btn>
            </HS>
          </Sec>
        ) : null}

        {/* ── 角色确认面板：解析后展示，让用户选"我是谁"和对方身份 ── */}
        {showRoleSetup.value && parsedResult.value ? (
          <Sec header={<SectionHeader title="👤 确认聊天角色" />}
            footer={<T font="caption" foregroundStyle="secondaryLabel">选择聊天记录中你的名字，并告诉 AI 对方是谁，回复会更准确</T>}
          >
            <VS spacing={10} padding={{ vertical: 8 }}>
              {/* 我是谁：纵向列出所有参与者，逐行点选（避免横向排列在多人时挤出屏幕） */}
              <VS spacing={6}>
                <T font="caption" fontWeight="medium" foregroundStyle="secondaryLabel" textCase="uppercase" kerning={0.6}>
                  我是聊天中的哪位？（共 {parsedResult.value.participants.length} 人）
                </T>
                <VS spacing={6}>
                  {parsedResult.value.participants.map(name => {
                    const isSelected = roleMyNameInput.value === name
                    return (
                      <Btn
                        key={name}
                        action={() => roleMyNameInput.setValue(name)}
                        buttonStyle={isSelected ? "borderedProminent" : "bordered"}
                        controlSize="large"
                        tint={isSelected ? "#6366F1" : "#94A3B8"}
                        frame={{ maxWidth: "infinity" }}
                      >
                        <HS spacing={8} alignment="center" frame={{ maxWidth: "infinity" }}>
                          {isSelected ? (
                            <Img systemName="checkmark.circle.fill" font="body" foregroundStyle="white" />
                          ) : (
                            <Img systemName="circle" font="body" foregroundStyle="#94A3B8" />
                          )}
                          <T font="subheadline" fontWeight={isSelected ? "semibold" : "medium"}
                            foregroundStyle={isSelected ? "white" : "label"}>
                            {name}
                          </T>
                          <Spacer />
                        </HS>
                      </Btn>
                    )
                  })}

                  <Divider />

                  {/* 特殊选项：用户不在这段对话里（比如旁观转发记录、帮别人看聊天） */}
                  {(() => {
                    const isObserverSelected = roleMyNameInput.value === OBSERVER_MARK
                    return (
                      <Btn
                        action={() => roleMyNameInput.setValue(OBSERVER_MARK)}
                        buttonStyle={isObserverSelected ? "borderedProminent" : "bordered"}
                        controlSize="large"
                        tint={isObserverSelected ? "#F59E0B" : "#94A3B8"}
                        frame={{ maxWidth: "infinity" }}
                      >
                        <HS spacing={8} alignment="center" frame={{ maxWidth: "infinity" }}>
                          {isObserverSelected ? (
                            <Img systemName="checkmark.circle.fill" font="body" foregroundStyle="white" />
                          ) : (
                            <Img systemName="eye" font="body" foregroundStyle="#94A3B8" />
                          )}
                          <T font="subheadline" fontWeight={isObserverSelected ? "semibold" : "medium"}
                            foregroundStyle={isObserverSelected ? "white" : "label"}>
                            我不在这段对话里（旁观/帮别人看）
                          </T>
                          <Spacer />
                        </HS>
                      </Btn>
                    )
                  })()}
                </VS>
                {roleMyNameInput.value === OBSERVER_MARK ? (
                  <T font="caption" foregroundStyle="#F59E0B">
                    ✓ 已选：旁观模式，AI 会把对话中所有人都当作"对方"，回复建议会以旁观者视角给出
                  </T>
                ) : roleMyNameInput.value ? (
                  <T font="caption" foregroundStyle="#6366F1">
                    ✓ 已选：{roleMyNameInput.value}，其余参与者将作为对方
                  </T>
                ) : (
                  <T font="caption" foregroundStyle="#F87171">
                    请从上方点选你自己的名字，或选择「我不在这段对话里」
                  </T>
                )}
              </VS>

              {/* 对方是谁：文本输入 */}
              <VS spacing={4}>
                <T font="caption" fontWeight="medium" foregroundStyle="secondaryLabel" textCase="uppercase" kerning={0.6}>
                  对方的身份（可选）
                </T>
                <TF
                  title="对方身份"
                  labelsHidden
                  placeholder="例如：上司、喜欢的人、好朋友、客户..."
                  value={roleOtherInput.value}
                  onChanged={(v: string) => roleOtherInput.setValue(v)}
                />
              </VS>

              {/* 确认按钮 */}
              <Btn
                action={handleConfirmRole}
                buttonStyle="borderedProminent"
                controlSize="large"
                tint="#6366F1"
                frame={{ maxWidth: "infinity" }}
              >
                <HS spacing={8} alignment="center" frame={{ maxWidth: "infinity" }}>
                  <Img systemName="checkmark.circle.fill" font="title3" foregroundStyle="white" />
                  <T font="body" fontWeight="semibold" foregroundStyle="white">确认角色，开始回复</T>
                </HS>
              </Btn>
            </VS>
          </Sec>
        ) : null}

        {/* ── 角色已确认后显示摘要 ── */}
        {roleSetup.value ? (
          <Sec>
            <HS spacing={8} padding={{ vertical: 6 }} alignment="center">
              <Img
                systemName={roleSetup.value.isObserver ? "eye.fill" : "person.2.fill"}
                font="body"
                foregroundStyle={roleSetup.value.isObserver ? "#F59E0B" : "#6366F1"}
              />
              {roleSetup.value.isObserver ? (
                <T font="footnote" foregroundStyle="secondaryLabel">
                  <T font="footnote" fontWeight="semibold" foregroundStyle="label">旁观模式</T>
                  {"（不在对话中）"}
                </T>
              ) : (
                <T font="footnote" foregroundStyle="secondaryLabel">
                  我：<T font="footnote" fontWeight="semibold" foregroundStyle="label">{roleSetup.value.myName}</T>
                  {roleSetup.value.otherRole ? (
                    <T font="footnote" foregroundStyle="secondaryLabel">
                      {"  ·  对方："}
                      <T font="footnote" fontWeight="semibold" foregroundStyle="label">{roleSetup.value.otherRole}</T>
                    </T>
                  ) : null}
                </T>
              )}
              <Spacer />
              <Btn
                action={() => showRoleSetup.setValue(true)}
                buttonStyle="borderless"
                controlSize="small"
                tint="#6366F1"
              >
                <T font="caption" foregroundStyle="#6366F1">修改</T>
              </Btn>
            </HS>
          </Sec>
        ) : null}

        {/* 心里话 — 合并为单个普通文本框（非密码框） */}
        <Sec
          header={<SectionHeader title="💭 你的心里话（可选）" />}
          footer={<T font="caption" foregroundStyle="secondaryLabel">告诉 AI 你当时的真实想法、感受或前因后果，AI 会据此给出更贴合你的回复建议</T>}
        >
          <VS spacing={8} padding={{ vertical: 8 }}>
            <TF
              title="心里话"
              labelsHidden
              placeholder="例如：其实我很开心，但不知道怎么回；或者：她是我上司，我不想太随意..."
              value={innerThoughtsInput.value}
              onChanged={(v: string) => innerThoughtsInput.setValue(v)}
              multiline
              numberOfLines={4}
            />
            {innerThoughts.value ? (
              <VS spacing={2} padding={{ horizontal: 10, vertical: 6 }}
                background={{ style: "secondarySystemFill" as any, shape: { type: "rect", cornerRadius: 8 } as any }}>
                <T font="caption2" foregroundStyle="secondaryLabel">当前 AI 参考内容</T>
                <T font="footnote" foregroundStyle="label" lineLimit={3}>{innerThoughts.value}</T>
              </VS>
            ) : null}
            <HS spacing={10}>
              <Btn
                action={handleSaveThoughts}
                buttonStyle="borderedProminent"
                controlSize="regular"
                tint="#6366F1"
                frame={{ maxWidth: "infinity" }}
              >
                <HS spacing={6} alignment="center" frame={{ maxWidth: "infinity" }}>
                  <Img systemName="checkmark.circle.fill" font="body" foregroundStyle="white" />
                  <T font="subheadline" fontWeight="semibold" foregroundStyle="white">保存想法</T>
                </HS>
              </Btn>
              <Btn
                action={handleClearThoughts}
                buttonStyle="bordered"
                controlSize="regular"
                tint="#94A3B8"
              >
                <HS spacing={6} alignment="center">
                  <Img systemName="trash.fill" font="body" foregroundStyle="#EF4444" />
                  <T font="subheadline" fontWeight="medium" foregroundStyle="#94A3B8">清除</T>
                </HS>
              </Btn>
            </HS>
          </VS>
        </Sec>

        {/* 安慰/开导窗口 —— 完全 AI 生成 */}
        {comfortMsg.value ? (
          <Sec>
            <ComfortCard message={comfortMsg} />
          </Sec>
        ) : null}

        {/* AI 总结 */}
        {chatSummary.value ? (
          <Sec header={<SectionHeader title="📝 AI 聊天总结" />}>
            <VS
              spacing={8}
              padding={12}
              background={{ style: "secondarySystemFill", shape: { type: "rect", cornerRadius: 12 } as any }}
            >
              <T font="footnote" foregroundStyle="label" lineLimit={4}>{chatSummary.value}</T>
            </VS>
          </Sec>
        ) : null}

        {/* 回复选项 */}
        {replyOptions.value.length > 0 ? (
          <Sec
            header={<SectionHeader title={`💡 回复建议（${replyOptions.value.length}条）`} />}
            footer={
              <T font="caption" foregroundStyle="secondaryLabel">点击「复制」即可复制回复到剪贴板，然后粘贴到微信</T>
            }
          >
            <VS spacing={10}>
              {replyOptions.value.map(opt => (
                <ReplyOptionCard
                  key={opt.id}
                  option={opt}
                  isSelected={selectedReplyId.value === opt.id}
                  onSelect={() => selectedReplyId.setValue(opt.id)}
                  onCopy={() => handleCopyReply(opt.content)}
                />
              ))}
            </VS>
          </Sec>
        ) : null}

        {/* 接口配置 */}
        <Sec
          header={<SectionHeader title="🔌 接口配置" />}
          footer={
            <T font="caption" foregroundStyle="secondaryLabel">
              选择要使用的 AI 接口。每个接口有独立的 URL、API Key 和模型配置，保存在 Keychain 中。
            </T>
          }
        >
          {/* 接口选择标签 */}
          <HS spacing={8} padding={{ vertical: 6 }}>
            {ENDPOINTS.map(id => {
              const labels: Record<EndpointId, string> = {
                longcat: "🐱 LongCat",
                siliconflow: "⚡ 硅基流动",
                custom: "🔧 自定义",
              }
              const isActive = activeEndpoint.value === id
              return (
                <Btn
                  key={id}
                  action={() => activeEndpoint.setValue(id)}
                  buttonStyle={isActive ? "borderedProminent" : "bordered"}
                  controlSize="regular"
                  tint={isActive ? "#6366F1" : "#94A3B8"}
                >
                  <T
                    font="subheadline"
                    fontWeight={isActive ? "semibold" : "medium"}
                    foregroundStyle={isActive ? "white" : "#94A3B8"}
                  >
                    {labels[id]}
                  </T>
                </Btn>
              )
            })}
          </HS>

          {/* 当前选中接口的配置 */}
          <VS spacing={10} padding={{ vertical: 8 }}>

            {/* API URL */}
            <VS spacing={4}>
              <HS spacing={8} alignment="center">
                <T font="caption" fontWeight="medium" foregroundStyle="secondaryLabel" textCase="uppercase" kerning={0.6}>
                  API 地址
                </T>
                <Spacer />
                <T font="caption" fontWeight="medium" foregroundStyle="secondaryLabel" monospacedDigit>
                  {urlObs.value ? "已配置" : "未配置"}
                </T>
              </HS>
              <TF
                title="API 地址"
                labelsHidden
                placeholder="https://api.xxx.com/v1/chat/completions"
                value={urlInputObs.value}
                onChanged={(v: string) => urlInputObs.setValue(v)}
                autocorrectionDisabled
                textInputAutocapitalization="never"
              />
              {urlObs.value ? (
                <VS spacing={2} padding={{ horizontal: 10, vertical: 6 }}
                  background={{ style: "secondarySystemFill" as any, shape: { type: "rect", cornerRadius: 8 } as any }}>
                  <T font="caption2" foregroundStyle="secondaryLabel">当前地址</T>
                  <T font="caption" foregroundStyle="label" fontDesign="monospaced" lineLimit={1} truncationMode="middle">
                    {urlObs.value}
                  </T>
                </VS>
              ) : null}
              <Btn
                action={() => handleSaveUrl(activeEndpoint.value)}
                buttonStyle="borderedProminent"
                controlSize="regular"
                tint="#0D9488"
                frame={{ maxWidth: "infinity" }}
              >
                <HS spacing={6} alignment="center" frame={{ maxWidth: "infinity" }}>
                  <Img systemName="link.badge.plus" font="body" foregroundStyle="white" />
                  <T font="subheadline" fontWeight="semibold" foregroundStyle="white">保存地址</T>
                </HS>
              </Btn>
            </VS>

            <Divider />

            {/* 模型名称 */}
            <VS spacing={4}>
              <HS spacing={8} alignment="center">
                <T font="caption" fontWeight="medium" foregroundStyle="secondaryLabel" textCase="uppercase" kerning={0.6}>
                  模型名称
                </T>
                <Spacer />
                <T font="caption" fontWeight="medium" foregroundStyle="secondaryLabel" monospacedDigit>
                  {modelObs.value ? "已配置" : "未配置"}
                </T>
              </HS>
              <TF
                title="模型名称"
                labelsHidden
                placeholder="例如：gpt-4o / deepseek-chat"
                value={modelInputObs.value}
                onChanged={(v: string) => modelInputObs.setValue(v)}
                autocorrectionDisabled
                textInputAutocapitalization="never"
              />
              {modelObs.value ? (
                <VS spacing={2} padding={{ horizontal: 10, vertical: 6 }}
                  background={{ style: "secondarySystemFill" as any, shape: { type: "rect", cornerRadius: 8 } as any }}>
                  <T font="caption2" foregroundStyle="secondaryLabel">当前模型</T>
                  <T font="caption" foregroundStyle="label" fontDesign="monospaced" lineLimit={1}>
                    {modelObs.value}
                  </T>
                </VS>
              ) : null}
              <Btn
                action={() => handleSaveModel(activeEndpoint.value)}
                buttonStyle="borderedProminent"
                controlSize="regular"
                tint="#0D9488"
                frame={{ maxWidth: "infinity" }}
              >
                <HS spacing={6} alignment="center" frame={{ maxWidth: "infinity" }}>
                  <Img systemName="cpu.fill" font="body" foregroundStyle="white" />
                  <T font="subheadline" fontWeight="semibold" foregroundStyle="white">保存模型</T>
                </HS>
              </Btn>
            </VS>

            <Divider />

            {/* API Key */}
            <VS spacing={4}>
              <HS spacing={8} alignment="center">
                <T font="caption" fontWeight="medium" foregroundStyle="secondaryLabel" textCase="uppercase" kerning={0.6}>
                  API Key
                </T>
                <Spacer />
                <Cap
                  fill={getEndpointApiKey(activeEndpoint.value) ? "#34D399" : "#94A3B8"}
                  frame={{ width: 6, height: 6 }}
                />
                <T font="caption" fontWeight="medium" foregroundStyle="secondaryLabel" monospacedDigit>
                  {maskObs.value}
                </T>
              </HS>
              <SF
                title="API Key"
                labelsHidden
                placeholder="sk-..."
                value={keyObs.value}
                onChanged={(v: string) => keyObs.setValue(v)}
              />
              <HS spacing={10}>
                <Btn
                  action={() => handleSaveKey(activeEndpoint.value)}
                  buttonStyle="borderedProminent"
                  controlSize="regular"
                  tint="#0D9488"
                  frame={{ maxWidth: "infinity" }}
                >
                  <HS spacing={6} alignment="center" frame={{ maxWidth: "infinity" }}>
                    <Img systemName="lock.fill" font="body" foregroundStyle="white" />
                    <T font="subheadline" fontWeight="semibold" foregroundStyle="white">保存 Key</T>
                  </HS>
                </Btn>
                <Btn
                  action={() => handleClearKey(activeEndpoint.value)}
                  buttonStyle="bordered"
                  controlSize="regular"
                  tint="#94A3B8"
                >
                  <HS spacing={6} alignment="center">
                    <Img systemName="trash.fill" font="body" foregroundStyle="#EF4444" />
                    <T font="subheadline" fontWeight="medium" foregroundStyle="#94A3B8">清除</T>
                  </HS>
                </Btn>
              </HS>
            </VS>
          </VS>
        </Sec>

        {/* 高级设置 */}
        <Sec header={<SectionHeader title="⚙️ 高级设置" />}>
          <SliderRow
            title="回复数量"
            valueObservable={replyCount}
            min={3} max={10} step={1} unit=" 条"
          />
          <SliderRow
            title="温度 (Temperature)"
            valueObservable={temperature}
            min={0} max={1.5} step={0.1} unit=""
            formatter={(v) => v.toFixed(1)}
          />
          <SliderRow
            title="最大 Tokens"
            valueObservable={maxTokens}
            min={500} max={8000} step={500} unit=""
          />
          {/* 【修复】Toggle 的 value 传 Observable，isOn 属性名按框架规范 */}
          <Tg isOn={showComfort} title="生成时显示 AI 安慰/开导话语" />
        </Sec>

        {/* 清除 */}
        <Sec>
          <Btn
            action={handleClear}
            buttonStyle="bordered"
            controlSize="regular"
            tint="#EF4444"
            frame={{ maxWidth: "infinity" }}
          >
            <HS spacing={6} alignment="center" frame={{ maxWidth: "infinity" }}>
              <Img systemName="eraser.fill" font="body" foregroundStyle="#EF4444" />
              <T font="subheadline" fontWeight="medium" foregroundStyle="#EF4444">清除所有数据</T>
            </HS>
          </Btn>
        </Sec>

        {/* 说明 */}
        <Sec header={<SectionHeader title="使用说明" />}>
          <T font="footnote" foregroundStyle="secondaryLabel" lineLimit={8}>
            本助手通过剪贴板读取微信聊天记录，使用 AI 分析聊天内容，提供多种风格的回复和 AI 生成的个性化安慰语。{"\n"}
            步骤：① 微信复制聊天记录 → ② 点击「获取并解析」→ ③ 可选：写下心里话和背景 → ④「生成 AI 回复」→ ⑤ 选择并复制
          </T>
          <HS spacing={8} padding={{ vertical: 4 }}>
            <T font="footnote" foregroundStyle="secondaryLabel">脚本目录：</T>
            <T
              font="footnote"
              foregroundStyle="tertiaryLabel"
              fontDesign="monospaced"
              lineLimit={1}
              truncationMode="middle"
            >
              {Script.directory}
            </T>
          </HS>
        </Sec>

      </Lst>
    </NavigationStack>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// 7. 子组件
// ───────────────────────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <T font="subheadline" fontWeight="semibold" foregroundStyle="#6366F1">{title}</T>
  )
}

function StatusCard(props: {
  status: ReturnType<typeof useObservable<string>>
  isLoading: ReturnType<typeof useObservable<boolean>>
  error: ReturnType<typeof useObservable<string>>
  chatDate: string
  messageCount: number
  participants: string[]
}) {
  const statusLabel =
    props.status.value === "loading" ? "处理中"
    : props.status.value === "success" ? "已生成"
    : props.status.value === "error" ? "出错了"
    : "待操作"
  const statusColor =
    props.status.value === "loading" ? "#60A5FA"
    : props.status.value === "success" ? "#34D399"
    : props.status.value === "error" ? "#F87171"
    : "#94A3B8"

  return (
    <ZS alignment="topLeading">
      <Round
        cornerRadius={16}
        fill={{
          gradient: [
            { color: "#4F46E5", location: 0 },
            { color: "#6366F1", location: 0.5 },
            { color: "#818CF8", location: 1 },
          ],
          startPoint: { x: 0, y: 0 },
          endPoint: { x: 1, y: 1 },
        }}
        frame={{ minHeight: 100, maxWidth: "infinity" }}
      />
      <VS alignment="leading" spacing={8} padding={14}>
        <HS spacing={8} alignment="center">
          <Cap fill={statusColor} frame={{ width: 8, height: 8 }} />
          <T font="caption" fontWeight="semibold" foregroundStyle="white" textCase="uppercase" kerning={1}>
            {statusLabel}
          </T>
          <Spacer />
          {props.messageCount > 0 && (
            <T font="caption" foregroundStyle="white" opacity={0.8} monospacedDigit>
              {props.chatDate} · {props.messageCount} 条
            </T>
          )}
        </HS>
        {props.participants.length > 0 && (
          <HS spacing={6} alignment="center">
            <T font="caption2" foregroundStyle="white" opacity={0.6} textCase="uppercase" kerning={0.5}>参与者</T>
            <T font="footnote" foregroundStyle="white" opacity={0.9} lineLimit={1}>
              {props.participants.join(" · ")}
            </T>
          </HS>
        )}
        {props.error.value ? (
          <VS
            spacing={4}
            padding={{ horizontal: 10, vertical: 8 }}
            background={{ style: "#F87171" as any, shape: { type: "rect", cornerRadius: 10 } as any }}
          >
            <T font="caption2" fontWeight="bold" foregroundStyle="white" opacity={0.85}>⚠︎ 出错详情（可长按复制）</T>
            <T font="caption" fontWeight="medium" foregroundStyle="white" lineLimit={10} textSelection>
              {props.error.value}
            </T>
          </VS>
        ) : null}
      </VS>
    </ZS>
  )
}

function ChatMessageList({ messages }: { messages: ChatMessage[] }) {
  const visible = messages.slice(-15)
  return (
    <VS spacing={6}>
      {messages.length > 15 && (
        <T font="caption" foregroundStyle="tertiaryLabel" alignment="center">
          （显示最近 15 条，共 {messages.length} 条）
        </T>
      )}
      {visible.map(m => <ChatMessageRow key={m.id} message={m} />)}
    </VS>
  )
}

function ChatMessageRow({ message }: { message: ChatMessage }) {
  const isMe = message.isUser
  const bgColor = isMe ? "systemBlue" as any : "secondarySystemFill" as any
  const textColor = isMe ? "white" as any : "label" as any
  return (
    <HS
      spacing={8}
      alignment={isMe ? "trailing" : "leading"}
      frame={{ maxWidth: "infinity", alignment: isMe ? "trailing" : "leading" }}
    >
      <VS
        alignment={isMe ? "trailing" : "leading"}
        spacing={2}
        padding={{ horizontal: 10, vertical: 6 }}
        background={{ style: bgColor, shape: { type: "rect", cornerRadius: 12 } as any }}
        frame={{ maxWidth: "80%" }}
      >
        {!isMe && (
          <T font="caption2" fontWeight="semibold" foregroundStyle={textColor} opacity={0.7}>
            {message.sender}
          </T>
        )}
        <T font="footnote" foregroundStyle={textColor} lineLimit={5}>{message.content}</T>
        <T font="caption2" foregroundStyle={textColor} opacity={0.5} monospacedDigit>
          {formatTime(message.timestamp)}
        </T>
      </VS>
    </HS>
  )
}

function ComfortCard({ message }: { message: ReturnType<typeof useObservable<string>> }) {
  return (
    <ZS alignment="topLeading">
      <Round
        cornerRadius={16}
        fill={{
          gradient: [
            { color: "#7C3AED", location: 0 },
            { color: "#8B5CF6", location: 0.5 },
            { color: "#A78BFA", location: 1 },
          ],
          startPoint: { x: 0, y: 0 },
          endPoint: { x: 1, y: 1 },
        }}
        frame={{ minHeight: 80, maxWidth: "infinity" }}
      />
      <VS alignment="leading" spacing={6} padding={14}>
        <HS spacing={6} alignment="center">
          <T font="title3">🌸</T>
          <T font="caption" fontWeight="semibold" foregroundStyle="white" textCase="uppercase" kerning={1}>
            给你一点温暖
          </T>
          <T font="caption2" foregroundStyle="white" opacity={0.6}>· AI 专属生成</T>
        </HS>
        <T font="body" fontWeight="medium" foregroundStyle="white" lineLimit={4}>{message.value}</T>
      </VS>
    </ZS>
  )
}

function ReplyOptionCard(props: {
  option: ReplyOption
  isSelected: boolean
  onSelect: () => void
  onCopy: () => void
}) {
  const { option } = props
  const color = styleColor(option.style)
  const emoji = styleEmoji(option.style)
  const bgColor = props.isSelected ? (color + "15") as any : "secondarySystemFill" as any
  return (
    <VS
      alignment="leading"
      spacing={8}
      padding={12}
      background={{ style: bgColor, shape: { type: "rect", cornerRadius: 12 } as any }}
    >
      <HS spacing={8} alignment="center">
        <T font="title3">{emoji}</T>
        <T font="caption" fontWeight="semibold" foregroundStyle={color} textCase="uppercase" kerning={0.5}>
          {styleLabel(option.style)}
        </T>
        <Spacer />
        <Btn
          action={props.onCopy}
          buttonStyle="borderedProminent"
          controlSize="small"
          tint={color}
        >
          <HS spacing={4} alignment="center">
            <Img systemName="doc.on.doc.fill" font="caption" foregroundStyle="white" />
            <T font="caption" fontWeight="semibold" foregroundStyle="white">复制</T>
          </HS>
        </Btn>
      </HS>
      <T font="body" foregroundStyle="label" lineLimit={3}>{option.content}</T>
    </VS>
  )
}

function SliderRow(props: {
  title: string
  valueObservable: ReturnType<typeof useObservable<number>>
  min: number
  max: number
  step?: number
  unit?: string
  formatter?: (v: number) => string
}) {
  const fmt = props.formatter ?? ((v: number) => `${v}`)
  const display = `${fmt(props.valueObservable.value)}${props.unit ?? ""}`
  return (
    <VS alignment="leading" spacing={6}>
      <HS>
        <T font="subheadline">{props.title}</T>
        <Spacer />
        <T font="footnote" foregroundStyle="#6366F1" monospacedDigit fontWeight="semibold">{display}</T>
      </HS>
      <Slider value={props.valueObservable} min={props.min} max={props.max} step={props.step ?? 1} />
    </VS>
  )
}

// ───────────────────────────────────────────────────────────────────────────
// 8. 启动
// ───────────────────────────────────────────────────────────────────────────

async function run() {
  await Navigation.present({ element: <App />, modalPresentationStyle: "pageSheet" })
  Script.exit()
}

run()
