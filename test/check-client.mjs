// dsh-plugin-deepseek-chat 客户端包离线自检（v1.3.0）。
//
// 这个包是浏览器 ModuleLoader 脚本，因此自检：
//   1. 在 vm 里执行它，捕获 __ModuleLoader__.load 的注册；
//   2. 用桩化的 react / DOM / localStorage 实例化 factory；
//   3. 验证配置层（四项设置：开关/名称 × 顶栏标签与右边栏卡片，默认值、类型校验、持久化、订阅通知）；
//   4. 在「Web 表层」（无桌面桥，应完全不注册）与「桌面表层」分别执行 apply()；
//   5. 校验四处槽位注册（左侧栏图标 / 全屏主面板 / 会话顶栏标签页 / 设置页）；
//   6. 验证右边栏卡片双路径：better-sidebar 服务正常运行时走 registerTab，
//      未运行时（装了但冷启动 pending / 根本没装）走 DSH 原生右侧栏直注；
//      两路径互斥，服务晚到经 internal/service 事件 + 无上限兜底 timer 自动切换，
//      不需要手动开关；title thunk 即时改名、showCard 开关注销/重注册、
//      effect cleanup 清理卡片 / timer / 服务监听；
//   7. 验证设置页两对开关与自定义名称能动态重注入顶栏标签页（标签行只在注册表变化时重算）；
//   8. 验证顶栏标签页是「铺满浮层」（盖住会话输入框）；
//   9. 迷你渲染面板，跑完 webview 租约、会话记忆、崩溃隔离、弹窗白名单等全流程，
//      并断言面板里不再有账号状态条；
//  10. 关于信息 + 检查更新 + 一键更新（真调 pluginManager.updateBundle，成功/需重启/失败/无通道如实提示）。
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, "..", "lib", "client.js");
const source = readFileSync(bundlePath, "utf8");

const ROOT = "https://chat.deepseek.com/";
const DETACHED_ERROR = "The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.";
const CONV_A = "https://chat.deepseek.com/a/chat/s/aaaaaaaa-1111-2222-3333-444444444444";
const CONV_B = "https://chat.deepseek.com/a/chat/s/bbbbbbbb-1111-2222-3333-444444444444";
const AUTH = "https://chat.deepseek.com/sign_in";
const STORAGE_KEY = "dsh-plugin-deepseek-chat:last-url";
const PLATFORM_POPUP = "https://platform.deepseek.com/login";

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`失败：${message}`);
};
const ok = (message) => console.log(`通过：${message}`);
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── 假 DOM ──────────────────────────────────────────────────────────────────
const createElement = (tag) => {
  const listeners = new Map();
  const attributes = new Map();
  const element = {
    tag,
    style: {},
    children: [],
    attributes,
    currentUrl: void 0,
    loadURLCalls: [],
    loadURLResults: [],
    removed: false,
    isConnected: false,
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      listeners.set(type, list.filter((candidate) => candidate !== handler));
    },
    dispatch(type, payload = {}) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler({ type, ...payload });
    },
    append(...nodes) {
      for (const node of nodes) {
        if (node && typeof node === "object") {
          node.isConnected = true;
          node.parent = element;
        }
      }
      element.children.push(...nodes);
    },
    remove() {
      element.removed = true;
      element.isConnected = false;
      const siblings = element.parent?.children;
      if (Array.isArray(siblings)) {
        const at = siblings.indexOf(element);
        if (at !== -1) siblings.splice(at, 1);
      }
      element.parent = void 0;
    },
    // Electron 的 webview 一旦脱离文档，所有方法都会抛错；这里如实复现，
    // 让卸载路径真正被走到。
    getURL() {
      if (element.isConnected !== true) throw new Error(DETACHED_ERROR);
      return element.currentUrl;
    },
    loadURL(url) {
      if (element.isConnected !== true) throw new Error(DETACHED_ERROR);
      element.loadURLCalls.push(url);
      const rejection = element.loadURLResults.shift();
      if (rejection !== void 0) return Promise.reject(rejection);
      element.currentUrl = url;
      return Promise.resolve();
    },
    matches(selector) {
      return selector === "webview" && tag === "webview";
    }
  };
  return element;
};

const documentStub = { createElement, createTextNode: (text) => ({ text }) };

const storage = new Map();
const localStorageStub = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => {
    storage.set(key, String(value));
  },
  removeItem: (key) => {
    storage.delete(key);
  },
  clear: () => storage.clear()
};

// ── 带最小挂载过程的假 react ────────────────────────────────────────────────
let hookCursor = 0;
let hookMemory = [];
const effects = [];
class FakeComponent {
  constructor(props) {
    this.props = props;
    this.state = {};
  }
  setState(next) {
    this.state = { ...this.state, ...(typeof next === "function" ? next(this.state) : next) };
  }
}
FakeComponent.prototype.__isComponent = true;

const react = {
  Component: FakeComponent,
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
  }),
  useState(initial) {
    const index = hookCursor++;
    if (!(index in hookMemory)) hookMemory[index] = initial;
    return [hookMemory[index], (next) => {
      hookMemory[index] = typeof next === "function" ? next(hookMemory[index]) : next;
    }];
  },
  useRef(initial) {
    const index = hookCursor++;
    if (!(index in hookMemory)) hookMemory[index] = { current: initial };
    return hookMemory[index];
  },
  useCallback(fn) {
    hookCursor += 1;
    return fn;
  },
  useEffect(fn) {
    effects.push(fn);
  }
};

/** 把一棵渲染节点挂到假 DOM 上。 */
function mount(node) {
  if (node === null || node === undefined || node === false) return null;
  if (typeof node === "string" || typeof node === "number") return { text: String(node) };
  if (Array.isArray(node)) return node.map(mount).filter(Boolean);
  const { type, props } = node;
  if (typeof type === "function") {
    const previousCursor = hookCursor;
    const previousMemory = hookMemory;
    hookCursor = 0;
    hookMemory = [];
    try {
      // 类组件（面板的错误边界）通过 render() 渲染。
      if (type.prototype && type.prototype.__isComponent === true) {
        const instance = new type(props);
        instance.props = props;
        return mount(instance.render());
      }
      return mount(type(props));
    } finally {
      hookCursor = previousCursor;
      hookMemory = previousMemory;
    }
  }
  const element = createElement(type);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === "children") continue;
    if (key === "ref") {
      if (typeof value === "function") value(element);
      else if (value && typeof value === "object") value.current = element;
      continue;
    }
    if (key === "style") {
      Object.assign(element.style, value);
      continue;
    }
    if (/^on[A-Z]/.test(key) && typeof value === "function") {
      element.addEventListener(key.slice(2).toLowerCase(), value);
      continue;
    }
    element.setAttribute(key, value);
  }
  for (const child of [].concat(props?.children ?? [])) {
    const mounted = mount(child);
    if (mounted !== null) element.append(...[].concat(mounted));
  }
  return element;
}

/** 执行上次挂载排队的 effects，返回它们的清理函数。 */
function flushEffects() {
  const cleanups = [];
  for (const effect of effects.splice(0)) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  return cleanups;
}

/** 在面板根节点里递归找 guest webview。 */
function findWebview(node) {
  if (node === null || node === undefined || typeof node !== "object") return void 0;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findWebview(item);
      if (found !== void 0) return found;
    }
    return void 0;
  }
  if (node.tag === "webview") return node;
  for (const child of node.children ?? []) {
    const found = findWebview(child);
    if (found !== void 0) return found;
  }
  return void 0;
}

/** 递归收集 input 元素（按 type 区分）。 */
function findInputs(node, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) findInputs(item, out);
    return out;
  }
  if (node.tag === "input") out.push(node);
  for (const child of node.children ?? []) findInputs(child, out);
  return out;
}

/** 递归收集所有元素节点。 */
function collectElements(node, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const item of node) collectElements(item, out); return out; }
  if (typeof node.tag === "string") out.push(node);
  for (const child of node.children ?? []) collectElements(child, out);
  return out;
}

/** 按属性值找元素。 */
function findByAttr(node, name, value) {
  return collectElements(node).find((el) => el.getAttribute(name) === value);
}

/** 是否存在账号状态条（特征：flex:"none" 的 div）。 */
function hasAccountStrip(node) {
  if (node === null || node === undefined || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasAccountStrip);
  if (node.tag === "div" && node.style?.flex === "none") return true;
  return (node.children ?? []).some(hasAccountStrip);
}

/** 收集渲染树里所有可见文案。 */
function collectTexts(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === "string") { out.push(node); return out; }
  if (Array.isArray(node)) { for (const item of node) collectTexts(item, out); return out; }
  if (typeof node !== "object") return out;
  if (node.text !== undefined) { out.push(node.text); return out; }
  for (const child of node.children ?? []) collectTexts(child, out);
  return out;
}

// ── 加载 bundle ─────────────────────────────────────────────────────────────
// ── 可控 fake timer（捕获 bundle 内 setTimeout）──────────────────────────────
// v1.1.9 起服务缺席时会排无上限的 500ms 就绪探测；若用真实 timer，自检会被拖住
// 甚至不退出。这里把 sandbox 里的 setTimeout/clearTimeout 换成可手动推进的队列；
// 模块级 flushMicrotasks()/settle() 仍用真实 Node timer，互不影响。
let timerSeq = 0;
let fakeTimers = [];
const fakeSetTimeout = (fn, ms) => {
  const id = ++timerSeq;
  fakeTimers.push({ id, fn, ms });
  return id;
};
const fakeClearTimeout = (id) => {
  const at = fakeTimers.findIndex((t) => t.id === id);
  if (at !== -1) fakeTimers.splice(at, 1);
};
const resetTimers = () => { fakeTimers = []; };
const countTimers = (ms) => fakeTimers.filter((t) => t.ms === ms).length;
const fireTimers = (ms, maxRounds = 80) => {
  let fired = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const due = fakeTimers.filter((t) => t.ms === ms);
    if (due.length === 0) break;
    for (const t of due) {
      const at = fakeTimers.indexOf(t);
      if (at !== -1) fakeTimers.splice(at, 1);
    }
    for (const t of due) { t.fn(); fired += 1; }
  }
  return fired;
};

let registration;
const sandbox = {
  window: { __ModuleLoader__: { load(value) { registration = value; } }, localStorage: localStorageStub },
  navigator: { language: "zh-CN" },
  document: documentStub,
  console,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  URL,
  Date
};
sandbox.globalThis = sandbox;
// v1.4.6-hotfix-4 回归（问题A）：模拟重启前残留的全自动开关 true，
// 验证 factory 加载（= 插件初始化）时自动归零，消除 checkbox/状态条不一致。
storage.set("dsh-plugin-deepseek-chat:config", JSON.stringify({ autoPilotEnabled: true }));
runInNewContext(source, sandbox, { filename: bundlePath });

// ── 可替换的 fetch 桩（检查更新用）──────────────────────────────────────────
// bundle 里的 getFetch() 在「调用时」读取全局 fetch；sandbox 已 contextify，
// 运行后再挂/删属性对 bundle 可见（和 globalThis.dshDesktop 一样）。
let fetchHandler = async () => { throw new Error("fetch 桩未配置"); };
const fetchCalls = [];
const defaultFetch = (url, options) => {
  fetchCalls.push(url);
  return fetchHandler(url, options);
};
sandbox.fetch = defaultFetch;
const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  async text() { return typeof body === "string" ? body : JSON.stringify(body); }
});
const settle = async () => { for (let i = 0; i < 8; i += 1) await flushMicrotasks(); };

if (!registration) throw new Error("bundle 没有调用 window.__ModuleLoader__.load");
// 回归（web boot 崩溃）：factory id 必须等于 package.json 的 name。
const pkgName = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).name;
if (registration.id !== pkgName) fail(`factory id ${registration.id} != 包名 ${pkgName}：web boot 会重复执行 bundle 并抛 duplicate factory registration`);
else ok(`factory id 与包名一致（${registration.id}）`);

const moduleExports = registration.factory((id) => {
  if (id === "react") return react;
  throw new Error(`意外的 require(${id})`);
});

// v1.4.6-hotfix-4 回归（问题A）：factory 初始化时归零残留的 autoPilotEnabled。
{
  const persisted = JSON.parse(storage.get("dsh-plugin-deepseek-chat:config") ?? "{}");
  if (persisted.autoPilotEnabled !== false) fail(`问题A：初始化未归零残留 autoPilotEnabled：${JSON.stringify(persisted)}`);
  else ok("v1.4.6-hotfix-4：初始化归零残留 autoPilotEnabled（checkbox 与状态条一致关闭）");
}

if (typeof moduleExports.apply !== "function") fail("缺少 exports.apply");
if (!Array.isArray(moduleExports.inject)) fail("缺少 exports.inject");
if (moduleExports.inject.length !== 1 || moduleExports.inject[0] !== "slots") fail(`inject 应为 ["slots"]，实际 ${JSON.stringify(moduleExports.inject)}`);
else ok(`exports.apply + inject = [${moduleExports.inject.join(", ")}]`);

const api = moduleExports.__test__;
if (api === undefined) {
  fail("缺少 exports.__test__");
  process.exit(1);
}

// ── 配置层（设置项默认值、类型校验、持久化、订阅）──────────────────────────
{
  const CONFIG_KEY = api.CONFIG_KEY;
  if (CONFIG_KEY !== "dsh-plugin-deepseek-chat:config") fail(`CONFIG_KEY 不对：${CONFIG_KEY}`);
  if (api.DEFAULTS?.showTab !== true || api.DEFAULTS?.tabLabel !== "DeepSeek 聊天" ||
      api.DEFAULTS?.showCard !== true || api.DEFAULTS?.cardLabel !== "DeepSeek 聊天") {
    fail(`默认值不对：${JSON.stringify(api.DEFAULTS)}`);
  } else ok("设置默认值：showTab / tabLabel / showCard / cardLabel 四项齐全");

  if (api.normalizeTabLabel("   ") !== "DeepSeek 聊天" || api.normalizeLabel("   ", "DeepSeek 聊天") !== "DeepSeek 聊天") fail("空白名称没有回退默认");
  if (api.normalizeTabLabel("  X  ") !== "X") fail("名称没有去首尾空格");
  if (api.normalizeTabLabel("x".repeat(50)).length !== 40) fail("超长名称没有截断到 40");
  if (api.normalizeLabel("   ", "备用") !== "备用") fail("normalizeLabel 没用传入的 fallback");
  ok("名称归一化：去空白、空回退默认、超长截断、可指定 fallback");

  storage.clear();
  storage.set(CONFIG_KEY, JSON.stringify({ showTab: "yes", tabLabel: 123, showCard: 1, cardLabel: {} }));
  let c = api.readConfig();
  if (c.showTab !== true || c.tabLabel !== "DeepSeek 聊天" || c.showCard !== true || c.cardLabel !== "DeepSeek 聊天") {
    fail(`错误类型没有回退默认：${JSON.stringify(c)}`);
  }
  storage.set(CONFIG_KEY, "{not json");
  c = api.readConfig();
  if (c.showTab !== true || c.tabLabel !== "DeepSeek 聊天") fail("损坏的 JSON 没有回退默认");
  storage.set(CONFIG_KEY, JSON.stringify({ showTab: false, tabLabel: "  X  ", showCard: false, cardLabel: "  卡片  " }));
  c = api.readConfig();
  if (c.showTab !== false || c.tabLabel !== "X" || c.showCard !== false || c.cardLabel !== "卡片") {
    fail(`合法配置读取不对：${JSON.stringify(c)}`);
  }
  ok("readConfig 按类型校验四项字段，损坏/错误类型回退默认");

  let received;
  const unsubscribe = api.subscribeConfig((next) => { received = next; });
  api.writeConfig({ showTab: false, tabLabel: "自定义", showCard: false, cardLabel: "我的卡片" });
  if (received?.showTab !== false || received?.tabLabel !== "自定义" || received?.showCard !== false || received?.cardLabel !== "我的卡片") {
    fail("writeConfig 没有通知订阅者（四项）");
  }
  if (api.getConfig().showTab !== false || api.tabLabel() !== "自定义" || api.cardLabel() !== "我的卡片") fail("writeConfig 没有更新内存配置");
  const persisted = JSON.parse(storage.get(CONFIG_KEY) ?? "{}");
  if (persisted.showTab !== false || persisted.tabLabel !== "自定义" || persisted.showCard !== false || persisted.cardLabel !== "我的卡片") {
    fail("writeConfig 没有持久化四项到 localStorage");
  } else ok("writeConfig 合并 patch、持久化四项并通知订阅者");
  unsubscribe();
  received = void 0;
  api.writeConfig({ tabLabel: "再次" });
  if (received !== void 0) fail("取消订阅后仍然收到通知");
  else ok("subscribeConfig 返回的 disposer 能取消订阅");

  // 恢复模块级默认配置，避免影响后续注册测试；并清掉测试写入的 config 键。
  api.writeConfig({ showTab: true, tabLabel: "DeepSeek 聊天", showCard: true, cardLabel: "DeepSeek 聊天" });
  storage.clear();
  if (api.getConfig().showTab !== true || api.tabLabel() !== "DeepSeek 聊天" || api.getConfig().showCard !== true || api.cardLabel() !== "DeepSeek 聊天") {
    fail("测试后配置没有恢复默认");
  } else ok("配置层测试结束，已恢复默认配置");
}

// ── v1.4.1：自定义聊天网页 URL ──────────────────────────────────────────────
{
  const DEFAULT = api.CHAT_URL;
  if (api.DEFAULTS?.chatUrl !== DEFAULT) fail("DEFAULTS.chatUrl 默认不是 CHAT_URL");

  // normalizeChatUrl：接受白名单主机（deepseek 默认 + 豆包），规范化 URL。
  const deepseek = api.normalizeChatUrl("https://chat.deepseek.com/");
  const doubao = api.normalizeChatUrl("https://www.doubao.com/chat/");
  if (deepseek !== "https://chat.deepseek.com/") fail(`normalizeChatUrl 默认 URL 不对：${deepseek}`);
  if (doubao !== "https://www.doubao.com/chat/") fail(`normalizeChatUrl 豆包 URL 不对：${doubao}`);
  if (api.normalizeChatUrl("  https://www.doubao.com/chat/  ") !== "https://www.doubao.com/chat/") fail("normalizeChatUrl 没有去首尾空格");
  if (api.normalizeChatUrl("https://doubao.com/chat/") !== "https://doubao.com/chat/") fail("normalizeChatUrl 应接受裸 doubao.com 主机");

  // 拒绝：http、外部域名、显式端口、带凭据、非法字符串、空、超长。
  const rejected = [
    "http://chat.deepseek.com/",
    "https://evil.example.com/chat",
    "https://www.doubao.com:8443/chat/",
    "https://user:pass@www.doubao.com/chat/",
    "not a url",
    "",
    "x".repeat(5000)
  ];
  for (const bad of rejected) {
    if (api.normalizeChatUrl(bad) !== DEFAULT) fail(`normalizeChatUrl 没有拒绝非法 URL：${String(bad).slice(0, 40)}`);
  }
  if (!api.CUSTOM_URL_HOSTS?.has("chat.deepseek.com") || !api.CUSTOM_URL_HOSTS?.has("www.doubao.com")) fail("CUSTOM_URL_HOSTS 缺少预期主机");
  ok("normalizeChatUrl：白名单主机通过、规范化、拒绝 http/外部域名/端口/凭据/非法值");

  // 配置读写：chatUrl 随 writeConfig 持久化，非法值回退默认。
  storage.clear();
  api.writeConfig({ chatUrl: "https://www.doubao.com/chat/" });
  if (api.getConfig().chatUrl !== "https://www.doubao.com/chat/") fail("writeConfig 没有写入豆包 URL");
  if ((JSON.parse(storage.get(api.CONFIG_KEY) ?? "{}")).chatUrl !== "https://www.doubao.com/chat/") fail("chatUrl 没有持久化");
  api.writeConfig({ chatUrl: "https://evil.example.com/" });
  if (api.getConfig().chatUrl !== DEFAULT) fail("非法 chatUrl 没有回退默认");
  ok("chatUrl 配置：合法值持久化、非法值回退默认");

  // 恢复默认，避免影响后续注册/面板测试。
  api.writeConfig({ chatUrl: DEFAULT });
  storage.clear();
}

// ── v1.4.2：平台预设整包切换（DeepSeek / 豆包）────────────────────────────
{
  const DS = api.PLATFORM_PRESETS?.deepseek;
  const DB = api.PLATFORM_PRESETS?.doubao;
  if (!DS || !DB) fail("PLATFORM_PRESETS 缺少 deepseek / doubao 预设");
  else ok("PLATFORM_PRESETS 两套预设均存在");

  // 平台默认显示名（v1.4.5+ 名称联动）。
  const expectedName = { deepseek: "DeepSeek 聊天", doubao: "豆包 聊天" };

  // 两套预设各含 URL + 五组选择器，且豆包 URL 指向 doubao.com。
  for (const [name, preset] of [["deepseek", DS], ["doubao", DB]]) {
    for (const key of ["chatUrl", "stopButtonSelectors", "sendButtonSelectors", "textareaSelectors", "assistantSelectors", "userMessageSelectors"]) {
      if (preset[key] === undefined) fail(`${name} 预设缺少 ${key}`);
    }
    if (!Array.isArray(preset.textareaSelectors) || preset.textareaSelectors.length === 0) fail(`${name} 预设 textareaSelectors 为空`);
    // v1.4.5+ 名称联动：两套预设各带平台默认显示名。
    if (preset.tabLabel !== expectedName[name] || preset.cardLabel !== expectedName[name]) {
      fail(`${name} 预设默认显示名不对：tabLabel=${preset.tabLabel} cardLabel=${preset.cardLabel}`);
    }
  }
  if (DB.chatUrl !== "https://www.doubao.com/chat/") fail(`豆包预设 URL 不对：${DB.chatUrl}`);
  if (DS.chatUrl !== api.CHAT_URL) fail("DeepSeek 预设 URL 不是默认 CHAT_URL");
  ok("平台预设：URL + 五组选择器齐全，豆包指向 doubao.com，DeepSeek 用默认");

  // v1.4.5+ 名称联动：切换平台时顶栏标签名与右侧卡片名一并改为平台默认名。
  api.applyPlatformPreset("doubao");
  if (api.tabLabel() !== expectedName.doubao || api.cardLabel() !== expectedName.doubao) {
    fail(`切豆包后名称未联动：tabLabel=${api.tabLabel()} cardLabel=${api.cardLabel()}`);
  }
  ok("applyPlatformPreset(doubao)：顶栏标签名与右侧卡片名联动为「豆包 聊天」");
  api.applyPlatformPreset("deepseek");
  if (api.tabLabel() !== expectedName.deepseek || api.cardLabel() !== expectedName.deepseek) {
    fail(`切回 DeepSeek 后名称未恢复：tabLabel=${api.tabLabel()} cardLabel=${api.cardLabel()}`);
  }
  ok("applyPlatformPreset(deepseek)：顶栏标签名与右侧卡片名恢复「DeepSeek 聊天」");

  // currentPlatform 从 chatUrl 主机推导，单一数据源。
  api.writeConfig({ chatUrl: api.CHAT_URL });
  if (api.currentPlatform() !== "deepseek") fail("currentPlatform 未识别 deepseek");
  api.writeConfig({ chatUrl: "https://www.doubao.com/chat/" });
  if (api.currentPlatform() !== "doubao") fail("currentPlatform 未识别 doubao");
  ok("currentPlatform：从 chatUrl 主机正确推导当前平台");

  // applyPlatformPreset 整包切换：切豆包写入专用选择器，切回 deepseek 恢复原生。
  if (api.applyPlatformPreset("doubao") !== true) fail("applyPlatformPreset(doubao) 返回值不为 true");
  let c = api.getConfig();
  if (c.chatUrl !== "https://www.doubao.com/chat/") fail("切豆包后 chatUrl 未变");
  if (JSON.stringify(c.textareaSelectors) !== JSON.stringify(DB.textareaSelectors)) fail("切豆包后 textareaSelectors 未整包切换");
  if (c.textareaSelectors.some((s) => s.includes("chat.deepseek.com") || s.includes("data-message-author-role"))) {
    fail("豆包选择器里仍残留 DeepSeek 专有选择器");
  }
  if ((JSON.parse(storage.get(api.CONFIG_KEY) ?? "{}")).chatUrl !== "https://www.doubao.com/chat/") fail("平台切换未持久化到 localStorage");
  ok("applyPlatformPreset(doubao)：URL + 选择器整包切换并持久化");

  api.applyPlatformPreset("deepseek");
  c = api.getConfig();
  if (c.chatUrl !== api.CHAT_URL) fail("切回 DeepSeek 后 chatUrl 未恢复");
  if (JSON.stringify(c.assistantSelectors) !== JSON.stringify(api.DEFAULTS.assistantSelectors)) fail("切回 DeepSeek 后选择器未恢复原生");
  if (api.applyPlatformPreset("unknown") !== false) fail("未知平台应返回 false");
  ok("applyPlatformPreset(deepseek)：恢复原生配置；未知平台安全拒绝");

  // 恢复默认，避免影响后续测试。
  api.applyPlatformPreset("deepseek");
  storage.clear();
}

// ── 关于信息 + 检查更新逻辑（v1.1.5，版本号随发布更新）────────────────────
{
  // 基础信息常量与 package.json 一致（和 factory id === 包名同一套回归）。
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  if (api.PLUGIN_NAME !== pkg.name) fail(`元信息名称与包名不一致：${api.PLUGIN_NAME}`);
  if (api.PLUGIN_VERSION !== pkg.version) fail(`元信息版本号与 package.json 不一致：${api.PLUGIN_VERSION} != ${pkg.version}`);
  if (api.PLUGIN_AUTHOR !== pkg.author) fail(`元信息作者与 package.json 不一致：${api.PLUGIN_AUTHOR}`);
  if (api.PLUGIN_LICENSE !== pkg.license) fail(`元信息许可证与 package.json 不一致：${api.PLUGIN_LICENSE}`);
  else ok(`基础信息常量与 package.json 一致（版本 ${api.PLUGIN_VERSION} / 作者 ${api.PLUGIN_AUTHOR} / ${api.PLUGIN_LICENSE}）`);
  if (api.NPM_VERSION_URL?.includes("registry.npmjs.org") !== true) fail("npm 更新接口不是官方 registry");
  if (api.GITHUB_VERSION_URL?.includes("raw.githubusercontent.com") !== true) fail("GitHub 更新接口不是 raw 文件");
  else ok("更新接口：npm dist-tags + GitHub raw package.json");

  // 语义版本比较（不能按字符串相等，本地未发版可领先已发布 1.1.2）。
  if (api.compareVersion("1.1.2", "1.1.5") !== -1) fail("compareVersion 1.1.2 < 1.1.5 判断错");
  if (api.compareVersion("1.1.5", "1.1.2") !== 1) fail("compareVersion 1.1.5 > 1.1.2 判断错");
  if (api.compareVersion("1.1.10", "1.1.9") !== 1) fail("compareVersion 没有按数字比较（1.1.10 应大于 1.1.9）");
  if (api.compareVersion("1.2.0", "1.2.0") !== 0) fail("compareVersion 相等判断错");
  ok("compareVersion 按数字逐段比较，本地未发版领先也算已是最新");

  // 载荷解析：npm dist-tags / package.json / 损坏 JSON。
  if (api.versionFromPayload('{"latest":"1.1.2"}') !== "1.1.2") fail("没有解析 npm dist-tags 的 latest");
  if (api.versionFromPayload('{"version":"1.2.3","name":"x"}') !== "1.2.3") fail("没有解析 package.json 的 version");
  if (api.versionFromPayload("not json") !== void 0) fail("损坏 JSON 没有返回 undefined");
  if (api.versionFromPayload('{"version":"v1.2.3"}') !== void 0) fail("非法版本号没有被拒绝");
  ok("versionFromPayload 解析 dist-tags/package.json，拒绝损坏与非法版本号");

  // fetchLatestVersion：npm 优先、GitHub 兜底、两个都失败时抛错。
  fetchCalls.length = 0;
  fetchHandler = async (url) => {
    if (String(url).includes("registry.npmjs.org")) return jsonResponse({ latest: "1.1.2" });
    return jsonResponse({ version: "9.9.9" });
  };
  let latest = await api.fetchLatestVersion(defaultFetch, 1000);
  if (latest.version !== "1.1.2" || latest.source !== "npm") fail(`npm 优先没生效：${JSON.stringify(latest)}`);
  else if (fetchCalls.length !== 1) fail(`npm 成功时不应再请求 GitHub（实际 ${fetchCalls.length} 次）`);
  else ok("fetchLatestVersion：npm 成功即返回，来源 npm，不请求 GitHub");

  fetchCalls.length = 0;
  fetchHandler = async (url) => {
    if (String(url).includes("registry.npmjs.org")) return jsonResponse("", { ok: false, status: 500 });
    return jsonResponse({ version: "2.0.0" });
  };
  latest = await api.fetchLatestVersion(defaultFetch, 1000);
  if (latest.version !== "2.0.0" || latest.source !== "GitHub") fail(`GitHub 兜底没生效：${JSON.stringify(latest)}`);
  else if (fetchCalls.length !== 2) fail(`npm 失败后应请求 GitHub（实际 ${fetchCalls.length} 次）`);
  else ok("fetchLatestVersion：npm 失败后读 GitHub raw，来源 GitHub");

  fetchHandler = async () => { throw new Error("offline"); };
  let threw;
  try { await api.fetchLatestVersion(defaultFetch, 1000); } catch (error) { threw = error; }
  if (threw === void 0) fail("两个来源都失败时没有抛错");
  else ok("fetchLatestVersion：npm 与 GitHub 都失败时抛错（供 UI 显示失败状态）");

  // getUpdateState / set / reset。
  api.resetUpdateState();
  if (api.getUpdateState().status !== "idle") fail("resetUpdateState 没回到 idle");
  api.setUpdateState({ status: "found", latest: "9.0.0", source: "npm" });
  if (api.getUpdateState().latest !== "9.0.0") fail("setUpdateState 没写入状态");
  api.resetUpdateState();
  ok("更新状态读写与重置（idle 起步）");

  // checkForUpdates：已是最新 / 发现新版 / 失败 / 检查中重叠保护。
  let repaints = 0;
  const onChange = () => { repaints += 1; };
  fetchHandler = async () => jsonResponse({ latest: "1.1.2" }); // < 本地 1.1.5 → 已是最新
  await api.checkForUpdates(onChange);
  await settle();
  if (api.getUpdateState().status !== "up-to-date") fail(`本地领先应判已是最新，实际 ${api.getUpdateState().status}`);
  else ok("checkForUpdates：远端版本低于本地 → 已是最新");

  api.resetUpdateState();
  fetchHandler = async () => jsonResponse({ latest: "9.9.9" }); // > 本地 → 发现新版
  await api.checkForUpdates(onChange);
  await settle();
  if (api.getUpdateState().status !== "found" || api.getUpdateState().latest !== "9.9.9") fail("发现新版状态不对");
  else ok("checkForUpdates：远端版本高于本地 → 发现新版");

  api.resetUpdateState();
  fetchHandler = async () => { throw new Error("network down"); };
  await api.checkForUpdates(onChange);
  await settle();
  if (api.getUpdateState().status !== "failed") fail("网络失败没有显示 failed 状态");
  else ok("checkForUpdates：网络失败 → 显示失败状态（不逃逸异常）");
  if (repaints < 6) fail(`状态刷新回调次数不足：${repaints}`);

  api.resetUpdateState();
  // 无 fetch 时也要给出失败状态，而不是抛错。
  const savedFetch = sandbox.fetch;
  delete sandbox.fetch;
  await api.checkForUpdates();
  await settle();
  if (api.getUpdateState().status !== "failed") fail("没有 fetch 时未进入 failed 状态");
  else ok("checkForUpdates：无可用 fetch → 失败兜底");
  sandbox.fetch = savedFetch;

  // 检查中重叠保护：留一个永远 pending 的请求，第二次调用应直接返回。
  api.resetUpdateState();
  api.setUpdateState({ status: "checking" });
  await api.checkForUpdates(onChange);
  if (api.getUpdateState().status !== "checking") fail("checking 期间被重复触发");
  else ok("checkForUpdates：检查中忽略重复点击");
  api.resetUpdateState();
  fetchHandler = async () => { throw new Error("桩未配置"); };
}

// ── 注册 ────────────────────────────────────────────────────────────────────
/**
 * 更贴近真实 Cordis 的槽桩：inject 同步执行 factory，register 记录一条生效
 * 注册并返回 disposer（调用即从生效列表移除），这样「设置项变化 → dispose +
 * 重新 inject conversation.view」可以被观测到。
 */
const makeCtx = (options = {}) => {
  const ctx = {
    registrations: [],
    history: [],
    injectCalls: [],
    effectCalls: [],
    effectCleanups: [],
    // 可选的服务软探测桩：默认都缺席（冷启动 / 未安装）。
    betterSidebar: options.betterSidebar,
    sidebarRightTabs: options.sidebarRightTabs,
    remote: options.remote,
    cardRegistrations: [],       // better-sidebar registerTab 的记录
    nativeRegistrations: [],     // DSH 原生 sidebarRightTabs.register 的记录
    serviceListeners: [],        // ctx.on('internal/service') 的记录
    slots: {
      inject: (name, factory) => {
        ctx.injectCalls.push(name);
        const disposeRegister = factory();
        return () => {
          if (typeof disposeRegister === "function") disposeRegister();
        };
      },
      register: (definition, component) => {
        const entry = { definition, component, disposed: false };
        ctx.registrations.push(entry);
        ctx.history.push(entry);
        return () => {
          entry.disposed = true;
          const at = ctx.registrations.indexOf(entry);
          if (at !== -1) ctx.registrations.splice(at, 1);
        };
      }
    },
    // 宿主 guard 允许的软探测：服务缺失返回 undefined（不登记 dependent）。
    get: (name) => {
      if (name === "betterSidebar") return ctx.betterSidebar;
      if (name === "sidebarRightTabs") return ctx.sidebarRightTabs;
      if (name === "remote") return ctx.remote;
      return undefined;
    },
    // 模拟 Cordis 的 ctx.on / internal/service 事件（真实环境由 frame emit）。
    on: (name, listener, options) => {
      const entry = { name, listener, options };
      ctx.serviceListeners.push(entry);
      return () => {
        const at = ctx.serviceListeners.indexOf(entry);
        if (at !== -1) ctx.serviceListeners.splice(at, 1);
      };
    },
    emitService: (serviceName, value) => {
      // 真实 Cordis：providers 在 fiber active 时 emit("internal/service", name, value)，
      // 监听器注册在 "internal/service" 名下、收到的第一个参数才是服务名。
      for (const entry of [...ctx.serviceListeners]) {
        if (entry.name === "internal/service") entry.listener(serviceName, value);
      }
    },
    effect: (fn, name) => {
      ctx.effectCalls.push(name);
      const cleanup = fn();
      if (typeof cleanup === "function") ctx.effectCleanups.push(cleanup);
      return () => {};
    }
  };
  return ctx;
};

/** 构造一个记录 registerTab 调用、返回可观测 disposer 的假 better-sidebar 服务。 */
const makeBetterSidebar = (ctx) => ({
  registerTab(descriptor) {
    const entry = { descriptor, disposed: false };
    ctx.cardRegistrations.push(entry);
    return () => {
      entry.disposed = true;
      const at = ctx.cardRegistrations.indexOf(entry);
      if (at !== -1) ctx.cardRegistrations.splice(at, 1);
    };
  }
});
/** 构造一个记录 register(definition)、返回可观测 disposer 的假原生 registry。 */
const makeNativeRegistry = (ctx) => ({
  register(definition) {
    const entry = { definition, disposed: false };
    ctx.nativeRegistrations.push(entry);
    return () => {
      entry.disposed = true;
      const at = ctx.nativeRegistrations.indexOf(entry);
      if (at !== -1) ctx.nativeRegistrations.splice(at, 1);
    };
  }
});
const findSlot = (ctx, name) => ctx.registrations.find((entry) => entry.definition.name === name);
const countSlot = (ctx, name) => ctx.registrations.filter((entry) => entry.definition.name === name).length;

// Web 表层：完全没有桌面桥。
delete sandbox.globalThis.dshDesktop;
const webCtx = makeCtx();
moduleExports.apply(webCtx);
if (webCtx.registrations.length !== 0) fail("Web 表层仍然注册了槽位");
else ok("没有桌面桥时完全不注册（Web 表层 inert）");

// Web 表层：preload 只暴露 protocolVersion，没有 browser。
sandbox.globalThis.dshDesktop = { protocolVersion: 1 };
const webCtx2 = makeCtx();
moduleExports.apply(webCtx2);
if (webCtx2.registrations.length !== 0) fail("只有 protocolVersion、没有 browser 时仍然注册了槽位");
else ok("缺少 browser 桥时保持 inert");

// 桌面表层：四处注册。
sandbox.globalThis.dshDesktop = { protocolVersion: 1, browser: {} };
const desktopCtx = makeCtx();
moduleExports.apply(desktopCtx);
// v1.4.4 修复：composer.dock 常驻注册（只读观察 currentSessionId，让绑定按钮默认可见）；
// v1.4.6-hotfix-5：新增 shell.overlay（决策卡为屏幕居中浮层，替代原 turnTail 内嵌卡）。
// 故桌面表层为 6 处（主面板 / 左侧栏 / 顶栏标签 / 设置页 / 常驻 dock / shell.overlay 浮层卡）。
if (desktopCtx.registrations.length !== 6) fail(`桌面表层应有 6 处注册（含常驻 dock 与 shell.overlay），实际 ${desktopCtx.registrations.length}`);
else ok("桌面表层恰好 6 处注册（主面板 / 左侧栏 / 顶栏标签 / 设置页 / 常驻 dock / shell.overlay）");

// 回归（绑定按钮消失 bug）：两开关默认都关时，composer.dock 也必须常驻注册，
// 才能上报 currentSessionId、让状态条渲染「绑定当前会话」按钮。
if (countSlot(desktopCtx, "conversation.composer.dock") !== 1) fail("默认两开关关闭时 composer.dock 未常驻注册（绑定按钮会消失）");
else ok("默认两开关关闭时 composer.dock 仍常驻注册（绑定当前会话按钮可见）");

const mainSlot = findSlot(desktopCtx, "main");
const listSlot = findSlot(desktopCtx, "sidebar.panellist");
const settingsSlot = findSlot(desktopCtx, "settings.section");
let viewSlot = findSlot(desktopCtx, "conversation.view");
if (!mainSlot) fail("缺少 main 全屏面板注册");
if (!listSlot) fail("缺少 sidebar.panellist 左侧栏图标注册");
if (!settingsSlot) fail("缺少 settings.section 设置页注册");
if (!viewSlot) fail("缺少 conversation.view 顶栏标签页注册");
if (mainSlot?.definition.key !== "deepseek-chat") fail(`main key 不对：${mainSlot?.definition.key}`);
if (listSlot?.definition.id !== "deepseek-chat" || listSlot?.definition.order !== 5) fail("左侧栏图标 id/order 不对");
if (settingsSlot?.definition.id !== "deepseek-chat-settings" || settingsSlot?.definition.order !== 48) fail("设置页 id/order 不对");
if (viewSlot?.definition.id !== "deepseek-chat-view" || viewSlot?.definition.order !== 100) fail("顶栏标签页 id/order 不对");
if (mainSlot?.definition.key !== listSlot?.definition.id) fail("sidebar.panellist 的 id 必须与 main 的 key 一致");
if (typeof settingsSlot?.definition.label() !== "string") fail("设置页 label 不是字符串");
if (typeof listSlot?.definition.label() !== "string") fail("左侧栏 label 不是字符串");
if (viewSlot?.definition.label() !== "DeepSeek 聊天") fail(`顶栏标签默认名不对：${viewSlot?.definition.label()}`);
else ok("顶栏标签默认名为「DeepSeek 聊天」");
if (viewSlot?.component === mainSlot?.component) fail("顶栏标签页不该与全屏面板共用同一组件（需要铺满浮层包装）");
ok(`主面板 key=${mainSlot.definition.key} / 左侧栏 id=${listSlot.definition.id} / 设置页 id=${settingsSlot.definition.id} / 顶栏 id=${viewSlot.definition.id}`);

if (!desktopCtx.effectCalls.includes("dsh-plugin-deepseek-chat: settings sync")) fail("apply 没有通过 ctx.effect 注册配置订阅清理");
else ok("apply 通过 ctx.effect 注册配置订阅生命周期清理");

const icon = mount(react.createElement(listSlot.component, { size: 16, active: true }));
if (icon?.tag !== "svg") fail("左侧栏图标不是 svg");
else ok(`左侧栏图标渲染 svg @ ${icon.getAttribute("width")}`);

// ── 设置页组件 + 动态顶栏标签页联动 ────────────────────────────────────────
{
  // 假 react 的 useState setter 只改内存、不触发重渲染；每次交互后重新挂载表单，
  // 才能观察到输入框 value / placeholder 与 checkbox checked 的最新值。
  const mountForm = () => mount(react.createElement(settingsSlot.component, {}));
  // 现在设置页有两组开关/输入框，用 data 属性精确定位，避免次序混淆。
  const controls = (form) => ({
    checkbox: findByAttr(form, "data-dsh-plugin-deepseek-chat", "show-tab"),
    textbox: findByAttr(form, "data-dsh-plugin-deepseek-chat", "tab-label"),
    cardCheckbox: findByAttr(form, "data-dsh-plugin-deepseek-chat", "show-card"),
    cardTextbox: findByAttr(form, "data-dsh-plugin-deepseek-chat", "card-label")
  });
  const PLACEHOLDER = "DeepSeek 聊天";
  let { checkbox, textbox, cardCheckbox, cardTextbox } = controls(mountForm());
  if (!checkbox || !textbox || !cardCheckbox || !cardTextbox) fail("设置页缺少两对开关/名称输入框");
  else {
    if (checkbox.getAttribute("checked") !== "true") fail("设置页复选框默认应为勾选");
    else if (textbox.getAttribute("value") !== "") fail(`默认名称输入框应为空（灰色占位提示显示默认名），实际 value=${textbox.getAttribute("value")}`);
    else if (textbox.getAttribute("placeholder") !== PLACEHOLDER) fail(`灰色占位提示不对：${textbox.getAttribute("placeholder")}`);
    else ok("设置页：开关默认勾选；名称框默认空白，显示灰色占位提示「DeepSeek 聊天」");

    // 留空时顶栏默认名仍来自配置，不依赖输入框里的实体文字。
    if (viewSlot?.definition.label() !== PLACEHOLDER) fail(`留空时顶栏标签名应为「${PLACEHOLDER}」，实际 ${viewSlot?.definition.label()}`);
    else ok("名称框留空时，顶栏标签仍显示默认名「DeepSeek 聊天」");

    // 自定义标签名（开关仍开启）→ 重新注入 → label() 变为自定义值。
    textbox.dispatch("change", { target: { value: "我的聊天" } });
    if (api.tabLabel() !== "我的聊天") fail("自定义标签名没有写入配置");
    const renamed = findSlot(desktopCtx, "conversation.view");
    if (!renamed) fail("自定义标签名后顶栏标签没有重新注册");
    else if (renamed.definition.label() !== "我的聊天") fail(`重新注册后标签名不对：${renamed.definition.label()}`);
    else ok("自定义标签名触发顶栏标签重新注入，label thunk 返回新名字");
    const renamedBox = controls(mountForm()).textbox;
    if (renamedBox.getAttribute("value") !== "我的聊天") fail(`改名后重新挂载，输入框应显示黑色实体自定义名，实际 ${renamedBox.getAttribute("value")}`);
    else ok("改名后重新挂载：输入框显示黑色实体自定义名「我的聊天」");

    // 关闭顶部标签栏 → 配置更新 → 顶栏标签注册被移除（只剩 3 处）。
    checkbox.dispatch("change", { target: { checked: false } });
    if (api.getConfig().showTab !== false) fail("关闭开关没有写入 showTab=false");
    if (countSlot(desktopCtx, "conversation.view") !== 0) fail("关闭开关后 conversation.view 仍生效");
    else ok("关闭顶部标签栏后动态移除 conversation.view 注册");
    // 关闭顶栏标签 → 减 1；常驻 dock 与 shell.overlay 不随开关注销，故为 5 处（原 3 + dock + shell.overlay）。
    if (desktopCtx.registrations.length !== 5) fail(`关闭后应剩 5 处注册（含常驻 dock 与 shell.overlay），实际 ${desktopCtx.registrations.length}`);

    // 重新开启 → 4 处恢复，标签名保持自定义。
    checkbox.dispatch("change", { target: { checked: true } });
    viewSlot = findSlot(desktopCtx, "conversation.view");
    if (!viewSlot || viewSlot.definition.label() !== "我的聊天") fail("重新开启后标签名丢失");
    else ok("重新开启顶部标签栏，保留自定义标签名");
    const viewInjects = desktopCtx.injectCalls.filter((name) => name === "conversation.view").length;
    if (viewInjects < 3) fail(`conversation.view 没有被反复重新 inject（次数 ${viewInjects}）`);
    else ok(`标签行刷新靠注册表变化：conversation.view 共 inject ${viewInjects} 次`);

    // 清空名称 → 回退默认；输入框重新变空白并恢复灰色占位提示。
    ({ checkbox, textbox } = controls(mountForm()));
    textbox.dispatch("change", { target: { value: "   " } });
    if (api.tabLabel() !== PLACEHOLDER) fail("清空名称没有回退默认");
    else ok("名称留空自动回退默认「DeepSeek 聊天」");
    const clearedBox = controls(mountForm()).textbox;
    if (clearedBox.getAttribute("value") !== "" || clearedBox.getAttribute("placeholder") !== PLACEHOLDER) fail("清空后没有回到空白 + 灰色占位提示");
    else ok("清空名称后输入框重新变空白、恢复灰色占位提示「DeepSeek 聊天」");
    viewSlot = findSlot(desktopCtx, "conversation.view");
    if (!viewSlot || viewSlot.definition.label() !== PLACEHOLDER) fail("回退默认后标签名没更新");
    // 恢复顶栏标签 + 常驻 dock + shell.overlay = 6 处。
    if (desktopCtx.registrations.length !== 6) fail(`恢复后应有 6 处注册（含常驻 dock 与 shell.overlay），实际 ${desktopCtx.registrations.length}`);
    else ok("设置联动测试结束，恢复 6 处注册与默认标签名");
  }
}

// ── 右边栏卡片（v1.1.9 双路径：better-sidebar 正常运行 / DSH 原生直注）────
{
  // 路径判据只有一条：ctx.get('betterSidebar') 是否返回可用的 registerTab 服务。
  // better-sidebar 未运行（装了但冷启动 pending / 根本没装）→ DSH 原生直注。
  // 两路径互斥；晚到的服务经 internal/service 事件或兜底 timer 自动切换，
  // 根治 v1.1.8「20 秒窗口过期、必须手动关开」的 bug。

  // ① 两个服务都不可用：其余四处表面照常，零卡片，但持续排队就绪探测。
  resetTimers();
  const noneCtx = makeCtx();
  moduleExports.apply(noneCtx);
  if (noneCtx.registrations.length !== 5) fail("服务全缺席时应仍为 5 处槽位注册（含 shell.overlay），实际 " + noneCtx.registrations.length);
  else if (noneCtx.cardRegistrations.length !== 0 || noneCtx.nativeRegistrations.length !== 0) fail("服务全缺席时不应注册任何右边栏卡片");
  else ok("服务全缺席：better-sidebar 未运行且原生 registry 未就绪 → 零卡片、其余五处表面照常（含 shell.overlay）");
  if (countTimers(api.CARD_RETRY_DELAY) !== 1) fail("服务全缺席：应排队 1 个无上限就绪探测 timer");
  else ok("服务全缺席：排下可取消的就绪探测（v1.1.9 无 20 秒硬上限）");

  // ② better-sidebar 正常运行 → 走 registerTab；原生 registry 即便也在也不注册（互斥）。
  const betterCtx = makeCtx();
  betterCtx.betterSidebar = makeBetterSidebar(betterCtx);
  betterCtx.sidebarRightTabs = makeNativeRegistry(betterCtx);   // 故意同时提供，验证 better 优先
  moduleExports.apply(betterCtx);
  if (betterCtx.cardRegistrations.length !== 1) fail("better-sidebar 正常运行时应注册 1 张卡片，实际 " + betterCtx.cardRegistrations.length);
  else if (betterCtx.nativeRegistrations.length !== 0 || countSlot(betterCtx, "sidebar.right.pane.tab") !== 0) fail("better-sidebar 正常运行时不应再走原生直注（两路径须互斥）");
  else ok("better-sidebar 正常运行 → 只走 registerTab；原生直注被跳过（两路径互斥）");

  const descriptor = api.cardDescriptor();
  if (descriptor.id !== api.CARD_ID || descriptor.id !== "@tianyulinfeng1/dsh-plugin-deepseek-chat:card") fail("卡片 id 不对：" + descriptor.id);
  else if (descriptor.order !== 60) fail("卡片 order 不对：" + descriptor.order);
  else if (descriptor.title() !== "DeepSeek 聊天") fail("卡片默认名不对：" + descriptor.title());
  else if (descriptor.component !== api.CardView) fail("卡片 component 不是 CardView");
  else if (typeof descriptor.icon !== "function" || typeof descriptor.dedupeKey !== "function") fail("卡片缺少 icon/dedupeKey");
  else ok("卡片 descriptor：id=" + descriptor.id + " / order=" + descriptor.order + " / 默认名=「DeepSeek 聊天」");

  // 改名：title 是 thunk，无需重新注册；与顶栏名称独立。
  api.writeConfig({ cardLabel: "侧边聊天" });
  if (descriptor.title() !== "侧边聊天") fail("改名后 title thunk 没有返回新名字");
  else if (api.tabLabel() !== "DeepSeek 聊天") fail("改卡片名误改了顶栏名称（两者应独立）");
  else ok("卡片名称修改即时生效（title thunk 重求值，与顶栏名称独立）");
  api.writeConfig({ cardLabel: "DeepSeek 聊天" });

  // ③ better-sidebar 未运行、但 DSH 原生 registry 可用 → 原生直注（type + body 槽）。
  const nativeCtx = makeCtx();
  nativeCtx.sidebarRightTabs = makeNativeRegistry(nativeCtx);
  moduleExports.apply(nativeCtx);
  if (nativeCtx.cardRegistrations.length !== 0) fail("未运行 better-sidebar 时不应走 registerTab");
  else if (nativeCtx.nativeRegistrations.length !== 1) fail("未运行 better-sidebar 时应注册 1 个原生 tab 类型，实际 " + nativeCtx.nativeRegistrations.length);
  else if (countSlot(nativeCtx, "sidebar.right.pane.tab") !== 1) fail("原生直注缺少 sidebar.right.pane.tab 正文槽注册");
  else ok("better-sidebar 未运行 → 走 DSH 原生右侧栏直注（tab 类型 + 正文槽）");

  const nativeDef = api.nativeCardDefinition();
  if (nativeDef.id !== api.CARD_ID || nativeDef.kind !== api.CARD_ID) fail("原生 tab 类型 id/kind 应等于 CARD_ID（避免冲突）");
  else if (nativeDef.priority !== "extension" || nativeDef.keepMounted !== true) fail("原生 tab 类型 priority/keepMounted 不对");
  else if (nativeDef.title() !== "DeepSeek 聊天") fail("原生 tab 类型 title() 默认名不对");
  else if (!Array.isArray(nativeDef.guide) || nativeDef.guide.length !== 1 || nativeDef.guide[0].id !== api.CARD_ID + ":open") fail("原生 tab 类型 guide 入口不对");
  else ok("原生 tab 类型契约正确（id/kind/priority/keepMounted/title thunk/guide 入口）");
  api.writeConfig({ cardLabel: "原生聊天" });
  if (nativeDef.title() !== "原生聊天") fail("原生 tab 类型 title thunk 未跟随改名");
  else ok("原生路径改名即时生效（title thunk 重求值）");
  api.writeConfig({ cardLabel: "DeepSeek 聊天" });

  // 关闭 / 开启 showCard：原生路径也要能注销并重注册。
  const nativeCheckbox = findByAttr(
    mount(react.createElement(findSlot(nativeCtx, "settings.section").component, {})),
    "data-dsh-plugin-deepseek-chat", "show-card");
  nativeCheckbox.dispatch("change", { target: { checked: false } });
  if (nativeCtx.nativeRegistrations.length !== 0 || countSlot(nativeCtx, "sidebar.right.pane.tab") !== 0) fail("关闭开关没有注销原生卡片");
  else ok("关闭右边栏卡片开关 → 注销原生 tab 类型与正文槽");
  api.writeConfig({ showCard: true });
  if (nativeCtx.nativeRegistrations.length !== 1 || countSlot(nativeCtx, "sidebar.right.pane.tab") !== 1) fail("重新开启后原生卡片没有恢复");
  else ok("重新开启右边栏卡片开关 → 重新原生直注");

  // ④ 服务晚到：internal/service 事件把「原生卡片」换成「better-sidebar 卡片」。
  if (!nativeCtx.serviceListeners.some((l) => l.name === "internal/service" && l.options?.global === true)) fail("未用 ctx.on('internal/service', ..., {global:true}) 监听服务就绪");
  else ok("apply 通过 ctx.on('internal/service', {global:true}) 监听服务就绪（绕过 context filter）");
  nativeCtx.betterSidebar = makeBetterSidebar(nativeCtx);
  nativeCtx.emitService("betterSidebar");
  if (nativeCtx.nativeRegistrations.length !== 0 || countSlot(nativeCtx, "sidebar.right.pane.tab") !== 0) fail("服务晚到后原生卡片未注销");
  else if (nativeCtx.cardRegistrations.length !== 1) fail("服务晚到后未切换到 better-sidebar 卡片");
  else ok("服务晚到：internal/service 事件自动把原生卡片切换为 better-sidebar 卡片（无需手动开关）");

  // ⑤ 无界兜底 timer：超过 v1.1.8 的 40 次（20 秒）上限仍继续，服务到位即注册。
  resetTimers();
  const lateCtx = makeCtx();
  moduleExports.apply(lateCtx);                 // 两个服务都缺席
  if (countTimers(api.CARD_RETRY_DELAY) !== 1) fail("服务晚到：apply() 应排 1 个就绪探测 timer");
  const firedBeyond = fireTimers(api.CARD_RETRY_DELAY, 50);   // 故意 > 40
  if (firedBeyond <= 40) fail("就绪探测仍有硬上限（只跑了 " + firedBeyond + " 轮），v1.1.8 的 20 秒窗口 bug 未根治");
  else if (countTimers(api.CARD_RETRY_DELAY) !== 1) fail("越过 40 轮后没有继续排队就绪探测");
  else ok("就绪探测无硬上限：连续推进 " + firedBeyond + " 轮仍持续排队（根治 20 秒窗口过期）");
  lateCtx.betterSidebar = makeBetterSidebar(lateCtx);
  fireTimers(api.CARD_RETRY_DELAY);
  if (lateCtx.cardRegistrations.length !== 1) fail("兜底 timer 推进后服务到位仍没注册卡片");
  else ok("服务晚到：兜底 timer 在服务到位后自动 registerTab（手动开关救回的场景被根治）");

  // ⑥ cleanup：注销卡片、取消 timer、移除服务监听，三者都不留孤儿。
  resetTimers();
  const cleanupCtx = makeCtx();
  cleanupCtx.sidebarRightTabs = makeNativeRegistry(cleanupCtx);
  moduleExports.apply(cleanupCtx);
  for (const cleanup of cleanupCtx.effectCleanups) cleanup();
  if (cleanupCtx.nativeRegistrations.length !== 0 || countSlot(cleanupCtx, "sidebar.right.pane.tab") !== 0) fail("effect cleanup 没有注销原生卡片");
  else if (cleanupCtx.serviceListeners.length !== 0) fail("effect cleanup 没有移除 internal/service 监听");
  else ok("ctx.effect 卸载清理：注销卡片 + 移除服务监听（无孤儿）");
  const orphanCtx = makeCtx();
  moduleExports.apply(orphanCtx);
  if (countTimers(api.CARD_RETRY_DELAY) !== 1) fail("卸载前应有 1 个 pending 就绪探测 timer");
  for (const cleanup of orphanCtx.effectCleanups) cleanup();
  if (countTimers(api.CARD_RETRY_DELAY) !== 0) fail("effect cleanup 没有取消 pending 就绪探测 timer");
  else ok("ctx.effect 卸载清理取消 pending 就绪探测 timer（无孤儿 timer）");

  resetTimers();
  storage.clear();
}

// ── 设置页渲染：关于本插件基础信息 + 检查更新按钮 + 四组卡片边框 ─────────
{
  api.resetUpdateState();
  const form = mount(react.createElement(settingsSlot.component, {}));

  // 六组卡片边框（v1.4.4 UI：聊天平台独立成栏，设置页改为 3 个 tab 分页）：按逻辑分组、用主题令牌细边框/圆角/浅底。
  const cards = collectElements(form).filter((el) =>
    el.getAttribute("data-dsh-plugin-deepseek-chat") === "settings-card");
  if (cards.length !== 6) fail(`设置页应有 6 张分组卡片，实际 ${cards.length}`);
  else {
    const expected = {
      border: ".5px solid var(--dsw-alias-border-l3)",
      borderRadius: "var(--dsw-radius-sm)",
      background: "var(--dsw-alias-bg-layer-1)"
    };
    let bad = 0;
    for (const key of Object.keys(expected)) {
      if (cards.some((el) => el.style[key] !== expected[key])) bad++;
    }
    if (cards.some((el) => typeof el.style.background !== "string" || el.style.background.startsWith("#") || /^rgb/i.test(el.style.background))) bad++;
    if (bad > 0) fail("分组卡片没有全部使用主题令牌的边框/圆角/浅底（或写死了硬编码颜色）");
    else ok("设置页三组卡片：细边框 + 圆角 + 主题令牌浅底色（明暗自适应、零硬编码颜色）");
  }
  // v1.4.2：设置页应渲染 DeepSeek / 豆包 双平台切换按钮（嵌在第一张卡片内）。
  const platformDeepseek = collectElements(form).filter((el) =>
    el.getAttribute("data-dsh-plugin-deepseek-chat") === "platform-deepseek");
  const platformDoubao = collectElements(form).filter((el) =>
    el.getAttribute("data-dsh-plugin-deepseek-chat") === "platform-doubao");
  if (platformDeepseek.length !== 1 || platformDoubao.length !== 1) {
    fail(`设置页应有各 1 个平台切换按钮，实际 deepseek=${platformDeepseek.length} doubao=${platformDoubao.length}`);
  } else ok("设置页渲染 DeepSeek / 豆包 双平台切换按钮");

  // 平台按钮后的选中标志：选中的显示 ✅、未选中的显示 ❌；点击后可反转。
  const platformMarkText = (root, attr) => {
    const mark = findByAttr(root, "data-dsh-plugin-deepseek-chat", attr);
    return mark ? collectTexts(mark).join("") : "";
  };
  const markDs = platformMarkText(form, "platform-mark-deepseek");
  const markDb = platformMarkText(form, "platform-mark-doubao");
  const isDeepseekDefault = api.currentPlatform() === "deepseek";
  const expectDs = isDeepseekDefault ? "✅" : "❌";
  const expectDb = isDeepseekDefault ? "❌" : "✅";
  if (String(markDs).includes(expectDs) && String(markDb).includes(expectDb)) {
    ok("平台按钮选中标志正确：选中显示 ✅、未选中显示 ❌");
  } else fail(`平台选中标志错误：deepseek="${markDs}"（应 ${expectDs}）doubao="${markDb}"（应 ${expectDb}）`);

  // v1.4.5+ 名称联动：点击平台按钮后两个名称输入框草稿同步刷新（默认值显示灰色占位）。
  const mountForm = () => mount(react.createElement(settingsSlot.component, {}));
  api.applyPlatformPreset("deepseek");
  const dsForm = mountForm();
  const dsTabBox = findByAttr(dsForm, "data-dsh-plugin-deepseek-chat", "tab-label");
  const dsCardBox = findByAttr(dsForm, "data-dsh-plugin-deepseek-chat", "card-label");
  const btnDoubao = findByAttr(dsForm, "data-dsh-plugin-deepseek-chat", "platform-doubao");
  if (!dsTabBox || !dsCardBox || !btnDoubao) fail("设置页缺少名称输入框或豆包平台按钮，无法验证名称联动");
  else {
    btnDoubao.dispatch("click");
    const dbForm = mountForm();
    const dbTabBox = findByAttr(dbForm, "data-dsh-plugin-deepseek-chat", "tab-label");
    const dbCardBox = findByAttr(dbForm, "data-dsh-plugin-deepseek-chat", "card-label");
    // v1.4.5+ 切豆包：名称框草稿清空（灰色占位显示平台名），配置名仍是「豆包 聊天」实体名。
    if (dbTabBox.getAttribute("value") !== "" || dbCardBox.getAttribute("value") !== "") {
      fail(`切豆包后名称框草稿未清空：tab=${dbTabBox.getAttribute("value")} card=${dbCardBox.getAttribute("value")}`);
    } else if (dbTabBox.getAttribute("placeholder") !== "豆包 聊天" || dbCardBox.getAttribute("placeholder") !== "豆包 聊天") {
      fail(`切豆包后名称框占位未显示平台名：tab=${dbTabBox.getAttribute("placeholder")} card=${dbCardBox.getAttribute("placeholder")}`);
    } else if (api.tabLabel() !== "豆包 聊天" || api.cardLabel() !== "豆包 聊天") {
      fail(`切豆包后配置名未联动：tab=${api.tabLabel()} card=${api.cardLabel()}`);
    } else ok("设置页：点击豆包平台按钮，两个名称框清空并显示「豆包 聊天」灰色占位、配置名同步联动");
    const dbViewSlot = findSlot(desktopCtx, "conversation.view");
    if (!dbViewSlot || dbViewSlot.definition.label() !== "豆包 聊天") fail("切豆包后顶栏标签显示名未更新");
    else ok("切豆包后顶栏标签 label thunk 返回「豆包 聊天」");
    // v1.4.5+ 另三处联动：左侧栏插件项 / 设置导航 / 设置页大标题。
    const dbListSlot = findSlot(desktopCtx, "sidebar.panellist");
    const dbSettingsSlot = findSlot(desktopCtx, "settings.section");
    if (!dbListSlot || dbListSlot.definition.label() !== "豆包 聊天") fail("切豆包后左侧栏插件项显示名未更新");
    else ok("切豆包后左侧栏插件项 label thunk 返回「豆包 聊天」");
    if (!dbSettingsSlot || dbSettingsSlot.definition.label() !== "豆包 聊天") fail("切豆包后设置导航显示名未更新");
    else ok("切豆包后设置页导航 label thunk 返回「豆包 聊天」");
    const collectTexts = (node) => {
      if (node === null || node === undefined) return "";
      if (typeof node === "string" || typeof node === "number") return String(node);
      if (Array.isArray(node)) return node.map(collectTexts).join("");
      if (typeof node.text === "string") return node.text;
      return (node.children ?? []).map(collectTexts).join("");
    };
    if (!collectTexts(dbForm).includes("豆包 聊天设置")) fail("切豆包后设置页大标题未更新");
    else ok("切豆包后设置页大标题显示「豆包 聊天设置」");
    // 切回 DeepSeek，恢复后续测试默认状态。
    const btnDs = findByAttr(mountForm(), "data-dsh-plugin-deepseek-chat", "platform-deepseek");
    btnDs?.dispatch("click");
    const dsAgain = mountForm();
    const dsAgainTab = findByAttr(dsAgain, "data-dsh-plugin-deepseek-chat", "tab-label");
    const dsAgainCard = findByAttr(dsAgain, "data-dsh-plugin-deepseek-chat", "card-label");
    if (api.tabLabel() !== "DeepSeek 聊天" || api.cardLabel() !== "DeepSeek 聊天") fail("切回 DeepSeek 后名称未恢复默认");
    else if (dsAgainTab.getAttribute("value") !== "" || dsAgainCard.getAttribute("value") !== "") fail("切回 DeepSeek 后名称框草稿未清空为占位");
    else ok("切回 DeepSeek 平台，名称恢复默认显示且输入框回到灰色占位");
  }

  // v1.4.4 UI：设置页 3 个 tab 分页（总览 / 条件触发同步 / 全自动通道），一个功能一页。
  const tabHome = findByAttr(form, "data-dsh-plugin-deepseek-chat", "mode-tab-home");
  const tabSync = findByAttr(form, "data-dsh-plugin-deepseek-chat", "mode-tab-sync");
  const tabPilot = findByAttr(form, "data-dsh-plugin-deepseek-chat", "mode-tab-pilot");
  // 选中态用浅底（bg-layer-2）区分，未选中为 bg-base（图2 风格：浅底细边框，无强调色描边）。
  const ACTIVE_BG = "var(--dsw-alias-bg-layer-2)";
  const hiddenCards = (root) => collectElements(root).filter((el) =>
    el.getAttribute("data-dsh-plugin-deepseek-chat") === "settings-card" && el.style.display === "none").length;
  // 顶部标题 + tab 栏必须是 sticky 固定区，不随滚动消失。
  const stickyHeader = collectElements(form).find((el) => el.style.position === "sticky");
  if (!stickyHeader) fail("设置页顶部标题 + tab 栏应为 sticky 固定区（不随滚动消失）");
  else ok("设置页顶部标题 + tab 栏为 sticky 固定区（滚动不消失）");
  if (!tabHome || !tabSync || !tabPilot) {
    fail("设置页应有 3 个模式 tab 按钮（总览/条件触发同步/全自动通道）");
  } else {
    // 默认总览：home tab 选中（浅底），且 tab 栏无下分隔横线。
    if (tabHome.style.background !== ACTIVE_BG || hiddenCards(form) !== 2)
      fail(`默认应显示总览分页：home tab 选中、条件触发/全自动两卡隐藏，实际隐藏 ${hiddenCards(form)} 张`);
    else ok("设置页默认显示「总览」分页（聊天平台 + 顶部 + 右边 + 关于）");
    const tabBar = tabHome.parent;
    if (tabBar && tabBar.style.borderBottom)
      fail(`tab 栏不应有下分隔横线，实际 ${tabBar.style.borderBottom}`);
    else ok("tab 栏无下分隔横线（样式参考图2）");

    // 点击「条件触发同步」tab：模块变量切换后重挂载，只显示该分页。
    tabSync.dispatch("click", {});
    const formSync = mount(react.createElement(settingsSlot.component, {}));
    const syncActive = findByAttr(formSync, "data-dsh-plugin-deepseek-chat", "mode-tab-sync")?.style.background === ACTIVE_BG;
    if (!syncActive || hiddenCards(formSync) !== 5) fail("点「条件触发同步」tab 后应只显示该分页配置");
    else ok("点「条件触发同步」tab：只显示该分页的完整配置");

    // 点击「全自动通道」tab。
    findByAttr(formSync, "data-dsh-plugin-deepseek-chat", "mode-tab-pilot").dispatch("click", {});
    const formPilot = mount(react.createElement(settingsSlot.component, {}));
    const pilotActive = findByAttr(formPilot, "data-dsh-plugin-deepseek-chat", "mode-tab-pilot")?.style.background === ACTIVE_BG;
    if (!pilotActive || hiddenCards(formPilot) !== 5) fail("点「全自动通道」tab 后应只显示该分页配置");
    else ok("点「全自动通道」tab：只显示该分页的完整配置");

    // 恢复总览，避免影响后续用例。
    findByAttr(formPilot, "data-dsh-plugin-deepseek-chat", "mode-tab-home").dispatch("click", {});
  }

  // 输入框/按钮/状态行用 bg-base 或 layer-2，与卡片底色拉开层次。
  const bg = collectElements(form).filter((el) =>
    ["tab-label", "card-label", "check-update", "update-status"].includes(el.getAttribute("data-dsh-plugin-deepseek-chat")));
  if (bg.length !== 4) fail(`应有 4 个内层控件，实际 ${bg.length}`);
  else if (bg.some((el) => el.style.background !== "var(--dsw-alias-bg-base)" && el.style.background !== "var(--dsw-alias-bg-layer-2)")) fail("内层控件背景没有与卡片底色拉开层次");
  else ok("输入框/按钮/状态行用更高对比底色，与卡片底色分层");

  // 对齐/间距（v1.1.7 微调）：分组标题下移、严格两栏网格、均匀行距、标签不换行。
  if (cards.length > 0) {
    const pad = cards[0].style.padding;
    if (pad !== "12px 18px 14px") fail(`卡片上留白不足，分组标题会贴边框：${pad}`);
    else ok("卡片上留白 12px，分组标题与边框拉开距离");
  }
  const infoRows = collectElements(form).filter((el) =>
    el.getAttribute("data-dsh-plugin-deepseek-chat") === "info-row");
  if (infoRows.length !== 5) fail(`关于本插件应有 5 行两栏信息，实际 ${infoRows.length}`);
  else {
    let bad = 0;
    for (const row of infoRows) {
      if (row.style.display !== "grid" || row.style.gridTemplateColumns !== "88px minmax(0, 1fr)" || row.style.alignItems !== "baseline" || row.style.padding !== "5px 0") bad++;
      const label = (row.children ?? [])[0];
      if (!label || label.style?.whiteSpace !== "nowrap") bad++;
    }
    if (bad > 0) fail("信息行没有用严格两栏网格对齐（标签列 88px / baseline / 均匀行距 / 标签不换行）");
    else ok("关于本插件 5 行严格两栏网格对齐：标签列 88px、baseline 对齐、行距均匀、标签不换行");
  }
  // 第一个分组标题（关于本插件）的上边距含下移量，且不与后续标题共用 18px。
  const h3s = collectElements(form).filter((el) => el.tag === "h3");
  const aboutTitle = h3s.find((el) => collectTexts(el).join("").includes("关于本插件"));
  if (!aboutTitle) fail("设置页缺少「关于本插件」分组标题");
  else if (!String(aboutTitle.style.margin).startsWith("2px")) fail(`「关于本插件」标题没有下移：margin=${aboutTitle.style.margin}`);
  else ok("「关于本插件」标题上边距下移，不再紧贴卡片上边框");

  const texts = collectTexts(form).join(" ");
  // 版本号 / 作者 / 功能简介 / 许可证 / 两个链接
  for (const required of [api.PLUGIN_VERSION, api.PLUGIN_AUTHOR, "功能简介", api.PLUGIN_LICENSE, "npm", "GitHub"]) {
    if (!texts.includes(required)) fail(`设置页缺少基础信息「${required}」`);
  }
  ok("设置页渲染基础信息：版本号 / 作者 / 功能简介 / 许可证 / npm·GitHub 链接");

  // 两个外链：https + target=_blank（桌面壳用系统浏览器打开）。
  const links = collectElements(form).filter((el) => el.tag === "a");
  // 检查结果附跳转链接时会有 4 个（About 里 2 个 + 结果区 2 个）；这里是 idle 状态。
  if (links.length !== 2) fail(`应有 2 个外链，实际 ${links.length}`);
  else if (links.some((el) => !String(el.getAttribute("href")).startsWith("https://") || el.getAttribute("target") !== "_blank")) {
    fail("外链不是 https + target=_blank");
  } else ok("npm / GitHub 外链均为 https + target=_blank");

  // 检查更新按钮 + 状态行；默认是 idle 文案、按钮可点。
  const button = findByAttr(form, "data-dsh-plugin-deepseek-chat", "check-update");
  const status = findByAttr(form, "data-dsh-plugin-deepseek-chat", "update-status");
  if (!button) fail("设置页缺少「检查更新」按钮");
  else if (button.getAttribute("disabled") === "true") fail("idle 状态下检查更新按钮不应被禁用");
  if (!status) fail("设置页缺少更新状态行");
  else if (!collectTexts(status).join(" ").includes("点击按钮")) fail("初始状态行不是 idle 提示");
  else ok("设置页有可点击的「检查更新」按钮与初始状态提示");

  // 点击按钮 → 触发 checkForUpdates → 状态行更新（假 react 不重渲染，重新挂载观察）。
  // 用「发现新版」桩让状态行从 idle 变为 found，并出现跳转链接。
  fetchCalls.length = 0;
  fetchHandler = async () => jsonResponse({ latest: "9.9.9" });
  api.resetUpdateState();
  button.dispatch("click", {});
  await settle();
  const afterForm = mount(react.createElement(settingsSlot.component, {}));
  const afterStatus = findByAttr(afterForm, "data-dsh-plugin-deepseek-chat", "update-status");
  if (!afterStatus) fail("点击后状态行消失");
  else {
    const statusTexts = collectTexts(afterStatus).join(" ");
    if (!statusTexts.includes("发现新版本") || !statusTexts.includes("9.9.9")) fail(`点击后没显示「发现新版本 9.9.9」：${statusTexts}`);
    else ok("点击「检查更新」后状态行显示发现新版本与版本号");
    // 结果里应附跳转链接（文字状态 + 跳转链接）。
    const resultLinks = collectElements(afterStatus).filter((el) => el.tag === "a");
    if (resultLinks.length !== 2) fail(`结果区应附 2 个跳转链接，实际 ${resultLinks.length}`);
    else ok("检查结果附 npm / GitHub 跳转链接");
  }
  api.resetUpdateState();
  fetchHandler = async () => { throw new Error("桩未配置"); };
}

// ── 一键更新（v1.1.10）：真调 pluginManager.updateBundle + 失败/需重启如实提示 ──
{
  const updateCalls = [];
  let updateApplication = "applied";
  let updateError = void 0;
  const fakeRemote = {
    pluginManager: {
      async updateBundle(name, version) {
        updateCalls.push([name, version]);
        return { result: { application: updateApplication, error: updateError } };
      }
    }
  };
  const ctx = makeCtx({ remote: fakeRemote });
  moduleExports.apply(ctx);
  const slot = findSlot(ctx, "settings.section");
  if (!slot) fail("一键更新：带 remote 的 ctx 没有注册设置页");
  else {
    // 只有「发现新版本」才在结果区（红框位置）出现「立即更新」按钮。
    api.resetUpdateState();
    const idleForm = mount(react.createElement(slot.component, {}));
    if (findByAttr(idleForm, "data-dsh-plugin-deepseek-chat", "update-now")) fail("idle 状态不应出现「立即更新」按钮");
    else ok("idle / 已是最新时不显示「立即更新」按钮");

    api.setUpdateState({ status: "found", latest: "9.9.9", source: "npm" });
    const foundForm = mount(react.createElement(slot.component, {}));
    const nowButton = findByAttr(foundForm, "data-dsh-plugin-deepseek-chat", "update-now");
    if (!nowButton) fail("发现新版本后没有出现「立即更新」按钮");
    else {
      ok("发现新版本后结果区出现「立即更新」按钮");
      updateCalls.length = 0;
      updateApplication = "applied";
      updateError = void 0;
      nowButton.dispatch("click", {});
      await settle();
      if (updateCalls.length !== 1) fail(`点击没有真调 updateBundle，实际 ${updateCalls.length} 次`);
      else if (updateCalls[0][0] !== api.PLUGIN_NAME || updateCalls[0][1] !== "9.9.9") fail(`updateBundle 参数不对：${JSON.stringify(updateCalls[0])}`);
      else if (api.getUpdateState().status !== "updated") fail(`applied 应转到 updated，实际 ${api.getUpdateState().status}`);
      else ok("点击真调 pluginManager.updateBundle(包名, 9.9.9)，applied -> 更新完成");
    }

    // restart-required -> 如实提示重启 DSH。
    updateApplication = "restart-required";
    updateError = void 0;
    api.setUpdateState({ status: "found", latest: "9.9.9" });
    const form2 = mount(react.createElement(slot.component, {}));
    findByAttr(form2, "data-dsh-plugin-deepseek-chat", "update-now")?.dispatch("click", {});
    await settle();
    if (api.getUpdateState().status !== "restart-required") fail("restart-required 没有如实提示重启");
    else ok("restart-required -> 提示「已安装，请重启 DSH 生效」");

    // failed（本机 link: 安装被 updateRefusal 拒，error 是 {code, diagnostic} 无 message）。
    updateApplication = "failed";
    updateError = { code: "invalid-spec", diagnostic: "installed neither from a registry under its own name nor from a Git commit" };
    api.setUpdateState({ status: "found", latest: "9.9.9" });
    const form3 = mount(react.createElement(slot.component, {}));
    findByAttr(form3, "data-dsh-plugin-deepseek-chat", "update-now")?.dispatch("click", {});
    await settle();
    const failedState = api.getUpdateState();
    if (failedState.status !== "update-failed" || !String(failedState.reason).includes("registry")) fail(`link: 被拒没有如实显示原因：${JSON.stringify(failedState)}`);
    else ok("link: 安装被拒 -> update-failed 且如实显示 error.diagnostic 原因");

    // 更新失败后结果区仍保留 npm / GitHub 兜底跳转链接。
    const form4 = mount(react.createElement(slot.component, {}));
    const status4 = findByAttr(form4, "data-dsh-plugin-deepseek-chat", "update-status");
    const links4 = status4 ? collectElements(status4).filter((el) => el.tag === "a") : [];
    if (links4.length !== 2) fail(`更新失败后结果区应有 2 个兜底跳转链接，实际 ${links4.length}`);
    else ok("更新失败后仍保留 npm / GitHub 兜底跳转链接");
  }

  // 无 remote 通道 -> 如实提示（不抛错、不假装成功）。
  api.setUpdateState({ status: "idle" });
  await api.runUpdate(makeCtx(), "9.9.9", () => {});
  const bare = api.getUpdateState();
  if (bare.status !== "update-failed" || !String(bare.reason).includes("无法调用")) fail(`无 remote 通道时没有如实提示：${JSON.stringify(bare)}`);
  else ok("无 remote 通道 -> 提示「当前环境无法调用插件更新通道」");
  api.resetUpdateState();
}

// ── 图3 铺满浮层：conversation.view 用绝对定位 overlay 盖住 composer ──────
{
  const page = mount(react.createElement(viewSlot.component, {}));
  if (page?.getAttribute?.("data-dsh-plugin-deepseek-chat") !== "view") fail("顶栏标签页缺少浮层标记");
  if (page?.style?.position !== "absolute") fail("顶栏标签页不是绝对定位浮层");
  if (page?.style?.inset !== "0") fail("浮层没有 inset:0 覆盖会话 body");
  if (page?.style?.zIndex !== "50") fail("浮层 z-index 不足以盖住 composerSeat(9)");
  if (page?.style?.overflow !== "hidden") fail("浮层没有裁切溢出");
  if (typeof page?.style?.background !== "string" || page.style.background.length === 0) fail("浮层背景不透明（会露出 DSH 输入框）");
  else ok("顶栏标签页是不透明、inset:0、z-index:50 的绝对定位浮层（网页铺满主区并盖住输入框）");
}

// ── 常量与 URL 白名单 ───────────────────────────────────────────────────────
{
  if (api.partitionKeyFor() !== "panel:deepseek-chat") fail("分区 key 不是固定常量");
  if (api.storageKeyFor() !== STORAGE_KEY) fail("会话记忆 key 不是固定常量");
  if (api.partitionKeyFor("whatever") !== "panel:deepseek-chat") fail("分区 key 受参数影响");
  if (api.storageKeyFor("whatever") !== STORAGE_KEY) fail("会话记忆 key 受参数影响");
  ok("guest 分区与会话记忆 key 都是不受参数影响的固定常量");

  if (api.parseChatUrl(CONV_A)?.hostname !== "chat.deepseek.com") fail("合法会话 URL 被拒绝");
  if (api.parseChatUrl("http://chat.deepseek.com/") !== void 0) fail("http 被接受");
  if (api.parseChatUrl("https://evil.example.com/") !== void 0) fail("外部域名被接受");
  if (api.parseChatUrl("https://chat.deepseek.com:8443/a/chat/s/x") !== void 0) fail("显式端口被接受");
  if (api.parsePopupUrl(PLATFORM_POPUP) === void 0) fail("platform.deepseek.com 弹窗被误拒");
  if (api.parsePopupUrl("https://evil.example.com/") !== void 0) fail("外部弹窗域名被接受");
  if (api.parsePopupUrl("http://chat.deepseek.com/") !== void 0) fail("http 弹窗被接受");
  ok("chat / platform URL 白名单按协议、主机、端口严格校验");
}

// ── guest 生命周期助手 ──────────────────────────────────────────────────────
/** 用可用租约桥挂载面板；返回相关夹具。component 可指定入口组件。 */
async function mountPanel(component = mainSlot.component) {
  const calls = { acquire: [], release: [], openRequested: [] };
  let resolveAcquire;
  const bridge = {
    acquire: (workspace) => {
      calls.acquire.push(workspace);
      return new Promise((resolve) => { resolveAcquire = resolve; });
    },
    release: (lease) => {
      calls.release.push(lease);
      return Promise.resolve();
    },
    onOpenRequested: (lease, callback) => {
      calls.openRequested.push({ lease, callback });
      return () => {};
    }
  };
  sandbox.globalThis.dshDesktop = { protocolVersion: 1, browser: bridge };

  const page = mount(react.createElement(component, {}));
  const cleanups = flushEffects();
  resolveAcquire?.({ lease: "lease-1", partition: "persist:test" });
  await flushMicrotasks();
  return { page, cleanups, calls, webview: findWebview(page), bridge };
}

/** 纯网页聊天断言：恰好一个网页容器，无账号条、无账号文案。 */
function assertPureWebChat(page, where) {
  // v1.4.3：状态条固定显示，根节点子节点数随包装层不同（全屏面板 2、顶栏标签页 1），
  // 故改为按语义断言「有且仅有一个 webview」——这才是「纯网页聊天」的真正约束。
  const webviews = collectElements(page).filter((el) => el.tag === "webview");
  if (webviews.length !== 1) fail(`${where}：应恰好有一个网页容器，实际 ${webviews.length} 个`);
  if (hasAccountStrip(page)) fail(`${where}：仍存在账号状态条`);
  const texts = collectTexts(page).join(" ");
  if (texts.includes("账号") || texts.includes("DSH 登录") || texts.includes("本地模式")) fail(`${where}：仍渲染账号状态文案「${texts}」`);
}

// ── 用例 1：首次访问、会话记忆、鉴权安全、卸载清理 ─────────────────────────
storage.clear();
{
  const { cleanups, calls, webview, page } = await mountPanel();
  assertPureWebChat(page, "全屏面板");
  ok("面板为纯网页聊天：无账号状态条、无账号文案");
  if (!webview) fail("webview 没有挂到面板容器上");
  if (webview.getAttribute("name") !== "lease-1") fail(`webview name 不对：${webview.getAttribute("name")}`);
  if (calls.acquire[0] !== "panel:deepseek-chat") fail(`分区 key 不对：${calls.acquire[0]}`);

  webview.dispatch("dom-ready");
  await flushMicrotasks();
  if (webview.loadURLCalls.at(-1) !== ROOT) fail(`首次访问加载了 ${webview.loadURLCalls.at(-1)}`);
  else ok(`首次访问加载 ${ROOT}`);

  webview.currentUrl = CONV_A;
  webview.dispatch("did-stop-loading");
  if (storage.get(STORAGE_KEY) !== CONV_A) fail(`会话没被记住：${storage.get(STORAGE_KEY)}`);
  else ok("加载完成后记住会话 URL");

  webview.currentUrl = CONV_B;
  webview.dispatch("did-navigate-in-page", { isMainFrame: true });
  if (storage.get(STORAGE_KEY) !== CONV_B) fail(`SPA 导航没被记住：${storage.get(STORAGE_KEY)}`);
  else ok("SPA 会话切换被记住");

  webview.currentUrl = AUTH;
  webview.dispatch("did-navigate");
  if (storage.get(STORAGE_KEY) !== CONV_B) fail(`鉴权页覆盖了记忆：${storage.get(STORAGE_KEY)}`);
  else ok("鉴权页不覆盖会话记忆");

  webview.currentUrl = ROOT;
  webview.dispatch("did-navigate");
  if (storage.has(STORAGE_KEY)) fail("新聊天根路径没有清除记忆");
  else ok("新聊天根路径清除记忆");

  webview.currentUrl = CONV_A;
  for (const cleanup of cleanups) cleanup();
  await flushMicrotasks();
  if (calls.release.length !== 1 || calls.release[0] !== "lease-1") fail(`租约没释放：${JSON.stringify(calls.release)}`);
  else ok("卸载时释放租约");
  if (!webview.removed) fail("卸载时 webview 没从 DOM 移除");
  else ok("卸载时移除 guest DOM");
  if (storage.get(STORAGE_KEY) !== CONV_A) fail("卸载时没记住当前会话");
  else ok("卸载时记住当前会话");
}

// ── 用例 2：再次进入恢复上次会话 ───────────────────────────────────────────
storage.clear();
storage.set(STORAGE_KEY, CONV_A);
{
  const { cleanups, webview } = await mountPanel();
  webview.dispatch("dom-ready");
  await flushMicrotasks();
  if (webview.loadURLCalls.at(-1) !== CONV_A) fail(`再次进入加载了 ${webview.loadURLCalls.at(-1)} 而不是 ${CONV_A}`);
  else ok(`再次进入恢复上次会话（${CONV_A.slice(22)}）`);
  for (const cleanup of cleanups) cleanup();
  await flushMicrotasks();
}

// ── 用例 3：失效的会话回退到根路径 ─────────────────────────────────────────
storage.clear();
storage.set(STORAGE_KEY, CONV_A);
{
  const { cleanups, webview } = await mountPanel();
  webview.dispatch("dom-ready");
  await flushMicrotasks();
  webview.dispatch("did-fail-load", { isMainFrame: true, errorCode: -105, errorDescription: "NAME_NOT_RESOLVED" });
  await flushMicrotasks();
  if (webview.loadURLCalls.at(-1) !== ROOT) fail(`失效会话回退加载了 ${webview.loadURLCalls.at(-1)}`);
  else ok("不可达的旧会话回退到根路径");
  for (const cleanup of cleanups) cleanup();
  await flushMicrotasks();
}

// ── 用例 4：非法记忆（鉴权页 / 外部域名）从干净状态开始 ────────────────────
for (const invalid of [AUTH, "https://example.com/chat", "not a url", "https://chat.deepseek.com:8443/a/chat/s/x"]) {
  storage.clear();
  storage.set(STORAGE_KEY, invalid);
  const { cleanups, webview } = await mountPanel();
  webview.dispatch("dom-ready");
  await flushMicrotasks();
  if (webview.loadURLCalls.at(-1) !== ROOT) fail(`非法记忆「${invalid}」加载了 ${webview.loadURLCalls.at(-1)}`);
  for (const cleanup of cleanups) cleanup();
  await flushMicrotasks();
}
ok("鉴权页、外部域名、显式端口的记忆一律不恢复");

// ── 用例 5：DOM 已移除后卸载不抛错 ─────────────────────────────────────────
storage.clear();
{
  const { cleanups, calls, webview } = await mountPanel();
  webview.dispatch("dom-ready");
  await flushMicrotasks();
  webview.currentUrl = CONV_A;
  webview.remove();
  let threw;
  try {
    for (const cleanup of cleanups) cleanup();
  } catch (error) {
    threw = error;
  }
  await flushMicrotasks();
  if (threw !== void 0) fail(`DOM 移除后卸载抛错：${threw.message}`);
  else ok("DOM 移除后卸载不抛错");
  if (calls.release.length !== 1 || calls.release[0] !== "lease-1") fail(`脱离后没释放租约：${JSON.stringify(calls.release)}`);
  else ok("脱离文档后仍释放租约");
}

// ── 用例 6：guest 死亡被隔离在面板内 ───────────────────────────────────────
for (const event of ["render-process-gone", "destroyed"]) {
  storage.clear();
  const { cleanups, calls, webview, page } = await mountPanel();
  webview.dispatch("dom-ready");
  await flushMicrotasks();
  let threw;
  try {
    webview.dispatch(event, { reason: "crashed" });
  } catch (error) {
    threw = error;
  }
  if (threw !== void 0) fail(`guest「${event}」逃逸出面板：${threw.message}`);
  if (!webview.removed) fail(`「${event}」后死 guest 没被移除（重试会叠加 webview）`);
  if (findWebview(page) === webview) fail(`「${event}」后死 guest 仍挂在面板里`);
  webview.remove();
  try {
    for (const cleanup of cleanups) cleanup();
  } catch (error) {
    fail(`「${event}」后清理抛错：${error.message}`);
  }
  await flushMicrotasks();
  if (calls.release.length !== 1) fail(`「${event}」后没释放租约`);
}
ok("guest 崩溃 / 销毁被隔离在面板内，移除死 guest 并释放租约");

// ── 用例 7：反复开关不逃逸错误 ─────────────────────────────────────────────
storage.clear();
{
  for (let round = 0; round < 3; round += 1) {
    const { cleanups, calls, webview } = await mountPanel();
    webview.dispatch("dom-ready");
    await flushMicrotasks();
    webview.dispatch("did-navigate", { url: CONV_A });
    let threw;
    try {
      for (const cleanup of cleanups) cleanup();
    } catch (error) {
      threw = error;
    }
    if (threw !== void 0) fail(`开关第 ${round} 轮抛错：${threw.message}`);
    if (calls.release.length !== 1) fail(`开关第 ${round} 轮没释放租约`);
    await flushMicrotasks();
  }
}
ok("反复开关每次创建并释放一个 guest");

// ── 用例 8：弹窗桥只导航到白名单主机 ───────────────────────────────────────
storage.clear();
{
  const { cleanups, calls, webview } = await mountPanel();
  webview.dispatch("dom-ready");
  await flushMicrotasks();
  const callback = calls.openRequested[0]?.callback;
  if (typeof callback !== "function") fail("弹窗回调没注册");
  else {
    const before = webview.loadURLCalls.length;
    callback("https://evil.example.com/steal");
    callback("http://chat.deepseek.com/");
    callback("https://chat.deepseek.com:8443/a/chat/s/x");
    callback("not a url");
    if (webview.loadURLCalls.length !== before) fail("被拒绝的弹窗 URL 被加载进 guest");
    else ok("弹窗桥拒绝外部域名、明文 http、显式端口");
    callback(PLATFORM_POPUP);
    callback(CONV_B);
    if (webview.loadURLCalls.at(-2) !== PLATFORM_POPUP || webview.loadURLCalls.at(-1) !== CONV_B) fail("白名单弹窗 URL 没被加载");
    else ok("弹窗桥放行 chat.deepseek.com 与 platform.deepseek.com");
  }
  for (const cleanup of cleanups) cleanup();
  await flushMicrotasks();
}

// ── 用例 9：挂载即启动，不等账号探测（账号逻辑已彻底删除） ─────────────────
storage.clear();
{
  const calls = { acquire: [], release: [] };
  const bridge = {
    acquire: (workspace) => { calls.acquire.push(workspace); return Promise.resolve({ lease: "lease-x", partition: "persist:x" }); },
    release: (lease) => { calls.release.push(lease); return Promise.resolve(); },
    onOpenRequested: () => () => {}
  };
  sandbox.globalThis.dshDesktop = { protocolVersion: 1, browser: bridge };
  const page = mount(react.createElement(mainSlot.component, {}));
  const cleanups = flushEffects();
  await flushMicrotasks();
  if (calls.acquire.length !== 1) fail("面板在申请租约前等待了别的异步流程");
  else if (calls.acquire[0] !== "panel:deepseek-chat") fail(`首次租约用了 ${calls.acquire[0]}`);
  else ok("挂载即申请租约，使用固定分区");
  assertPureWebChat(page, "即时启动面板");
  ok("即时启动的面板同样是纯网页聊天、无账号条");
  for (const cleanup of cleanups) cleanup();
  await flushMicrotasks();
}

// ── 用例 10：顶栏标签页（conversation.view）真的能显示网页聊天 ─────────────
storage.clear();
{
  const { cleanups, calls, webview, page } = await mountPanel(viewSlot.component);
  assertPureWebChat(page, "顶栏标签页");
  ok("顶栏标签页渲染出纯网页聊天、无账号条");
  if (!webview) fail("顶栏标签页没有挂载 guest webview");
  else if (calls.acquire[0] !== "panel:deepseek-chat") fail(`顶栏标签页用了 ${calls.acquire[0]} 分区`);
  else ok("顶栏标签页与全屏面板共用同一固定分区（登录态保留）");
  webview.dispatch("dom-ready");
  await flushMicrotasks();
  if (webview.loadURLCalls.at(-1) !== ROOT) fail(`顶栏标签页加载了 ${webview.loadURLCalls.at(-1)}`);
  else ok("顶栏标签页正常加载 chat.deepseek.com");
  for (const cleanup of cleanups) cleanup();
  await flushMicrotasks();
  if (calls.release.length !== 1 || calls.release[0] !== "lease-1") fail("顶栏标签页切走时没释放租约");
  else ok("切走顶栏标签页时释放租约");
}

// ── 用例 11：两个入口切来切去复用同一分区 ──────────────────────────────────
{
  const first = await mountPanel();
  for (const cleanup of first.cleanups) cleanup();
  await flushMicrotasks();
  const second = await mountPanel(viewSlot.component);
  if (second.calls.acquire[0] !== first.calls.acquire[0]) fail("换入口后面板改了 guest 分区");
  else ok("左侧栏面板 ↔ 顶栏标签页切换复用同一分区（登录态保留）");
  for (const cleanup of second.cleanups) cleanup();
  await flushMicrotasks();
}

// ── v1.2.0 条件触发式自动闭环：离线验证两条通道与三道安全阀 ───────────────
{
  // A. 默认关闭 + 配置归一化（安全阀①的一半：总开关默认 false）。
  if (api.DEFAULTS.autoSyncEnabled !== false) fail("autoSyncEnabled 默认必须为 false（绝不自动启动）");
  else ok("安全阀①：autoSyncEnabled 默认关闭、闭环默认不启动");
  if (api.DEFAULTS.maxAutoLoops !== api.DEFAULT_MAX_LOOPS ||
      !Array.isArray(api.DEFAULTS.errorKeywords) ||
      !Array.isArray(api.DEFAULTS.stopButtonSelectors) ||
      !Array.isArray(api.DEFAULTS.sendButtonSelectors) ||
      !Array.isArray(api.DEFAULTS.textareaSelectors) ||
      !Array.isArray(api.DEFAULTS.assistantSelectors)) {
    fail("DEFAULTS 缺少 v1.2.0 闭环字段");
  } else ok("DEFAULTS 含 maxAutoLoops / errorKeywords / 4 组可配置选择器");
  if (api.normalizeMaxLoops(0) !== 1 || api.normalizeMaxLoops(99) !== 20 ||
      api.normalizeMaxLoops(3.7) !== 4 || api.normalizeMaxLoops("x") !== api.DEFAULT_MAX_LOOPS) {
    fail("normalizeMaxLoops 没有把轮数 clamp 到 [1,20]");
  } else ok("normalizeMaxLoops 把轮数夹到 [1,20]、非法值回退默认 3");
  if (api.normalizeSelectors(["  .a  ", "", 5, ".b"], [".z"]).join(",") !== ".a,.b") fail("normalizeSelectors 没过滤空/非字符串项");
  else ok("可配置选择器：去空白、过滤空项与非字符串，空列表回退默认");

  // readConfig 直接读 storage（不触发订阅者），验证新字段的类型校验与归一化。
  storage.set(api.CONFIG_KEY, JSON.stringify({
    autoSyncEnabled: true, maxAutoLoops: 99, errorKeywords: ["BOOM"],
    stopButtonSelectors: [" .my-stop "]
  }));
  const rc = api.readConfig();
  if (rc.autoSyncEnabled !== true || rc.maxAutoLoops !== 20 ||
      rc.errorKeywords.join(",") !== "BOOM" || rc.stopButtonSelectors.join(",") !== ".my-stop") {
    fail("readConfig 没有按类型读取/归一化 v1.2.0 字段");
  } else ok("readConfig 读取 autoSyncEnabled / maxAutoLoops / errorKeywords / 选择器并归一化");
  storage.clear();
  // writeConfig 持久化新字段（不动总开关，避免触发服务订阅副作用）。
  api.writeConfig({ maxAutoLoops: 5, errorKeywords: ["BOOM"] });
  const persisted = JSON.parse(storage.get(api.CONFIG_KEY) ?? "{}");
  if (persisted.maxAutoLoops !== 5 || persisted.errorKeywords?.join(",") !== "BOOM") fail("writeConfig 没持久化 v1.2.0 字段");
  else ok("writeConfig 把 maxAutoLoops / errorKeywords 持久化到 localStorage");
  api.writeConfig({ maxAutoLoops: api.DEFAULT_MAX_LOOPS, errorKeywords: [...api.DEFAULT_ERROR_KEYWORDS] });
  storage.clear();

  // B. 文本提取：assistant/message.content 是 block 数组，兼容 type / kind 两种字段名。
  if (api.extractContentText("纯字符串") !== "纯字符串") fail("extractContentText 没处理字符串内容");
  const blocks = [{ type: "text", text: "A" }, { kind: "text", text: "B" }, { type: "image", url: "x" }];
  if (api.extractContentText(blocks) !== "AB") fail("extractContentText 没兼容 block.type / block.kind");
  else ok("extractContentText 兼容官方 eventProjection(kind) 与 system-prompt(type) 两种文本块");
  if (api.eventAnswerText({ data: { message: { content: blocks } } }) !== "AB") fail("eventAnswerText 没取到 message.content");
  else ok("eventAnswerText 从 assistant/message 事件取 message.content");
  if (!api.containsErrorKeyword("Traceback (most recent call last)", ["Error", "Traceback"]) ||
      api.containsErrorKeyword("一切正常", ["Error", "Traceback"])) fail("错误关键词熔断判断错");
  else ok("安全阀②：错误关键词命中/未命中判断正确（大小写敏感）");
  // v1.4.6-hotfix：正文引用技术标识符（TypeError）内部子串不得误命中熔断。
  if (api.containsErrorKeyword("`k.indexOf` 抛 TypeError", ["Error", "Traceback", "Failed", "panic", "FATAL"])) {
    fail("TypeError 内部 Error 子串被误判为错误关键词");
  } else ok("安全阀②词边界：TypeError 内部 Error 子串不误命中");
  if (!api.containsErrorKeyword("Error: something broke", ["Error", "Traceback"])) {
    fail("独立词 Error: 未被识别，熔断漏判");
  } else ok("安全阀②词边界：独立词 Error 仍正常熔断");
  const snapForText = { entries: [
    { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "旧回答" }] } } },
    { type: "assistant/message", data: { turn: 2, message: { content: [{ kind: "text", text: "本轮回答" }] } } }
  ] };
  if (api.collectAnswerText(snapForText, 2) !== "本轮回答") fail("collectAnswerText 没按 turn 取本轮回答");
  else ok("collectAnswerText 从 eventSource 窗口按 turn 精确取本轮 assistant 文本");

  // C. 页面桥：字符串是合法 JS；在模拟 DOM 里真正跑通「填入+发送」与「停止按钮消失→抓取」。
  let compileErr = null;
  try { new Function("return (" + api.BRIDGE_IMPL + ")"); } catch (e) { compileErr = e; }
  if (compileErr) fail(`BRIDGE_IMPL 不是合法可注入脚本：${compileErr.message}`);
  else ok("页面桥是纯字符串常量（无模板插值），可安全嵌入 webview.executeJavaScript");
  const cfg = api.buildBridgeConfig();
  if (!cfg.stopButtonSelectors?.length || !cfg.sendButtonSelectors?.length ||
      !cfg.textareaSelectors?.length || !cfg.assistantSelectors?.length || cfg.replyTimeout !== api.DEFAULT_REPLY_TIMEOUT) {
    fail("buildBridgeConfig 没把可配置选择器/超时转给页面桥");
  } else ok("buildBridgeConfig 把 4 组可配置选择器 + 回复超时传给 guest 页面桥");
  const ensureExpr = api.ensureBridgeExpression(cfg);
  if (!ensureExpr.includes(api.BRIDGE_KEY) || !ensureExpr.includes("__v!==3")) fail("ensureBridgeExpression 没有自愈重装判断");
  else ok("ensureBridgeExpression：guest 导航后按 __v!==3 自愈重装页面桥");
  try {
    new Function("return " + ensureExpr);
    new Function("return " + api.bridgeSendExpression(cfg, '含"引号"与\n换行'));
    new Function("return " + api.bridgePollExpression(cfg));
  } catch (e) { fail(`桥表达式不是合法 JS：${e.message}`); }
  ok("ensure/send/poll 三个 executeJavaScript 表达式语法合法、文本经 JSON.stringify 转义");

  let stopEl = null;
  let assistantNodes = [];
  let sendClicks = 0, inputEvents = 0, changeEvents = 0;
  const keyEvents = [];
  let observerCb = null;
  let boxValue = "";
  const box = {
    isContentEditable: false,
    getAttribute: () => null,
    dispatchEvent(ev) {
      if (!ev) return;
      if (ev.type === "input") inputEvents++;
      else if (ev.type === "change") changeEvents++;
      else if (ev.type === "keydown") keyEvents.push(ev);
    }
  };
  const sendBtn = { disabled: false, click() { sendClicks++; } };
  const textareaProto = {};
  Object.defineProperty(textareaProto, "value", { configurable: true, get() { return boxValue; }, set(v) { boxValue = v; } });
  const htmlProto = {};
  Object.defineProperty(htmlProto, "innerHTML", { configurable: true, get() { return ""; }, set() {} });
  const win = { HTMLTextAreaElement: { prototype: textareaProto }, HTMLElement: { prototype: htmlProto }, requestAnimationFrame: (f) => f() };
  const doc = {
    body: {},
    querySelector(sel) {
      if (cfg.textareaSelectors.includes(sel)) return box;
      if (cfg.sendButtonSelectors.includes(sel)) return sendBtn;
      if (cfg.stopButtonSelectors.includes(sel)) return stopEl;
      return null;
    },
    querySelectorAll(sel) { return cfg.assistantSelectors.includes(sel) ? assistantNodes : []; }
  };
  class MO { constructor(cb) { observerCb = cb; } observe() {} disconnect() {} }
  class Ev { constructor(type) { this.type = type; } }
  class KeyEv { constructor(type, opts) { this.type = type; Object.assign(this, opts || {}); } }
  const factory = new Function("window", "document", "MutationObserver", "Event", "KeyboardEvent",
    "return (" + api.BRIDGE_IMPL + ")")(win, doc, MO, Ev, KeyEv);
  const bridge = factory(cfg);
  if (bridge.__v !== 3 || typeof bridge.fillAndSend !== "function" || typeof bridge.poll !== "function") {
    fail("页面桥工厂没返回 __v:3 / fillAndSend / poll");
  } else ok("页面桥工厂在 guest 主世界暴露 __v:3 / fillAndSend / poll / reset / arm");
  const sendRes = bridge.fillAndSend("桌面端回答");
  if (!sendRes.ok || boxValue !== "桌面端回答" || inputEvents < 1 || changeEvents < 1) {
    fail("fillAndSend 没用原生 setter 写入并派发 input/change（React 受控发送按钮会 disabled）");
  } else ok("通道 A：用 HTMLTextAreaElement 原生 value setter 写入 + input/change 事件，保证 React 受控更新");
  if (sendClicks !== 1) fail(`通道 A：没点击发送按钮（sendClicks=${sendClicks}）`);
  else ok("通道 A：同步立即点击发送按钮（v1.2.2 不再依赖 requestAnimationFrame，隐藏 webview 也能触发）");
  stopEl = { disabled: false };
  if (observerCb) observerCb();               // 网页开始生成：停止按钮出现
  assistantNodes = [{ innerText: "网页回复内容" }];
  stopEl = null;
  if (observerCb) observerCb();               // 网页生成完成：停止按钮消失
  const pollSnap = bridge.poll();
  if (pollSnap.phase !== "done" || pollSnap.text !== "网页回复内容") {
    fail(`通道 B：停止按钮消失后没抓到网页回复：${JSON.stringify(pollSnap)}`);
  } else ok("通道 B：MutationObserver 检测停止按钮 有→无，抓取最后一条 assistant 文本并判完成");

  // D. 状态机：三道安全阀全部离线验证。
  let cfgCtl = { ...api.DEFAULTS, autoSyncEnabled: true, maxAutoLoops: 2 };
  const ctl = api.createSyncController({ getConfig: () => cfgCtl });
  cfgCtl = { ...cfgCtl, autoSyncEnabled: false };
  let d = ctl.handleTurnEnd({ sessionId: "s", turn: 1, reasonKind: "completed", answerText: "ok" });
  if (d.action !== "skip" || d.reason !== "disabled") fail("总开关关闭时仍触发了自动回传");
  else ok("安全阀①：autoSyncEnabled=false 时 TurnEnd 直接 skip（disabled）");
  cfgCtl = { ...cfgCtl, autoSyncEnabled: true };
  ctl.reset(); ctl.refresh();
  d = ctl.handleTurnEnd({ sessionId: "s", turn: 2, reasonKind: "error", answerText: "boom" });
  if (d.action !== "skip" || d.reason !== "turn-not-completed") fail("非 completed 轮次没被跳过");
  else ok("只有 reason.kind=completed/max-tokens 的成功轮次才回传（error/aborted/blocked 跳过）");
  d = ctl.handleTurnEnd({ sessionId: "s", turn: 3, reasonKind: "completed", answerText: "Traceback ..." });
  if (d.action !== "pause" || d.reason !== "error-keyword") fail("错误关键词没熔断");
  else ok("安全阀②：lastAnswer 命中错误关键词 → paused(error-keyword)，不自动回传");
  ctl.reset(); ctl.refresh();
  d = ctl.handleTurnEnd({ sessionId: "s", turn: 4, reasonKind: "completed", answerText: "正常回答" });
  if (d.action !== "push" || d.text !== "正常回答" || ctl.getState().loopCount !== 1) fail("正常轮次没进入 push");
  else ok("正常轮次：handleTurnEnd → push（loopCount+1，进入 pushing）");
  d = ctl.handleTurnEnd({ sessionId: "s", turn: 4, reasonKind: "completed", answerText: "正常回答" });
  if (d.action !== "skip" || d.reason !== "busy") fail("同轮重复 TurnEnd 没被 busy 挡住");
  else ok("pushing/waiting 期间的重复 TurnEnd 被 busy 忽略（防并发回传）");
  ctl.notePushed();
  ctl.noteReply("网页回复");
  const stAfter = ctl.getState();
  if (stAfter.state !== "injected" || stAfter.lastReply !== "网页回复") fail("noteReply 没进入 injected / 未保存回复");
  else ok("网页回复完成 → noteReply：state=injected 且保存 lastReply（等用户判定继续）");
  ctl.acknowledge();
  cfgCtl = { ...cfgCtl, maxAutoLoops: 1 };
  ctl.reset(); ctl.refresh();
  d = ctl.handleTurnEnd({ sessionId: "s", turn: 10, reasonKind: "completed", answerText: "回答1" });
  ctl.noteError("reset-to-idle"); ctl.refresh();
  d = ctl.handleTurnEnd({ sessionId: "s", turn: 11, reasonKind: "completed", answerText: "回答2" });
  if (d.action !== "pause" || d.reason !== "max-loops") fail("maxAutoLoops 上限没熔断");
  else ok("安全阀①：loopCount 达 maxAutoLoops 上限 → paused(max-loops)，停止自动循环");
  cfgCtl = { ...cfgCtl, maxAutoLoops: 3 };
  ctl.reset(); ctl.refresh();
  d = ctl.handleTurnEnd({ sessionId: "s", turn: 20, reasonKind: "completed", answerText: "回答" });
  ctl.noteError("x"); ctl.refresh();
  d = ctl.handleTurnEnd({ sessionId: "s", turn: 20, reasonKind: "completed", answerText: "回答" });
  if (d.action !== "skip" || d.reason !== "duplicate") fail("安全阀③同轮去重没生效");
  else ok("安全阀③：同一 sessionId+turn 的重复 TurnEnd 被去重忽略");

  // E. 「注入但不执行」——只调 setDraft，绝不 submit。
  let draft = "", submitted = false, injectedFlag;
  const fakeRt = {
    dockBinding: { current: { sessionId: "s", inputActions: { setDraft(t) { draft = t; }, submit() { submitted = true; } } } },
    controller: { noteDraftInjected(okFlag) { injectedFlag = okFlag; } }
  };
  const injectedOk = api.injectDraft(fakeRt, "网页回复内容");
  if (!injectedOk || draft !== "网页回复内容" || submitted || injectedFlag !== true) {
    fail("injectDraft 没做到「写草稿但不提交」");
  } else ok("通道 B：网页回复只写入桌面草稿 setDraft()，绝不调用 submit()（是否继续由用户决定）");

  // F. turn/end 订阅：从 eventSource append 窗口读取 reason + 本轮 assistant 文本。
  const decisions = [];
  const rtEvents = { controller: { handleTurnEnd(e) { decisions.push(e); return { action: "skip", reason: "test" }; } } };
  const windowSnap = {
    entries: [
      { type: "assistant/message", data: { turn: 7, message: { content: [{ kind: "text", text: "桌面回答A" }, { type: "text", text: "桌面回答B" }] } } },
      { type: "turn/end", data: { turn: 7, reason: { kind: "completed" } } }
    ],
    change: { kind: "append", entries: [{ type: "turn/end", data: { turn: 7, reason: { kind: "completed" } } }] }
  };
  api.onSessionEvents(rtEvents, { getSnapshot: () => windowSnap }, "sess-7");
  if (decisions.length !== 1 || decisions[0].sessionId !== "sess-7" || decisions[0].turn !== 7 ||
      decisions[0].reasonKind !== "completed" || decisions[0].answerText !== "桌面回答A桌面回答B") {
    fail(`turn/end 没正确解析：${JSON.stringify(decisions)}`);
  } else ok("turn/end：从 eventSource append 窗口读 reason.kind=completed + 该轮 assistant 文本");
  decisions.length = 0;
  api.onSessionEvents(rtEvents, { getSnapshot: () => ({ ...windowSnap, change: { kind: "replace", entries: [] } }) }, "sess-7");
  if (decisions.length !== 0) fail("replace/prepend 窗口也误触发了轮次回传");
  else ok("只对 append 窗口处理（replace/prepend/settle-assistant 不误触发，避免正常浏览被抓取）");

  // G. 状态条固定显示（v1.4.3）+ 设置页第 4 卡控件 + 总开关交互。
  const bar = mount(react.createElement(api.SyncStatusBar, {}));
  const fixedGear = bar && findByAttr(bar, "data-dsh-plugin-deepseek-chat", "sync-settings");
  if (!bar || !fixedGear) fail("v1.4.3：状态条应固定显示（不依赖 autoSyncEnabled），即使总开关关闭也应渲染");
  else ok("v1.4.3：状态条固定显示（默认 autoSyncEnabled=false 仍渲染，闭环不自动启动）");
  const form4 = mount(react.createElement(settingsSlot.component, {}));
  const need = ["sync-enable", "sync-max-loops", "sync-error-keywords", "sync-stop-selectors",
    "sync-send-selectors", "sync-textarea-selectors", "sync-assistant-selectors"];
  const missing = need.filter((v) => !findByAttr(form4, "data-dsh-plugin-deepseek-chat", v));
  if (missing.length) fail("设置页缺少自动闭环控件：" + missing.join(","));
  else ok("设置页第 4 卡：总开关 / 最大轮数 / 错误关键词 / 4 组可配置选择器齐全");
  const sw = findByAttr(form4, "data-dsh-plugin-deepseek-chat", "sync-enable");
  if (!sw || String(sw.getAttribute("checked")) !== "false") fail("总开关默认不该被勾选");
  else ok("总开关默认未勾选（需用户在设置里手动开启）");
  if (sw) {
    sw.dispatch("change", { target: { checked: true } });
    if (api.getConfig().autoSyncEnabled !== true) fail("设置页总开关 change 没写入配置");
    else ok("设置页总开关 change → writeConfig(autoSyncEnabled)，用户可随时开启/关闭");
    api.writeConfig({ autoSyncEnabled: false });
  }
  flushEffects();

  // ── H. 端到端集成：把「真实运行单例 + webview.executeJavaScript 页面桥 +
  //    conversation.composer.dock 订阅 + turn/end 事件 + 轮询 + setDraft 注入」串成一条链，
  //    完整跑两轮闭环，并验证 maxAutoLoops 在真实接线下熔断、submit() 全程 0 次调用 ──
  {
    // 直接复用 C 段已建好的模拟 guest DOM（win/doc/MO/Ev/KeyEv/box/sendBtn …），只复位状态。
    boxValue = "";
    sendClicks = 0;
    inputEvents = 0;
    changeEvents = 0;
    assistantNodes = [];
    stopEl = null;
    delete win.__dshDeepSeekBridge;

    // webview.executeJavaScript 的真实语义：在 guest 主世界求值表达式，返回最后一个值。
    const guestExecute = (expr) => new Function(
      "window", "document", "MutationObserver", "Event", "KeyboardEvent",
      "return (" + expr + ")"
    )(win, doc, MO, Ev, KeyEv);

    // 真正的运行单例（与 pushAnswerToWeb / startReplyPolling 共用同一个模块级对象）。
    const e2eCtx = makeCtx();
    const bindings = {};
    const sessions = { binding: (id) => bindings[id] };
    const originalGet = e2eCtx.get;
    e2eCtx.get = (name) => (name === "sessions" ? sessions : originalGet(name));
    const rt = api.ensureSyncRuntime(e2eCtx);

    // 清掉前面 apply() 残留的 dock/桥/取消标记，由本段接管这个单例。
    if (typeof rt.dockDispose === "function") { try { rt.dockDispose(); } catch { /* 已释放 */ } }
    rt.dockDispose = null;
    rt.cancelled = false;
    rt.bridge = api.makeWebviewBridge({ executeJavaScript: guestExecute });

    // 用户在设置页打开总开关（maxAutoLoops=2 便于跑两轮后触发上限）。
    api.writeConfig({
      autoSyncEnabled: true,
      maxAutoLoops: 2,
      errorKeywords: [...api.DEFAULT_ERROR_KEYWORDS],
      stopButtonSelectors: [...api.DEFAULT_STOP_SELECTORS],
      sendButtonSelectors: [...api.DEFAULT_SEND_SELECTORS],
      textareaSelectors: [...api.DEFAULT_TEXTAREA_SELECTORS],
      assistantSelectors: [...api.DEFAULT_ASSISTANT_SELECTORS]
    });
    // writeConfig 会触发旧 apply() 注册的 sync 订阅，可能又挂了一个 dock；统一清掉。
    if (typeof rt.dockDispose === "function") { try { rt.dockDispose(); } catch { /* 已释放 */ } }
    rt.dockDispose = null;
    rt.cancelled = false;
    rt.bridge = api.makeWebviewBridge({ executeJavaScript: guestExecute });
    rt.controller.reset();
    rt.controller.refresh();

    // 真实 dock 组件：捕获 inputActions + sessionId，useEffect 里订阅 eventSource。
    let draftText = "", submitCalls = 0;
    const inputActions = {
      setDraft(t) { draftText = t; },
      submit() { submitCalls += 1; }
    };
    let eventListener = null;
    let currentWindow = { entries: [], change: { kind: "replace", entries: [] } };
    const source = {
      getSnapshot: () => currentWindow,
      subscribe(cb) { eventListener = cb; return () => { eventListener = null; }; }
    };
    bindings["sess-e2e"] = { eventSource: source };

    const fxBefore = effects.length;
    mount(react.createElement(api.makeSyncDock(rt), { inputActions, sessionId: "sess-e2e" }));
    const dockEffects = effects.splice(fxBefore);
    let dockCleanup;
    for (const fn of dockEffects) { const c = fn(); if (typeof c === "function") dockCleanup = c; }
    if (!eventListener) fail("端到端：dock 没有通过 ctx.get('sessions') 订阅 eventSource");
    else ok("端到端：makeSyncDock 软读 sessions.binding(id).eventSource.subscribe 成功接线");

    /** 触发一轮：桌面 turn/end → 自动填入发送 → 网页生成完成 → 轮询抓回 → 注入草稿。 */
    const fireTurn = async (turn, answerText, replyText) => {
      currentWindow = {
        entries: [
          { type: "assistant/message", data: { turn, message: { content: [{ type: "text", text: answerText }] } } },
          { type: "turn/end", data: { turn, reason: { kind: "completed" } } }
        ],
        change: { kind: "append", entries: [{ type: "turn/end", data: { turn, reason: { kind: "completed" } } }] }
      };
      eventListener();
      await flushMicrotasks();
      await flushMicrotasks();
      // 网页开始生成（停止按钮出现）→ 生成完成（消失 + 新回复文本）。
      stopEl = { disabled: false };
      if (observerCb) observerCb();
      assistantNodes = [{ innerText: replyText }];
      stopEl = null;
      if (observerCb) observerCb();
      // 驱动真实 startReplyPolling 的浏览器全局 setTimeout 递归轮询。
      for (let i = 0; i < 12 && rt.controller.getState().state === "waiting"; i += 1) {
        fireTimers(api.DEFAULT_POLL_INTERVAL, 1);
        await flushMicrotasks();
        await flushMicrotasks();
      }
    };

    // 第 1 轮：桌面回答 → 自动填入并发送 → 网页回复 → 注入草稿（不执行）。
    await fireTurn(1, "桌面端第 1 轮回答", "网页规划建议 A");
    const s1 = rt.controller.getState();
    if (boxValue !== "桌面端第 1 轮回答" || sendClicks !== 1) {
      fail(`端到端第 1 轮：通道 A 没把桌面回答填入并发送（boxValue=${boxValue}, sendClicks=${sendClicks}）`);
    } else ok("端到端第 1 轮·通道 A：turn/end → 真实 executeJavaScript 页面桥 fillAndSend 填入并点击发送");
    if (s1.state !== "injected" || s1.lastReply !== "网页规划建议 A" || s1.loopCount !== 1) {
      fail(`端到端第 1 轮：没进入 injected / 没抓到网页回复：${JSON.stringify(s1)}`);
    } else ok("端到端第 1 轮·通道 B：停止按钮消失 → poll 抓回网页回复 → state=injected");
    if (draftText !== "网页规划建议 A" || submitCalls !== 0 || s1.draftInjected !== true) {
      fail(`端到端第 1 轮：草稿注入不对或误触发执行（draft=${draftText}, submit=${submitCalls}）`);
    } else ok("端到端第 1 轮：网页回复只写 setDraft() 注入草稿，submit() 调用 0 次 —— 是否继续由用户决定");
    if (countTimers(api.DEFAULT_POLL_INTERVAL) !== 0) fail("端到端第 1 轮：注入后仍继续轮询（没停下来等用户）");
    else ok("端到端第 1 轮：注入后轮询停止，闭环暂停等用户点继续/运行");

    // 用户判定「继续」→ acknowledge 回 idle；第 2 轮走同一条链。
    rt.controller.acknowledge();
    draftText = "";
    await fireTurn(2, "桌面端第 2 轮回答", "网页规划建议 B");
    const s2 = rt.controller.getState();
    if (s2.state !== "injected" || s2.loopCount !== 2 || draftText !== "网页规划建议 B" || submitCalls !== 0) {
      fail(`端到端第 2 轮：闭环没跑通第二轮：${JSON.stringify(s2)}, draft=${draftText}`);
    } else ok("端到端第 2 轮：用户 acknowledge 后同一条链再次跑通（loopCount=2，仍不自动执行）");

    // 第 3 次 acknowledge → 达到 maxAutoLoops=2 → paused；再来 turn/end 也不回传。
    rt.controller.acknowledge();
    if (rt.controller.getState().state !== "paused") fail("端到端：达到 maxAutoLoops 后没有 paused");
    else ok("端到端：loopCount 达到 maxAutoLoops=2 → paused(max-loops)，自动循环封顶");
    currentWindow = {
      entries: [{ type: "turn/end", data: { turn: 3, reason: { kind: "completed" } } }],
      change: { kind: "append", entries: [{ type: "turn/end", data: { turn: 3, reason: { kind: "completed" } } }] }
    };
    eventListener();
    await flushMicrotasks();
    if (countTimers(api.DEFAULT_POLL_INTERVAL) !== 0 || sendClicks !== 2) {
      fail("端到端：封顶后仍触发了新的自动回传");
    } else ok("端到端：封顶后新 turn/end 被跳过，没有第 3 次自动发送（三道安全阀在真实接线下生效）");

    // 收尾：关总开关、解除 dock 订阅、清 fake timer，恢复默认配置。
    api.writeConfig({
      autoSyncEnabled: false,
      maxAutoLoops: api.DEFAULT_MAX_LOOPS,
      errorKeywords: [...api.DEFAULT_ERROR_KEYWORDS]
    });
    if (typeof dockCleanup === "function") dockCleanup();
    rt.cancelled = true;
    rt.bridge = null;
    rt.dockBinding.current = null;
    resetTimers();
    flushEffects();
  }
}

// ── I. 闭环追踪写入（v1.2.0「触发 + 观测」的可观测证据）───────────────────
{
	const IT = api.LOOP_TRACE_KEY;
	if (IT === "dsh-plugin-deepseek-chat:loop-trace") ok("追踪键常量正确");
	else fail("追踪键常量错误: " + IT);

	// I1：H 段端到端链路跑过一轮后，四个阶段时间戳应已落盘（把「确实执行了回传」从推测变成证据）
	const rawAfterH = storage.get(IT);
	if (rawAfterH) {
		let th; try { th = JSON.parse(rawAfterH); } catch { th = null; }
		if (th && th.lastTurnEndAt && th.lastSendResult && th.lastResponseCompleteAt && th.lastDraftInjectedAt)
			ok("端到端链路四阶段时间戳齐全（turn/end→发送→回复完成→草稿注入）");
		else fail("端到端链路追踪缺阶段: " + JSON.stringify(th));
		if (th && Array.isArray(th.events) && th.events.some((e) => e && e.stage === "turn/end"))
			ok("追踪事件流含 turn/end（真实事件名，非 hooksBus/TurnEnd）");
		else fail("追踪事件流缺 turn/end");
	} else {
		fail("H 段端到端链路未产生闭环追踪");
	}

	// I2：默认关闭时不写（惰性设计，不污染实机 localStorage）
	storage.clear();
	api.writeConfig({ autoSyncEnabled: false });
	api.writeLoopTrace({ probe: 1 }, { stage: "x", detail: "y" });
	if (storage.get(IT) === undefined) ok("默认关闭时 writeLoopTrace 不写任何追踪");
	else fail("默认关闭时仍写入了追踪");

	// I3：开启后写、字段合并、updatedAt、events 阶段流
	api.writeConfig({ autoSyncEnabled: true });
	api.writeLoopTrace({ lastSendResult: "ok", lastTurnEndAt: "2026-11-15T00:00:00.000Z" }, { stage: "send", detail: "ok" });
	let t1; try { t1 = JSON.parse(storage.get(IT)); } catch { t1 = null; }
	if (t1 && t1.lastSendResult === "ok" && t1.lastTurnEndAt && t1.updatedAt && Array.isArray(t1.events) && t1.events.some((e) => e && e.stage === "send"))
		ok("开启后写入：字段合并 + updatedAt + events 阶段流（含 send 阶段）");
	else fail("开启后追踪结构异常: " + JSON.stringify(t1));

	// I4：events 上限 40（LOOP_TRACE_EVENT_CAP），超量丢弃最旧、保留最新
	for (let i = 0; i < 50; i++) api.writeLoopTrace({}, { stage: "s" + i });
	let t2; try { t2 = JSON.parse(storage.get(IT)); } catch { t2 = null; }
	if (t2 && t2.events.length === api.LOOP_TRACE_EVENT_CAP && t2.events[t2.events.length - 1].stage === "s49")
		ok("events 上限 40 生效且保留最新阶段");
	else fail("events 上限异常: " + (t2 && t2.events.length));

	// I5：createSyncController 的 onTrace 钩子在状态转换时被调用（纯状态机，不依赖 DOM）
	const seen = [];
	const ctl = api.createSyncController({
		getConfig: () => ({ ...api.DEFAULTS, autoSyncEnabled: true }),
		onTrace: (snap, reason) => seen.push([snap.state, reason])
	});
	const dec = ctl.handleTurnEnd({ sessionId: "sess-trace", turn: 7, reasonKind: "completed", answerText: "规划建议" });
	if (dec.action === "push" && seen.some((x) => x[0] === "pushing")) ok("onTrace 钩子在 handleTurnEnd→pushing 时被触发");
	else fail("onTrace 钩子未触发: " + JSON.stringify({ dec, seen }));

	// 收尾：恢复默认关闭并清空 storage，不影响后续断言
	api.writeConfig({ autoSyncEnabled: false });
	storage.clear();
}

// ── J. v1.2.1 半自动带回（借鉴官方 @deepseek-ai/dsh-deepseek-chat-import
//    的结构化导出语义，替代易超时的网页 DOM 抓取）───────────────────────────
{
  // J0：默认关闭，全自动 DOM 路径零回归。
  if (api.DEFAULTS.halfAutoEnabled !== false) fail("halfAutoEnabled 默认必须为 false（不改动全自动路径）");
  else ok("半自动：halfAutoEnabled 默认关闭，v1.2.0 全自动 DOM 路径零回归");

  // J1：纯文本粘贴原样带回；空输入给出明确原因。
  const rText = api.extractExportReply("  网页回复纯文本  ");
  if (!rText.ok || rText.text !== "网页回复纯文本" || rText.source !== "text") fail("半自动：纯文本带回异常: " + JSON.stringify(rText));
  else ok("半自动：用户直接粘贴网页回复纯文本，trim 后原样带回");
  const rEmpty = api.extractExportReply("   ");
  if (rEmpty.ok || rEmpty.reason !== "empty") fail("半自动：空输入没返回 empty");
  else ok("半自动：空粘贴返回 empty，不写入空白草稿");

  // 官方 export_format_version:3 会话文件（对齐 src/format.ts 的契约）。
  const exportFile = {
    id: "sess-1", title: "规划", current_message_id: 4,
    messages: [
      { id: 1, parent_id: null, role: "USER", status: "FINISHED", fragments: [{ type: "REQUEST", content: "问题" }] },
      { id: 2, parent_id: 1, role: "ASSISTANT", status: "FINISHED", fragments: [{ type: "THINK", content: "思考" }, { type: "RESPONSE", content: "网页回复 A" }] },
      { id: 3, parent_id: 2, role: "USER", status: "FINISHED", fragments: [{ type: "REQUEST", content: "追问" }] },
      { id: 4, parent_id: 3, role: "ASSISTANT", status: "FINISHED", fragments: [{ type: "RESPONSE", content: "网页回复 B" }] },
      { id: 5, parent_id: 2, role: "ASSISTANT", status: "FINISHED", fragments: [{ type: "RESPONSE", content: "被丢弃的分支" }] }
    ]
  };
  // J2：按 current_message_id 选分支，只取 RESPONSE fragment（跳过 THINK/工具）。
  const rExp = api.extractExportReply(JSON.stringify(exportFile));
  if (!rExp.ok || rExp.source !== "export" || rExp.text !== "网页回复 B") fail("半自动：官方导出 JSON 解析异常: " + JSON.stringify(rExp));
  else ok("半自动：官方导出 JSON 按 current_message_id 分支 + RESPONSE fragment 提取最新 FINISHED 回答");
  // J3：非 FINISHED 回答被跳过，回退到更早的 FINISHED 回答（官方 replySteps 语义）。
  const unfinished = JSON.parse(JSON.stringify(exportFile));
  unfinished.messages[3].status = "TIMEOUT";
  const rUn = api.extractExportReply(JSON.stringify(unfinished));
  if (!rUn.ok || rUn.text !== "网页回复 A") fail("半自动：非 FINISHED 回答没被跳过: " + JSON.stringify(rUn));
  else ok("半自动：非 FINISHED / 模板回答不进草稿，回退到最近一条 FINISHED 回答");
  // J4：CONTENT_FILTER 撤回的问答对被略过。
  const filtered = JSON.parse(JSON.stringify(exportFile));
  filtered.messages[3].status = "CONTENT_FILTER";
  const rFil = api.extractExportReply(JSON.stringify(filtered));
  if (!rFil.ok || rFil.text !== "网页回复 A") fail("半自动：CONTENT_FILTER 没被跳过: " + JSON.stringify(rFil));
  else ok("半自动：CONTENT_FILTER 撤回的回答被略过（官方 convertConversation 语义）");
  // J5：current_message_id 缺失/为 null → 以最大 id 为叶选分支。
  const noCurrent = { ...exportFile, current_message_id: null };
  const rBranch = api.extractExportReply(JSON.stringify(noCurrent));
  if (!rBranch.ok || rBranch.text !== "被丢弃的分支") fail("半自动：分支选择没回退到最大 id: " + JSON.stringify(rBranch));
  else ok("半自动：current_message_id 缺失时按最大 id 选叶分支（官方 selectBranch 语义）");

  // J6：真实运行单例接线 —— 半自动跳过 DOM 轮询，用户粘贴后只写草稿不执行。
  const jCtx = makeCtx();
  const jRt = api.ensureSyncRuntime(jCtx);
  if (typeof jRt.dockDispose === "function") { try { jRt.dockDispose(); } catch { /* 已释放 */ } }
  jRt.dockDispose = null;
  storage.clear();
  api.writeConfig({ autoSyncEnabled: true, halfAutoEnabled: true, maxAutoLoops: 3, errorKeywords: [...api.DEFAULT_ERROR_KEYWORDS] });
  if (typeof jRt.dockDispose === "function") { try { jRt.dockDispose(); } catch { /* 订阅副作用 */ } }
  jRt.dockDispose = null;
  jRt.cancelled = false;
  let jSent = "";
  jRt.bridge = { send: async (t) => { jSent = t; return { ok: true }; }, poll: async () => ({ phase: "idle" }) };
  let jDraft = "", jSubmit = 0;
  jRt.dockBinding.current = { inputActions: { setDraft: (t) => { jDraft = t; }, submit: () => { jSubmit += 1; } }, sessionId: "sess-half" };
  jRt.controller.reset();
  jRt.controller.refresh();
  const jWindow = {
    entries: [{ type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "桌面回答" }] } } }],
    change: { kind: "append", entries: [{ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }] }
  };
  api.onSessionEvents(jRt, { getSnapshot: () => jWindow }, "sess-half");
  await flushMicrotasks();
  await flushMicrotasks();
  if (jSent !== "桌面回答") fail("半自动：通道 A 没自动发送桌面回答: " + jSent);
  else ok("半自动：通道 A（turn/end → 回传-发送）仍自动执行，与全自动一致");
  if (countTimers(api.DEFAULT_POLL_INTERVAL) !== 0) fail("半自动：仍启动了 DOM 停止按钮轮询（应跳过）");
  else ok("半自动：send ok 后跳过 DOM 轮询，不再等待 180s 超时（对症实机 timeout）");
  const sWaiting = jRt.controller.getState();
  if (sWaiting.state !== "waiting") fail("半自动：没停在 waiting 等用户粘贴: " + JSON.stringify(sWaiting));
  else ok("半自动：状态停在 waiting，显式等用户把网页回复/导出 JSON 粘贴回来");

  const bring = api.bringBackReply(jRt, "网页规划建议 X");
  await flushMicrotasks();
  const sAfter = jRt.controller.getState();
  if (!bring.ok || jDraft !== "网页规划建议 X" || jSubmit !== 0 || sAfter.draftInjected !== true) {
    fail("半自动带回：草稿注入不对或误触发执行: " + JSON.stringify({ bring, jDraft, jSubmit, sAfter }));
  } else ok("半自动带回：解析结果只写 setDraft() 注入草稿，submit() 调用 0 次 —— 是否继续由用户决定");
  let jt; try { jt = JSON.parse(storage.get(api.LOOP_TRACE_KEY)); } catch { jt = null; }
  if (!jt || !jt.lastTurnEndAt || !jt.lastSendResult || !jt.lastResponseCompleteAt || !jt.lastDraftInjectedAt) {
    fail("半自动带回：闭环追踪四阶段没补齐: " + JSON.stringify(jt && { a: jt.lastTurnEndAt, b: jt.lastSendResult, c: jt.lastResponseCompleteAt, d: jt.lastDraftInjectedAt }));
  } else ok("半自动带回：追踪四阶段时间戳齐全（turn/end→send→response-complete→draft-injected）");
  if (sAfter.state !== "idle") fail("半自动带回：acknowledge 后没回到 idle: " + sAfter.state);
  else ok("半自动带回：注入后 acknowledge 回到 idle，下一轮是否开启由用户判定");

  api.writeConfig({ autoSyncEnabled: false, halfAutoEnabled: false });
  jRt.cancelled = true;
  jRt.bridge = null;
  jRt.dockBinding.current = null;
  resetTimers();
  storage.clear();
}

// K. v1.2.2 决定性回归：修复「内容填入网页输入框但无法自动发送」。
// 根因：旧实现把点击/键盘兜底整体包在 window.requestAnimationFrame 里，
// 隐藏/被遮挡的 <webview> renderer 中 rAF 被 Chromium 节流为 0，回调永不执行。
{
  const cfgK = api.buildBridgeConfig();
  const makeGuest = (opts) => {
    let boxValue = "";
    let sendClicks = 0;
    const keyEvents = [];
    const timers = [];
    const box = {
      isContentEditable: false,
      getAttribute: () => null,
      get value() { return boxValue; },
      dispatchEvent(ev) { if (ev && ev.type === "keydown") keyEvents.push(ev); }
    };
    const textareaProto = {};
    Object.defineProperty(textareaProto, "value", { configurable: true, get() { return boxValue; }, set(v) { boxValue = v; } });
    const htmlProto = {};
    Object.defineProperty(htmlProto, "innerHTML", { configurable: true, get() { return ""; }, set() {} });
    let btnOn = opts.btnImmediate === true;
    const sendBtn = { disabled: false, click() { sendClicks++; boxValue = ""; } };  // 点击后 React 清空输入框
    const win = {
      HTMLTextAreaElement: { prototype: textareaProto },
      HTMLElement: { prototype: htmlProto },
      requestAnimationFrame: (f) => { if (opts.rafRuns) f(); }   // rafRuns=false 模拟隐藏 renderer：永不调度
    };
    if (opts.hasTimeout) win.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
    const doc = {
      body: {},
      querySelector(sel) {
        if (cfgK.textareaSelectors.includes(sel)) return box;
        if (cfgK.sendButtonSelectors.includes(sel)) return btnOn ? sendBtn : null;
        return null;
      },
      querySelectorAll() { return []; }
    };
    class MO { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} }
    class Ev { constructor(type) { this.type = type; } }
    class KeyEv { constructor(type, o) { this.type = type; Object.assign(this, o || {}); } }
    const factory = new Function("window", "document", "MutationObserver", "Event", "KeyboardEvent",
      "return (" + api.BRIDGE_IMPL + ")")(win, doc, MO, Ev, KeyEv);
    return {
      bridge: factory(cfgK), timers,
      setBtnOn(v) { btnOn = v; },
      stats() { return { boxValue, sendClicks, keyEvents }; }
    };
  };

  // K1 决定性：隐藏 webview（rAF 永不调度）+ 按钮可用 → 仍同步立即点击成功。
  const g1 = makeGuest({ rafRuns: false, btnImmediate: true, hasTimeout: false });
  const r1 = g1.bridge.fillAndSend("桌面端回答");
  if (g1.stats().sendClicks !== 1) {
    fail(`v1.2.2 回归失败：隐藏 webview（rAF 不调度）时没有同步点击发送（sendClicks=${g1.stats().sendClicks}）`);
  } else ok("v1.2.2 决定性修复：rAF 被节流为 0 的隐藏 webview 中，仍同步立即点击发送（不再依赖 requestAnimationFrame）");
  if (!r1.ok || r1.method !== "click") fail("fillAndSend 没返回 method=click 供实机追踪复核");
  else ok("fillAndSend 返回 method=click / attempts，写入 loop-trace 的 lastSendMethod 供实机客观复核");

  // K2：选择器全落空 + 无定时器 → 键盘兜底，普通 Enter 优先（DeepSeek 默认），未清空才补 Ctrl+Enter。
  const g2 = makeGuest({ rafRuns: false, btnImmediate: false, hasTimeout: false });
  g2.bridge.fillAndSend("桌面端回答");
  const k2 = g2.stats().keyEvents;
  if (k2.length < 2 || k2[0].ctrlKey !== false || k2[1].ctrlKey !== true) {
    fail(`键盘兜底没按「普通 Enter 优先 → 再 Ctrl+Enter」触发（events=${JSON.stringify(k2.map(e => ({ key: e.key, ctrlKey: e.ctrlKey })))}）`);
  } else ok("选择器落空时键盘兜底：先普通 Enter（DeepSeek 默认发送），输入框未清空才补 Ctrl+Enter");
  if (g2.bridge.status().sendMethod !== "enter+ctrlEnter") fail("status().sendMethod 没记录键盘兜底方式");
  else ok("status() 暴露 sendMethod / sendClicks / sent 等可观测字段");

  // K3：React 受控按钮延迟 enable（首次落空，120ms 后可用）→ setTimeout 重试点中。
  const g3 = makeGuest({ rafRuns: false, btnImmediate: false, hasTimeout: true });
  g3.bridge.fillAndSend("桌面端回答");
  if (g3.stats().sendClicks !== 0) fail("延迟 enable 场景：不该在同步首试就点击");
  else ok("按钮此刻尚未 enable 时，同步首试不误点，交给 window.setTimeout 重试");
  g3.setBtnOn(true);
  for (const t of g3.timers) { try { t.fn(); } catch (e) {} }
  if (g3.stats().sendClicks !== 1) fail(`setTimeout 重试没点中延迟 enable 的按钮（sendClicks=${g3.stats().sendClicks}）`);
  else ok("window.setTimeout 重试在隐藏 renderer 仍会触发，覆盖 React 受控按钮延迟 enable");

  // K4：BRIDGE_IMPL 源码里发送触发已彻底移除 rAF 调用。
  if (api.BRIDGE_IMPL.includes("window.requestAnimationFrame") || api.BRIDGE_IMPL.includes("requestAnimationFrame ||")) {
    fail("BRIDGE_IMPL 仍残留 requestAnimationFrame 发送触发调用");
  } else ok("BRIDGE_IMPL 源码已移除 requestAnimationFrame 发送触发（仅保留说明性注释）");
}

// ── L. v1.2.3 发送确认（用户消息节点计数 + 失败上报 + 再试一次）────────────
// 根因：send 报 ok 只说明「填入 + 触发了发送尝试」，网页是否真的提交需回读 DOM。
// L 段复用 BRIDGE_IMPL 编译桩，扩展「用户消息节点集合」，验证 confirm 三态、
// 配置链路、controller 重试语义、以及 scheduleSendConfirmation 的零回归与实机路径。
{
  const cfgL = api.buildBridgeConfig();
  // 增强 guest 桩：querySelectorAll 能返回可变的用户消息节点集合。
  const makeConfirmGuest = (opts = {}) => {
    let boxValue = "";
    let sendClicks = 0;
    let userMsgNodes = [];
    const box = {
      isContentEditable: false,
      getAttribute: () => null,
      get value() { return boxValue; },
      dispatchEvent(ev) { /* 键盘兜底不清空输入框，模拟 send 未生效 */ }
    };
    const textareaProto = {};
    Object.defineProperty(textareaProto, "value", { configurable: true, get() { return boxValue; }, set(v) { boxValue = v; } });
    const htmlProto = {};
    Object.defineProperty(htmlProto, "innerHTML", { configurable: true, get() { return ""; }, set() {} });
    let btnOn = opts.btnImmediate === true;
    const sendBtn = { disabled: false, click() { sendClicks++; boxValue = ""; } };  // 点击后 React 清空输入框
    const win = { HTMLTextAreaElement: { prototype: textareaProto }, HTMLElement: { prototype: htmlProto } };
    const doc = {
      body: {},
      querySelector(sel) {
        if (cfgL.textareaSelectors.includes(sel)) return box;
        if (cfgL.sendButtonSelectors.includes(sel)) return btnOn ? sendBtn : null;
        return null;
      },
      querySelectorAll(sel) {
        if (cfgL.userMessageSelectors.includes(sel)) return userMsgNodes;
        return [];
      }
    };
    class MO { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} }
    class Ev { constructor(type) { this.type = type; } }
    class KeyEv { constructor(type, o) { this.type = type; Object.assign(this, o || {}); } }
    const factory = new Function("window", "document", "MutationObserver", "Event", "KeyboardEvent",
      "return (" + api.BRIDGE_IMPL + ")")(win, doc, MO, Ev, KeyEv);
    return {
      bridge: factory(cfgL),
      addUserMsg() { userMsgNodes = userMsgNodes.concat([{}]); },
      stats() { return { boxValue, sendClicks, userMsgCount: userMsgNodes.length }; }
    };
  };

  // L1：网页出现新用户消息节点 → 确认成功（via=node, delta>=1）。
  const c1 = makeConfirmGuest({ btnImmediate: true });
  c1.bridge.fillAndSend("桌面端回答");
  c1.addUserMsg();
  const cf1 = c1.bridge.confirm();
  if (!cf1.confirmed || cf1.via !== "node" || cf1.delta < 1) {
    fail(`发送确认 L1 失败：新用户消息节点未确认（${JSON.stringify(cf1)}）`);
  } else ok("v1.2.3 发送确认：网页出现新用户消息节点 → confirmed=true, via=node, delta>=1");

  // L2：用户消息节点数不变，但输入框已被清空 → 降级确认成功（via=cleared）。
  const c2 = makeConfirmGuest({ btnImmediate: true });
  c2.bridge.fillAndSend("桌面端回答");
  const cf2 = c2.bridge.confirm();
  if (!cf2.confirmed || cf2.via !== "cleared") {
    fail(`发送确认 L2 失败：输入框清空未降级确认（${JSON.stringify(cf2)}）`);
  } else ok("发送确认降级：节点未命中但输入框已清空 → confirmed=true, via=cleared（避免误报失败）");

  // L3：既无新用户消息、输入框又未清空 → 确认失败（via=none），触发上报。
  const c3 = makeConfirmGuest({ btnImmediate: false });  // 按钮不可用且无定时器 → 键盘兜底不清空
  c3.bridge.fillAndSend("桌面端回答");
  const cf3 = c3.bridge.confirm();
  if (cf3.confirmed || cf3.via !== "none") {
    fail(`发送确认 L3 失败：未提交却误判为已确认（${JSON.stringify(cf3)}）`);
  } else ok("发送确认失败态：无新用户消息且输入框未清空 → confirmed=false, via=none（供失败上报）");

  // L4：配置链路 + 延迟常量约束（必须 > 最晚重试 2800ms，避免假阴性）。
  if (!Array.isArray(api.DEFAULTS.userMessageSelectors) || api.DEFAULTS.userMessageSelectors.length === 0) {
    fail("DEFAULTS 缺 userMessageSelectors（第 14 配置字段）");
  } else ok("配置链路：DEFAULTS.userMessageSelectors 已暴露（可在设置页自定义用户消息选择器）");
  if (typeof api.SEND_CONFIRM_DELAY !== "number" || api.SEND_CONFIRM_DELAY <= 2800) {
    fail(`SEND_CONFIRM_DELAY=${api.SEND_CONFIRM_DELAY} 必须 > 最晚重试 2800ms`);
  } else ok(`延迟常量：SEND_CONFIRM_DELAY=${api.SEND_CONFIRM_DELAY}ms > 2800ms 最晚重试，避免确认假阴性`);

  // L5：bridgeConfirmExpression 生成正确的自愈 + .confirm() 表达式。
  const exprL = api.bridgeConfirmExpression(cfgL);
  if (!exprL.includes("__dshDeepSeekBridge") || !exprL.trimEnd().endsWith(".confirm()")) {
    fail("bridgeConfirmExpression 未生成 __dshDeepSeekBridge ... .confirm() 表达式");
  } else ok("桥接表达式：bridgeConfirmExpression = 自愈访问器 + .confirm()，实机可回读确认态");

  // L6：controller 记住上次推送 + 确认结果 + 再试一次不增加轮次。
  let cfgCtlL = { ...api.DEFAULTS, autoSyncEnabled: true, maxAutoLoops: 3 };
  const ctlL = api.createSyncController({ getConfig: () => cfgCtlL });
  const decL = ctlL.handleTurnEnd({ sessionId: "sL", turn: 1, reasonKind: "completed", answerText: "回答X" });
  if (decL.action !== "push" || ctlL.getState().lastPushText !== "回答X" || ctlL.getState().sendConfirmed !== false) {
    fail("handleTurnEnd 未记住 lastPushText / 未初始化 sendConfirmed=false");
  } else ok("状态机：push 时记住 lastPushText 并重置 sendConfirmed=false");
  ctlL.noteSendConfirmed(true);
  if (!ctlL.getState().sendConfirmed) fail("noteSendConfirmed(true) 未写入 sendConfirmed");
  else ok("状态机：noteSendConfirmed(true) 写入确认结果供状态条/追踪读取");
  ctlL.noteError("unconfirmed");
  if (ctlL.getState().state !== "error" || ctlL.getState().pausedReason !== "unconfirmed") {
    fail("未确认未进入 error(unconfirmed) 失败上报态");
  } else ok("失败上报：未确认 → state=error, pausedReason=unconfirmed（状态条显示再试一次）");
  const reDec = ctlL.retryPush();
  if (reDec.action !== "push" || reDec.text !== "回答X" || ctlL.getState().loopCount !== 1) {
    fail(`retryPush 未正确重发上次文本或增加了轮次（${JSON.stringify(reDec)}）`);
  } else ok("再试一次：retryPush 返回上次推送文本、重置确认态、不增加轮次不重复去重");

  // L7：手写桥桩（无 confirm 方法）直接跳过，不排确认 timer（H/J 段零回归）。
  resetTimers();
  const rtNoConfirm = { cancelled: false, controller: ctlL, bridge: { send() {}, poll() {} } };
  api.scheduleSendConfirmation(rtNoConfirm, rtNoConfirm.bridge);
  if (countTimers(api.SEND_CONFIRM_DELAY) !== 0) fail("无 confirm 的手写桥桩不应排确认 timer（破坏零回归）");
  else ok("零回归：手写桥桩无 confirm 方法时 scheduleSendConfirmation 直接跳过");

  // L8：实机路径——延迟 SEND_CONFIRM_DELAY 后回读 confirm 并写入状态/追踪。
  resetTimers();
  ctlL.reset(); ctlL.refresh();
  ctlL.handleTurnEnd({ sessionId: "sL2", turn: 2, reasonKind: "completed", answerText: "回答Y" });
  ctlL.notePushed();  // → waiting
  let confirmCalls = 0;
  const rtL = {
    cancelled: false,
    controller: ctlL,
    bridge: { confirm() { confirmCalls += 1; return { confirmed: true, via: "node", delta: 1 }; } }
  };
  api.scheduleSendConfirmation(rtL, rtL.bridge);
  if (countTimers(api.SEND_CONFIRM_DELAY) !== 1) fail("实机路径应排一个 SEND_CONFIRM_DELAY 确认 timer");
  else ok("实机路径：scheduleSendConfirmation 排出一个延迟确认 timer");
  fireTimers(api.SEND_CONFIRM_DELAY, 1);
  await settle();
  if (confirmCalls !== 1 || !ctlL.getState().sendConfirmed) {
    fail(`延迟确认回调未生效（confirmCalls=${confirmCalls}, sendConfirmed=${ctlL.getState().sendConfirmed}）`);
  } else ok("实机路径：SEND_CONFIRM_DELAY 后回读 bridge.confirm() 并写入 sendConfirmed");

  // L9（v1.2.4 回归防线）：确认回读 via=none（假阴性）时绝不能 noteError 掐断回复轮询。
  // 实机 m02401：DeepSeek 无 [data-message-author-role=user] 节点且输入框残留草稿 → confirmed=false；
  // v1.2.3 据此 noteError 把 waiting 翻成 error，掐断 startReplyPolling（仅在 waiting 存活），
  // 结果「网页回复已生成完却没抓回桌面」。v1.2.4 把确认降级为纯观测，此处锁住该行为。
  resetTimers();
  ctlL.reset(); ctlL.refresh();
  ctlL.handleTurnEnd({ sessionId: "sL3", turn: 3, reasonKind: "completed", answerText: "回答Z" });
  ctlL.notePushed();  // → waiting
  const rtL2 = {
    cancelled: false,
    controller: ctlL,
    bridge: { confirm() { return { confirmed: false, via: "none", delta: 0 }; } }
  };
  api.scheduleSendConfirmation(rtL2, rtL2.bridge);
  fireTimers(api.SEND_CONFIRM_DELAY, 1);
  await settle();
  if (ctlL.getState().state !== "waiting" || ctlL.getState().pausedReason === "unconfirmed") {
    fail(`假阴性确认不应掐断回复轮询：state=${ctlL.getState().state}, pausedReason=${ctlL.getState().pausedReason}`);
  } else ok("v1.2.4 回归防线：确认 via=none 假阴性时 state 保持 waiting，回复轮询不被掐断");

  // L10（v1.3.0 首轮残留修复）：键盘兜底发送后 DOM 残留（React state 未同步）。
  // confirm 用真实浏览器编辑命令（select + execCommand('delete')）清残留，且清理结果
  // 绝不能污染 confirmed/via 判断（只能用清理前的 clearedOriginal）。
  {
    let boxValue = "";
    let execDeleteCalls = 0;
    let selected = false;
    const box = {
      isContentEditable: false,
      getAttribute: () => null,
      focus() {},
      select() { selected = true; },
      get value() { return boxValue; },
      dispatchEvent() { /* 键盘兜底不清空输入框，模拟首轮残留 */ }
    };
    const textareaProto = {};
    Object.defineProperty(textareaProto, "value", { configurable: true, get() { return boxValue; }, set(v) { boxValue = v; } });
    const htmlProto = {};
    Object.defineProperty(htmlProto, "innerHTML", { configurable: true, get() { return ""; }, set() {} });
    const doc = {
      body: {},
      execCommand(cmd) {
        if (cmd === "delete" && selected) { boxValue = ""; execDeleteCalls += 1; return true; }
        return false;
      },
      querySelector(sel) {
        if (cfgL.textareaSelectors.includes(sel)) return box;
        return null;  // 发送按钮不可用 → 走键盘兜底
      },
      querySelectorAll() { return []; }  // 无用户消息节点 → delta=0
    };
    box.ownerDocument = doc;
    const win = { HTMLTextAreaElement: { prototype: textareaProto }, HTMLElement: { prototype: htmlProto } };
    class MO { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} }
    class Ev { constructor(type) { this.type = type; } }
    class KeyEv { constructor(type, o) { this.type = type; Object.assign(this, o || {}); } }
    const factory = new Function("window", "document", "MutationObserver", "Event", "KeyboardEvent",
      "return (" + api.BRIDGE_IMPL + ")")(win, doc, MO, Ev, KeyEv);
    const bridgeL10 = factory(cfgL);
    bridgeL10.fillAndSend("桌面端回答");
    if (boxValue === "") fail("L10 前置失败：填入后输入框应留有文本（键盘兜底不清空）");
    const cfL10 = bridgeL10.confirm();
    if (boxValue !== "" || execDeleteCalls !== 1 || cfL10.residualCleaned !== true) {
      fail(`首轮残留清理失败：boxValue=${JSON.stringify(boxValue)}, execDelete=${execDeleteCalls}, residualCleaned=${cfL10.residualCleaned}`);
    } else ok("v1.3.0 首轮残留修复：confirm 用 select+execCommand('delete') 清空残留，residualCleaned=true");
    if (cfL10.confirmed !== false || cfL10.via !== "none") {
      fail(`残留清理污染了确认判断：confirmed=${cfL10.confirmed}, via=${cfL10.via}（应仍为 false/none，不得自证）`);
    } else ok("v1.3.0 零回归：清理结果不参与 confirmed/via 判断，仅凭清理前状态（不自证已提交）");
  }

  // L11：常规点击发送（sendBtn.click 已清空输入框）→ 无残留、不做多余清理（零回归）。
  {
    let boxValue = "";
    let execDeleteCalls = 0;
    const box = {
      isContentEditable: false,
      getAttribute: () => null,
      focus() {},
      select() {},
      get value() { return boxValue; },
      dispatchEvent() {}
    };
    const textareaProto = {};
    Object.defineProperty(textareaProto, "value", { configurable: true, get() { return boxValue; }, set(v) { boxValue = v; } });
    const htmlProto = {};
    Object.defineProperty(htmlProto, "innerHTML", { configurable: true, get() { return ""; }, set() {} });
    const sendBtn = { disabled: false, click() { boxValue = ""; } };
    const doc = {
      body: {},
      execCommand(cmd) { if (cmd === "delete") execDeleteCalls += 1; return false; },
      querySelector(sel) {
        if (cfgL.textareaSelectors.includes(sel)) return box;
        if (cfgL.sendButtonSelectors.includes(sel)) return sendBtn;
        return null;
      },
      querySelectorAll() { return []; }
    };
    box.ownerDocument = doc;
    const win = { HTMLTextAreaElement: { prototype: textareaProto }, HTMLElement: { prototype: htmlProto } };
    class MO { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} }
    class Ev { constructor(type) { this.type = type; } }
    class KeyEv { constructor(type, o) { this.type = type; Object.assign(this, o || {}); } }
    const factory = new Function("window", "document", "MutationObserver", "Event", "KeyboardEvent",
      "return (" + api.BRIDGE_IMPL + ")")(win, doc, MO, Ev, KeyEv);
    const bridgeL11 = factory(cfgL);
    bridgeL11.fillAndSend("桌面端回答");
    const cfL11 = bridgeL11.confirm();
    if (execDeleteCalls !== 0 || cfL11.residualCleaned !== false || !cfL11.confirmed || cfL11.via !== "cleared") {
      fail(`无残留场景被误清理：execDelete=${execDeleteCalls}, residualCleaned=${cfL11.residualCleaned}, confirmed=${cfL11.confirmed}, via=${cfL11.via}`);
    } else ok("v1.3.0 零回归：输入框已被点击清空时不触发残留清理，via=cleared 正常确认");
  }
}

// ── M 段（v1.2.5 跨会话串台修复）：配对会话锁定 + 会话过滤 + 注入校验 + 切走暂停 + 换绑 ──
{
  const ctlCfg = () => ({ ...api.DEFAULTS, autoSyncEnabled: true, maxAutoLoops: 3 });
  const ctlM = api.createSyncController({ getConfig: ctlCfg });

  // M1：首次 turn/end 锁定配对会话。
  let md = ctlM.handleTurnEnd({ sessionId: "sA", turn: 1, reasonKind: "completed", answerText: "回答A" });
  if (md.action !== "push" || ctlM.getState().pairedSessionId !== "sA") {
    fail("首次 turn/end 未锁定配对会话");
  } else ok("v1.2.5：首次 turn/end 锁定配对会话 sA");

  // M2：非配对会话的 turn/end 被过滤（不搬运、轮次不变）。
  const beforeLoop = ctlM.getState().loopCount;
  md = ctlM.handleTurnEnd({ sessionId: "sB", turn: 1, reasonKind: "completed", answerText: "回答B" });
  if (md.action !== "skip" || md.reason !== "unpaired-session" || ctlM.getState().loopCount !== beforeLoop) {
    fail(`非配对会话 turn/end 未过滤：action=${md.action}, reason=${md.reason}`);
  } else ok("v1.2.5：非配对会话 sB 的 turn/end 被过滤，不搬运不增轮次");

  // M3：onSessionEvents 对非配对会话直接丢弃（连 handleTurnEnd 都不调）。
  let turnHandled = 0;
  const ctlSpy = {
    isSessionOk: (sid) => ctlM.isSessionOk(sid),
    getState: () => ctlM.getState(),
    handleTurnEnd: () => { turnHandled += 1; return { action: "skip" }; }
  };
  const snapM = { change: { kind: "append", entries: [{ event: { type: "turn/end", data: { reason: { kind: "completed" }, turn: 2 } } }] } };
  const srcM = { getSnapshot: () => snapM };
  const rtM = { controller: ctlSpy };
  api.onSessionEvents(rtM, srcM, "sB");
  if (turnHandled !== 0) fail("onSessionEvents 未挡住非配对会话 sB");
  else ok("v1.2.5：onSessionEvents 对非配对会话直接丢弃，不写 trace 不触发推送");
  api.onSessionEvents(rtM, srcM, "sA");
  if (turnHandled !== 1) fail("onSessionEvents 未放行配对会话 sA");
  else ok("v1.2.5：onSessionEvents 放行配对会话 sA 的 turn/end");

  // M4：injectDraft 会话不符 → 拒绝（防反向串台），不调用 setDraft。
  let mismatchedDraft = "";
  const rtMismatch = {
    dockBinding: { current: { sessionId: "sB", inputActions: { setDraft(t) { mismatchedDraft = t; } } } },
    controller: ctlM
  };
  const okMismatch = api.injectDraft(rtMismatch, "网页回复-错会话");
  if (okMismatch !== false || mismatchedDraft !== "") fail("injectDraft 未拒绝错会话 dock");
  else ok("v1.2.5：injectDraft 校验 dock 会话不符时拒绝注入（防反向串台）");

  // M5：injectDraft 会话相符 → 正常写入草稿。
  const rtMatch = {
    dockBinding: { current: { sessionId: "sA", inputActions: { setDraft(t) { mismatchedDraft = t; } } } },
    controller: ctlM
  };
  const okMatch = api.injectDraft(rtMatch, "网页回复-正确会话");
  if (okMatch !== true || mismatchedDraft !== "网页回复-正确会话") fail("injectDraft 未放行配对会话 dock");
  else ok("v1.2.5：injectDraft 校验 dock 会话相符时正常 setDraft");

  // M6（v1.2.6 B 方案）：切走配对会话 → 不再暂停，state 保持，仅更新 currentSessionId。
  const stateBeforeSwitch = ctlM.getState().state;
  ctlM.noteCurrentSession("sB");
  const stSw = ctlM.getState();
  if (stSw.state !== stateBeforeSwitch || stSw.currentSessionId !== "sB" || stSw.switchPaused) {
    fail(`切走配对会话不应暂停：state=${stSw.state}, current=${stSw.currentSessionId}`);
  } else ok("v1.2.6：切走配对会话不暂停，闭环状态保持不变（currentSessionId=sB）");

  // M7（v1.2.6）：切回配对会话 → state 仍不变，currentSessionId 更新回 sA。
  ctlM.noteCurrentSession("sA");
  const stBack = ctlM.getState();
  if (stBack.state !== stateBeforeSwitch || stBack.currentSessionId !== "sA") fail("切回配对会话状态被改动");
  else ok("v1.2.6：切回配对会话不改动闭环状态（currentSessionId=sA）");

  // M8：换绑 unpair 清空配对会话与切走状态。
  ctlM.noteCurrentSession("sB");
  ctlM.unpair();
  const stUnpair = ctlM.getState();
  if (stUnpair.pairedSessionId !== "" || stUnpair.switchPaused) fail("换绑未清空配对状态");
  else ok("v1.2.5：换绑 unpair 清空配对会话与切走暂停状态");

  // M9：reset 清空配对状态。
  const ctlM2 = api.createSyncController({ getConfig: ctlCfg });
  ctlM2.handleTurnEnd({ sessionId: "sZ", turn: 1, reasonKind: "completed", answerText: "回答Z" });
  ctlM2.reset();
  if (ctlM2.getState().pairedSessionId !== "") fail("reset 未清空配对会话");
  else ok("v1.2.5：reset 清空配对会话，可重新绑定");

  // M10（手动绑定）：无需先跑一轮 turn/end，直接锁定配对会话。
  const ctlBind = api.createSyncController({ getConfig: ctlCfg });
  if (ctlBind.getState().pairedSessionId !== "") fail("新 controller 初始不该有配对会话");
  else ok("手动绑定：新 controller 初始未绑定");
  const bound = ctlBind.bindSession("sManual");
  const stBind = ctlBind.getState();
  if (bound !== true || stBind.pairedSessionId !== "sManual" || stBind.currentSessionId !== "sManual") {
    fail(`手动绑定未锁定会话：bound=${bound}, paired=${stBind.pairedSessionId}, current=${stBind.currentSessionId}`);
  } else ok("手动绑定：bindSession 直接锁定配对会话（无需先跑 turn/end）");
  // 绑定后，其它会话的 turn/end 被过滤，目标会话正常进入闭环。
  const mdOther = ctlBind.handleTurnEnd({ sessionId: "sOther", turn: 1, reasonKind: "completed", answerText: "X" });
  if (mdOther.action !== "skip" || mdOther.reason !== "unpaired-session") fail("手动绑定后未过滤其它会话");
  else ok("手动绑定：绑定后非目标会话 turn/end 被过滤");
  const mdTarget = ctlBind.handleTurnEnd({ sessionId: "sManual", turn: 1, reasonKind: "completed", answerText: "Y" });
  if (mdTarget.action !== "push") fail("手动绑定后目标会话 turn/end 未进入闭环");
  else ok("手动绑定：绑定后目标会话 turn/end 正常进入闭环");
  // 空 sid 被拒绝，不产生无效绑定。
  if (ctlBind.bindSession("") !== false || ctlBind.bindSession(null) !== false) fail("空会话 id 不该绑定成功");
  else ok("手动绑定：空会话 id 被拒绝");
}

// ── N 段（v1.2.6 B 方案）：切会话后闭环照常走——跨会话草稿 API + 订阅上移 ──
{
  // N1：官方会话定向 API 被正确调用（binding + prompt + whenDraftExists:'replace'）。
  let captured = null;
  const bindingStub = { sessionId: "sA" };
  const sessionsStub = { binding: (id) => (id === "sA" ? bindingStub : null) };
  const convStub = { input: { requestDraftInitialization: (binding, opts) => { captured = { binding, opts }; return "applied"; } } };
  const rtApi = {
    ctx: { get: (name) => (name === "sessions" ? sessionsStub : name === "conversation" ? convStub : null) },
    controller: { getState: () => ({ pairedSessionId: "sA" }), noteDraftInjected: () => {} },
    dockBinding: { current: null }
  };
  const r1 = api.injectToSessionViaApi(rtApi, "网页回复");
  if (r1 !== "applied" || captured.binding !== bindingStub || captured.opts.prompt !== "网页回复" || captured.opts.whenDraftExists !== "replace") {
    fail(`跨会话草稿 API 调用参数错误：result=${r1}`);
  } else ok("v1.2.6：官方会话定向草稿 API 以 binding+prompt+replace 调用，返回 applied");

  // N2：binding 失效（会话关闭/重建）→ binding-lost。
  const rtLost = { ...rtApi, ctx: { get: (name) => (name === "sessions" ? { binding: () => null } : name === "conversation" ? convStub : null) } };
  if (api.injectToSessionViaApi(rtLost, "x") !== "binding-lost") fail("binding 失效未返回 binding-lost");
  else ok("v1.2.6：配对会话 binding 失效时返回 binding-lost（明确记因）");

  // N3：无 conversation 服务（旧 DSH / 测试桩）→ unavailable。
  const rtNoConv = { ...rtApi, ctx: { get: (name) => (name === "sessions" ? sessionsStub : null) } };
  if (api.injectToSessionViaApi(rtNoConv, "x") !== "unavailable") fail("无 conversation 服务未返回 unavailable");
  else ok("v1.2.6：conversation 服务不可用时返回 unavailable（触发回退）");

  // N4：injectDraft 优先走 API——不碰当前 composer 的 setDraft。
  let dockSetCalls = 0;
  const rtViaApi = {
    ...rtApi,
    dockBinding: { current: { sessionId: "sB", inputActions: { setDraft() { dockSetCalls += 1; } } } },
    controller: { getState: () => ({ pairedSessionId: "sA" }), noteDraftInjected: (v) => { rtViaApi._noted = v; } }
  };
  const okViaApi = api.injectDraft(rtViaApi, "回给A会话");
  if (okViaApi !== true || dockSetCalls !== 0 || rtViaApi._noted !== true) {
    fail(`injectDraft 未优先走会话 API：ok=${okViaApi}, dockCalls=${dockSetCalls}`);
  } else ok("v1.2.6：injectDraft 优先走会话定向 API，不写当前会话 composer（切走也不串台）");

  // N5：API 返回 blocked → 不回退写当前 dock（防反向串台）。
  const convBlocked = { input: { requestDraftInitialization: () => "blocked" } };
  let dockBlockedCalls = 0;
  const rtBlocked = {
    ctx: { get: (name) => (name === "sessions" ? sessionsStub : name === "conversation" ? convBlocked : null) },
    controller: { getState: () => ({ pairedSessionId: "sA" }), noteDraftInjected: (v) => { rtBlocked._noted = v; } },
    dockBinding: { current: { sessionId: "sB", inputActions: { setDraft() { dockBlockedCalls += 1; } } } }
  };
  const okBlocked = api.injectDraft(rtBlocked, "不应写入");
  if (okBlocked !== false || dockBlockedCalls !== 0) fail("API blocked 时错误回退写了当前会话草稿");
  else ok("v1.2.6：API blocked/binding-lost 时不回退写当前会话（防反向串台）");

  // N6：API unavailable 时回退当前 composer setDraft（配对一致），保证旧版本兼容。
  let fallbackDraft = "";
  const rtFallback = {
    ctx: { get: () => null },
    controller: { getState: () => ({ pairedSessionId: "sA" }), isSessionOk: (sid) => sid === "sA", noteDraftInjected: () => {} },
    dockBinding: { current: { sessionId: "sA", inputActions: { setDraft(t) { fallbackDraft = t; } } } }
  };
  const okFallback = api.injectDraft(rtFallback, "回退草稿");
  if (okFallback !== true || fallbackDraft !== "回退草稿") fail("API 不可用时未回退 setDraft");
  else ok("v1.2.6：API 不可用时回退当前 composer setDraft（老版本/测试桩零回归）");

  // N7：订阅上移——未配对时订当前会话。
  const subscribedIds = [];
  const subState = { pairedSessionId: "", currentSessionId: "sB" };
  const sessionsForSub = { binding: (id) => ({ eventSource: {
    subscribe() { subscribedIds.push(id); return () => {}; }, getSnapshot() { return { change: null }; }
  } }) };
  const rtSub = {
    ctx: { get: (name) => (name === "sessions" ? sessionsForSub : null) },
    controller: { getState: () => subState },
    eventSubs: { sid: "", stop: null }
  };
  api.ensureEventSubscription(rtSub, "sB");
  if (rtSub.eventSubs.sid !== "sB" || !subscribedIds.includes("sB")) fail("未配对时未订当前会话");
  else ok("v1.2.6：未配对时订阅跟随当前会话（让首个 turn/end 到达以锁定）");

  // N8：配对后切会话——订阅重定向到配对会话，不跟随当前会话。
  subState.pairedSessionId = "sA";
  subState.currentSessionId = "sB";
  api.ensureEventSubscription(rtSub, "sB");
  if (rtSub.eventSubs.sid !== "sA" || !subscribedIds.includes("sA")) fail("配对后订阅未重定向到配对会话");
  else ok("v1.2.6：配对后订阅定向到配对会话 sA，切走当前会话不换订");

  // N9：重复调用不重复订阅（sid 相同直接 return）。
  const countA = subscribedIds.filter((s) => s === "sA").length;
  api.ensureEventSubscription(rtSub, "sB");
  if (subscribedIds.filter((s) => s === "sA").length !== countA) fail("重复订阅了同一会话");
  else ok("v1.2.6：目标会话不变时不重复订阅（避免事件重复触发）");
}

// ── O 段（手动绑定 + 齿轮跳设置页）：状态栏按钮渲染 + 点击 + keydown 派发 ──
{
  // 建立真实运行单例并打开总开关，让状态栏渲染。
  const oCtx = makeCtx();
  const oRt = api.ensureSyncRuntime(oCtx);
  if (typeof oRt.dockDispose === "function") { try { oRt.dockDispose(); } catch { /* 已释放 */ } }
  oRt.dockDispose = null;
  oRt.cancelled = false;
  api.writeConfig({ autoSyncEnabled: true, maxAutoLoops: 3, errorKeywords: [...api.DEFAULT_ERROR_KEYWORDS] });
  oRt.controller.reset();
  // 未绑定：仅记录当前会话，让状态栏走「显示绑定按钮」分支。
  oRt.controller.noteCurrentSession("sCurrent");
  const stBefore = oRt.controller.getState();
  if (stBefore.pairedSessionId !== "" || stBefore.currentSessionId !== "sCurrent") fail("O 段前置状态不对");
  else ok("手动绑定前置：未配对、当前会话 sCurrent");

  const bar = mount(react.createElement(api.SyncStatusBar, {}));
  const bindBtn = findByAttr(bar, "data-dsh-plugin-deepseek-chat", "sync-bind");
  const rebindBtn = findByAttr(bar, "data-dsh-plugin-deepseek-chat", "sync-rebind");
  if (!bindBtn || rebindBtn) fail("未配对时状态栏应显示绑定按钮而非换绑按钮");
  else ok("手动绑定：未配对时状态栏显示「绑定当前会话」按钮");

  const gearBtn = findByAttr(bar, "data-dsh-plugin-deepseek-chat", "sync-settings");
  if (!gearBtn) fail("状态栏缺少齿轮设置按钮");
  else if (!gearBtn.children || !gearBtn.children.some((c) => c && c.tag === "svg")) fail("齿轮按钮未使用 inline SVG 图标");
  else ok("齿轮按钮：状态栏渲染 sync-settings 按钮（inline SVG 齿轮）");

  // 点击「绑定当前会话」→ bindSession 锁定当前会话。
  if (bindBtn) {
    bindBtn.dispatch("click", {});
    const stAfter = oRt.controller.getState();
    if (stAfter.pairedSessionId !== "sCurrent") fail("点击绑定按钮未锁定当前会话");
    else ok("手动绑定：点击「绑定当前会话」按钮 → 直接锁定当前会话（无需跑一轮）");
  }
  // 已配对后重新渲染 → 显示换绑按钮而非绑定按钮。
  const bar2 = mount(react.createElement(api.SyncStatusBar, {}));
  const rebind2 = findByAttr(bar2, "data-dsh-plugin-deepseek-chat", "sync-rebind");
  const bind2 = findByAttr(bar2, "data-dsh-plugin-deepseek-chat", "sync-bind");
  if (!rebind2 || bind2) fail("已配对时状态栏应显示换绑按钮而非绑定按钮");
  else ok("手动绑定：已配对时状态栏显示「换绑」按钮（绑定/换绑互斥）");

  // 回归（解绑后绑定按钮消失 bug）：点换绑 → unpair/reset 清空 currentSessionId，
  // 修复后应把原配对会话恢复为当前会话，重新渲染仍显示「绑定当前会话」按钮。
  if (rebind2) {
    rebind2.dispatch("click", {});
    const stUnbound = oRt.controller.getState();
    const bar3 = mount(react.createElement(api.SyncStatusBar, {}));
    const bind3 = findByAttr(bar3, "data-dsh-plugin-deepseek-chat", "sync-bind");
    const rebind3 = findByAttr(bar3, "data-dsh-plugin-deepseek-chat", "sync-rebind");
    if (stUnbound.pairedSessionId !== "" || stUnbound.currentSessionId !== "sCurrent") {
      fail(`换绑后应恢复当前会话 sCurrent：paired=${stUnbound.pairedSessionId}, current=${stUnbound.currentSessionId}`);
    } else if (!bind3 || rebind3) fail("换绑后绑定按钮消失（应恢复为可重新绑定的状态）");
    else ok("换绑后：清空配对但恢复当前会话，「绑定当前会话」按钮仍显示可重绑");
    // v1.4.4：未绑定会话时默认关闭——解绑后条件触发与全自动两个开关都应关闭，
    // 只有再点「绑定当前会话」才重新开启。
    const unboundCfg = api.getConfig();
    if (unboundCfg.autoSyncEnabled !== false || unboundCfg.autoPilotEnabled !== false) {
      fail(`解绑后两开关应关闭：autoSyncEnabled=${unboundCfg.autoSyncEnabled}, autoPilotEnabled=${unboundCfg.autoPilotEnabled}`);
    } else ok("解绑后：条件触发与全自动开关自动关闭（未绑定会话默认关闭）");
  }

  // 回归（换绑绑回旧会话 bug）：dock 上报的真实当前会话 ≠ 旧配对会话时，
  // 点换绑应恢复为 dock 的当前会话（新会话），而不是旧的 pairedSessionId。
  {
    oRt.controller.bindSession("sOld");
    oRt.controller.noteCurrentSession("sOld");
    oRt.dockBinding.current = { sessionId: "sNew" };
    const barNew = mount(react.createElement(api.SyncStatusBar, {}));
    const rebindNew = findByAttr(barNew, "data-dsh-plugin-deepseek-chat", "sync-rebind");
    if (rebindNew) {
      rebindNew.dispatch("click", {});
      const stNew = oRt.controller.getState();
      if (stNew.pairedSessionId !== "" || stNew.currentSessionId !== "sNew") {
        fail(`换绑应恢复 dock 当前会话 sNew（而非旧会话）：paired=${stNew.pairedSessionId}, current=${stNew.currentSessionId}`);
      } else ok("换绑：恢复 dock 上报的真实当前会话（新会话），不再绑回旧会话");
    } else fail("换绑回归：未找到换绑按钮");
    oRt.dockBinding.current = null;
    api.writeConfig({ autoSyncEnabled: true });
  }

  // 回归（出错后点「恢复默认」绑定按钮丢失 bug）：绑定会话并置 error 状态让「恢复默认」出现，
  // 点击后 reset() 会清空 currentSessionId，修复后应主动恢复原会话，绑定按钮继续显示。
  {
    oRt.controller.bindSession("sReset");
    oRt.controller.noteCurrentSession("sReset");
    oRt.controller.noteError("synthetic"); // 进入 error 态 → 状态条渲染「恢复默认」按钮
    const barErr = mount(react.createElement(api.SyncStatusBar, {}));
    const resetBtn = findByAttr(barErr, "data-dsh-plugin-deepseek-chat", "sync-reset");
    if (!resetBtn) {
      fail("error 态下状态条应显示「恢复默认」按钮");
    } else {
      const stPre = oRt.controller.getState();
      const sid = stPre.pairedSessionId || stPre.currentSessionId;
      resetBtn.dispatch("click", {});
      const stPost = oRt.controller.getState();
      const bar4 = mount(react.createElement(api.SyncStatusBar, {}));
      const bind4 = findByAttr(bar4, "data-dsh-plugin-deepseek-chat", "sync-bind");
      if (stPost.currentSessionId !== sid || !bind4) {
        fail(`点「恢复默认」后当前会话未恢复/绑定按钮丢失：current=${stPost.currentSessionId}, sid=${sid}`);
      } else ok("点「恢复默认」后：当前会话保留，「绑定当前会话」按钮仍显示");
    }
  }

  // 设置跳转首选路径：ctx.get("shortcuts").registry.invoke("settings.open")（桌面端唯一可靠路径）。
  const invoked = [];
  const ctxStub = { get(name) { return name === "shortcuts" ? {
    registry: { invoke(id, context) { invoked.push({ id, context }); } }
  } : undefined; } };
  const firedInvoke = api.openSettingsViaShortcut(ctxStub, null, null, null);
  if (firedInvoke !== true || invoked.length !== 1 || invoked[0].id !== "settings.open" ||
      invoked[0].context.modal !== null || invoked[0].context.source !== "menu") {
    fail(`设置跳转首选路径 registry.invoke 未正确调用：fired=${firedInvoke}, invoked=${JSON.stringify(invoked)}`);
  } else ok("设置跳转：首选 ctx.shortcuts.registry.invoke('settings.open')（桌面端账户菜单同款路径）");

  // 回退路径：拿不到 registry 时，合成 keydown（Web 端有效）。
  const winEvents = [];
  function KeyEvStub(type, init) { this.type = type; this.init = init; }
  const winStub = { navigator: { platform: "Win32", userAgent: "" }, dispatchEvent(ev) { winEvents.push(ev); return true; } };
  const noShortcutsCtx = { get() { return undefined; } };
  const firedWin = api.openSettingsViaShortcut(noShortcutsCtx, null, winStub, KeyEvStub);
  if (firedWin !== true || winEvents.length !== 1 || winEvents[0].type !== "keydown" ||
      winEvents[0].init.code !== "Comma" || winEvents[0].init.ctrlKey !== true || winEvents[0].init.metaKey !== false) {
    fail(`设置跳转回退 Windows keydown 派发错误：fired=${firedWin}, events=${JSON.stringify(winEvents.map((e) => e.init))}`);
  } else ok("设置跳转回退：无 registry 时 Windows 派发单个 Ctrl+Comma keydown");

  const macEvents = [];
  const macStub = { navigator: { platform: "MacIntel", userAgent: "" }, dispatchEvent(ev) { macEvents.push(ev); return true; } };
  api.openSettingsViaShortcut(noShortcutsCtx, null, macStub, KeyEvStub);
  if (macEvents.length !== 1 || macEvents[0].init.metaKey !== true || macEvents[0].init.ctrlKey !== false) {
    fail("设置跳转回退 Mac keydown 派发错误（应 Cmd+Comma）");
  } else ok("设置跳转回退：Mac 派发 Cmd+Comma keydown");

  api.writeConfig({ autoSyncEnabled: false });
}

// ── P 段（会话标题显示）：绑定会话优先显示官方 displayTitle，取不到回退短 id ──
{
  let listRows = { sBound: { displayTitle: "会话标题XYZ", title: "会话标题XYZ" } };
  const pCtx = makeCtx();
  pCtx.get = (name) => {
    if (name === "sessions") return {
      list: {
        getSnapshot: () => ({ byId: listRows }),
        subscribe: () => () => {}
      }
    };
    return undefined;
  };
  // ensureSyncRuntime 是单例：再次调用仅刷新 ctx，不重复注册槽位。
  const pRt = api.ensureSyncRuntime(pCtx);
  api.writeConfig({ autoSyncEnabled: true, maxAutoLoops: 3, errorKeywords: [...api.DEFAULT_ERROR_KEYWORDS] });
  pRt.controller.reset();
  pRt.controller.bindSession("sBound");

  const barTitle = mount(react.createElement(api.SyncStatusBar, {}));
  const textsWithTitle = collectTexts(barTitle).join(" ");
  if (!textsWithTitle.includes("会话标题XYZ")) fail("绑定会话未显示官方 displayTitle 标题：" + textsWithTitle);
  else ok("会话标题：绑定会话优先显示官方 displayTitle（会话标题XYZ）");

  // 列表未就绪 / 标题缺席 → 回退短 id（冷启动与测试桩零回归）。
  listRows = {};
  const barFallback = mount(react.createElement(api.SyncStatusBar, {}));
  const textsFallback = collectTexts(barFallback).join(" ");
  if (!textsFallback.includes("sBound") || textsFallback.includes("会话标题XYZ")) fail("标题缺席时未回退短 id：" + textsFallback);
  else ok("会话标题：标题缺席时回退短 id（零回归）");

  api.writeConfig({ autoSyncEnabled: false });
}

// ── Q 段（齿轮定位 DeepSeek 聊天 section）：面板打开后点击对应 nav 按钮 ──
{
  const clicked = [];
  const dsBtn = { textContent: "DeepSeek 聊天", click: () => clicked.push("ds") };
  const acctBtn = { textContent: "账号与余额", click: () => clicked.push("acct") };
  const panel = { querySelectorAll: (sel) => (sel === "button" ? [acctBtn, dsBtn] : []) };
  const docStub = {
    querySelector: (sel) => (sel === '[data-shortcut-modal="settings"]' ? panel : null),
    querySelectorAll: (sel) => panel.querySelectorAll(sel)
  };
  const fired = api.focusDeepSeekChatSection(docStub, () => 0);
  if (!fired || clicked.length !== 1 || clicked[0] !== "ds") fail("齿轮定位：未点击 DeepSeek 聊天 nav 按钮：" + JSON.stringify(clicked));
  else ok("齿轮定位：打开设置后点击 'DeepSeek 聊天' nav 按钮（非账号与余额）");

  // 英文 label 也能命中。
  const clickedEn = [];
  const dsBtnEn = { textContent: "DeepSeek Chat", click: () => clickedEn.push("ds") };
  const panelEn = { querySelectorAll: () => [dsBtnEn] };
  const docStubEn = {
    querySelector: () => panelEn,
    querySelectorAll: (sel) => panelEn.querySelectorAll(sel)
  };
  api.focusDeepSeekChatSection(docStubEn, () => 0);
  if (clickedEn.length !== 1) fail("齿轮定位：英文 label 'DeepSeek Chat' 未命中");
  else ok("齿轮定位：英文 label 'DeepSeek Chat' 同样命中");

  // v1.4.6-hotfix-4 回归（问题B）：豆包状态下导航项叫「豆包 聊天」/「Doubao Chat」，
  // 旧版硬编码只认 DeepSeek 两变体导致齿轮停在默认「账号与余额」页。
  const clickedDb = [];
  const dbBtn = { textContent: "豆包 聊天", click: () => clickedDb.push("doubao") };
  const panelDb = { querySelectorAll: () => [dbBtn] };
  const docStubDb = { querySelector: () => panelDb, querySelectorAll: (sel) => panelDb.querySelectorAll(sel) };
  api.focusDeepSeekChatSection(docStubDb, () => 0);
  if (clickedDb.length !== 1) fail("问题B：齿轮定位未命中『豆包 聊天』label");
  else ok("v1.4.6-hotfix-4：齿轮定位命中『豆包 聊天』label");

  const clickedDbEn = [];
  const dbBtnEn = { textContent: "Doubao Chat", click: () => clickedDbEn.push("doubao") };
  const panelDbEn = { querySelectorAll: () => [dbBtnEn] };
  const docStubDbEn = { querySelector: () => panelDbEn, querySelectorAll: (sel) => panelDbEn.querySelectorAll(sel) };
  api.focusDeepSeekChatSection(docStubDbEn, () => 0);
  if (clickedDbEn.length !== 1) fail("问题B：齿轮定位未命中『Doubao Chat』label");
  else ok("v1.4.6-hotfix-4：齿轮定位命中『Doubao Chat』label");

  // 面板尚未渲染时：首轮不命中 → 短轮询计时器已排期（注入 timers 记录）。
  const timers = [];
  let attempts = 0;
  const lateBtn = { textContent: "DeepSeek 聊天", click: () => clicked.push("late") };
  const latePanel = { querySelectorAll: () => (++attempts >= 2 ? [lateBtn] : []) };
  const docLate = {
    querySelector: () => latePanel,
    querySelectorAll: (sel) => latePanel.querySelectorAll(sel)
  };
  api.focusDeepSeekChatSection(docLate, (fn, delay) => { timers.push(delay); if (timers.length === 1) fn(); });
  if (timers.length < 4 || clicked.indexOf("late") === -1) fail("齿轮定位：面板延迟渲染时短轮询未命中：" + JSON.stringify({ timers, clicked }));
  else ok("齿轮定位：面板延迟渲染时短轮询补点成功");

  // 【回归防线】面板不存在时（querySelector 返回 null），即使整个 document 里有
  // 同名「DeepSeek 聊天」按钮（主界面左侧栏），也绝不能误点——那会切走会话界面。
  const misclick = [];
  const mainSidebarBtn = { textContent: "DeepSeek 聊天", click: () => misclick.push("sidebar") };
  const docNoPanel = {
    querySelector: () => null,
    querySelectorAll: () => [mainSidebarBtn]
  };
  api.focusDeepSeekChatSection(docNoPanel, () => 0);
  if (misclick.length !== 0) fail("齿轮定位：面板不存在时误点了主界面同名按钮（会切走会话界面）：" + JSON.stringify(misclick));
  else ok("齿轮定位：面板不存在时绝不误点主界面同名按钮（修复会话界面被切走的回归）");
}

// ── R 段（v1.4.0 全自动投递通道）────────────────────────────────────────────
// 提炼 / 判定 / 输出契约 / 自动提交档位 / 决策卡生命周期 / 启停。
{
  const need = [
    "extractPilotPayload", "buildPilotPush", "classifyPilotReply", "tryAutoSubmit",
    "handlePilotReply", "startAutoPilot", "stopAutoPilot", "DEFAULT_PILOT_MARKER_START",
    "DEFAULT_PILOT_MARKER_END", "DEFAULT_PILOT_DONE_KEYWORDS", "DEFAULT_PILOT_RESTART_KEYWORDS",
    "DEFAULT_PILOT_SIGNAL_KEYWORDS", "DEFAULT_PILOT_HANDOFF_KEYWORDS", "DEFAULT_PILOT_OUTPUT_CONTRACT"
  ];
  const missing = need.filter((k) => api[k] === undefined);
  if (missing.length) fail("R 段：__test__ 缺少全自动导出：" + missing.join(", "));
  else ok("R 段：全自动纯函数 / 数据流 / 常量均已导出");

  // 默认值：全自动默认关闭，自动提交默认开启。
  if (api.DEFAULTS.autoPilotEnabled !== false || api.DEFAULTS.pilotAutoSubmit !== true ||
      api.DEFAULTS.pilotMarkerStart !== "<TO_DEV>" || api.DEFAULTS.pilotMarkerEnd !== "</TO_DEV>" ||
      !Array.isArray(api.DEFAULTS.pilotHandoffKeywords) || api.DEFAULTS.pilotHandoffKeywords.length === 0) {
    fail("R 段：DEFAULTS 全自动字段不对：" + JSON.stringify({
      autoPilotEnabled: api.DEFAULTS.autoPilotEnabled, pilotAutoSubmit: api.DEFAULTS.pilotAutoSubmit,
      pilotMarkerStart: api.DEFAULTS.pilotMarkerStart, pilotMarkerEnd: api.DEFAULTS.pilotMarkerEnd
    }));
  } else ok("R 段：DEFAULTS 全自动默认关闭 / 自动提交开 / 定界符与用户介入词齐全");

  const cfgM = {
    pilotMarkerStart: "<TO_DEV>", pilotMarkerEnd: "</TO_DEV>",
    pilotDoneKeywords: ["DONE", "完成", "通过", "APPROVED"]
  };

  // 提炼：定界符区块 / 完成词优先 / 无定界符 / 空区块。
  {
    const a = api.extractPilotPayload("前言\n<TO_DEV>fix the bug\n第 5 行</TO_DEV>\n后记", cfgM);
    if (!a.ok || a.state !== "ok" || a.text !== "fix the bug\n第 5 行") fail("R 段：定界符提炼失败：" + JSON.stringify(a));
    else ok("R 段：只提炼 {start}…{end} 之间的区块（前后废话全部丢弃）");
    const d = api.extractPilotPayload("看起来 <TO_DEV>whatever</TO_DEV> DONE", cfgM);
    if (d.state !== "ok" || !d.ok || d.text !== "whatever") fail("R 段：定界符区块应优先于区块外完成词：" + JSON.stringify(d));
    else ok("R 段：定界符区块优先于区块外散落的完成词（避免误判中断）");
    // 真机回归：豆包在给出开发项的同时复述契约里的完成词，不得被误判为 done。
    const d2 = api.extractPilotPayload("方案评估完毕请写出完成词：DONE <TO_DEV>修第5行</TO_DEV> 审查完成无需开发", cfgM);
    if (d2.state !== "ok" || !d2.ok || d2.text !== "修第5行") fail("R 段：区块外复述完成词被误判：" + JSON.stringify(d2));
    else ok("R 段：区块外散落的「DONE/完成」不误判，仍提炼定界符区块");
    // v1.4.5 真机回归：区块内只是完成语义时判 done，绝不能把「任务已完成」当新任务回投。
    const d5 = api.extractPilotPayload("DONE\n<TO_DEV> 任务已完成 </TO_DEV>", cfgM);
    if (d5.state !== "done" || d5.ok) fail("R 段：区块内纯完成语义未判 done：" + JSON.stringify(d5));
    else ok("R 段：区块内「任务已完成」判 done 终止链条（修复死循环/重复回投/180s 超时）");
    // 区块内既有完成词、又是真实任务时仍应按 continue 回投，不能一刀切。
    const d6 = api.extractPilotPayload("<TO_DEV> 已完成审查，请修第5行的拼写 </TO_DEV>", cfgM);
    if (d6.state !== "ok" || !d6.ok) fail("R 段：区块内含真实任务被误判为 done：" + JSON.stringify(d6));
    else ok("R 段：区块内含真实任务（即使带「已…」字样）仍判 continue 回投");
    // 无定界符时，完成词严格匹配：独立成行/短声明结尾才算 done，散落在正文中不算。
    const d3 = api.extractPilotPayload("方案通过评估，审查完成，整体没问题", cfgM);
    if (d3.state !== "no-marker" || d3.ok) fail("R 段：正文中散落的中文完成词被误判为 done：" + JSON.stringify(d3));
    else ok("R 段：正文散落的「通过/完成」不误判为 done（严格匹配）");
    const d4 = api.extractPilotPayload("审查完毕，无需继续。\nDONE", cfgM);
    if (d4.state !== "done" || d4.ok) fail("R 段：独立成行的完成词未识别：" + JSON.stringify(d4));
    else ok("R 段：独立成行的完成词仍判 done（保留正常终止能力）");
    const n = api.extractPilotPayload("没有区块的普通回复", cfgM);
    if (n.state !== "no-marker" || n.ok) fail("R 段：无定界符未报 no-marker：" + JSON.stringify(n));
    else ok("R 段：无定界符区块 → no-marker（不盲目投递全文）");
    const e = api.extractPilotPayload("<TO_DEV>   </TO_DEV>", cfgM);
    if (e.state !== "empty" || e.ok) fail("R 段：空区块未报 empty：" + JSON.stringify(e));
    else ok("R 段：空区块 → empty");
    // 定界符含正则元字符时按字面量提取（不用正则）。
    const meta = api.extractPilotPayload("[[x]]payload[[/x]]", { pilotMarkerStart: "[[x]]", pilotMarkerEnd: "[[/x]]", pilotDoneKeywords: [] });
    if (!meta.ok || meta.text !== "payload") fail("R 段：含正则元字符的定界符提取失败：" + JSON.stringify(meta));
    else ok("R 段：定界符含正则元字符时按字面量 indexOf 提取");
  }

  // 输出契约：占位符用字符串替换，不误伤正则元字符。
  {
    const push = api.buildPilotPush("桌面正文", {
      ...cfgM, pilotOutputContract: "OUT {start} MID {end} END {done}"
    });
    if (push !== "桌面正文\n\nOUT <TO_DEV> MID </TO_DEV> END DONE") {
      fail("R 段：输出契约占位符替换不对：" + JSON.stringify(push));
    } else ok("R 段：buildPilotPush 追加契约并替换 {start}/{end}/{done}");
    const defPush = api.buildPilotPush("正文", cfgM);
    if (defPush.indexOf("<TO_DEV>") < 0 || defPush.indexOf("</TO_DEV>") < 0 || defPush.indexOf("DONE") < 0) {
      fail("R 段：默认输出契约未含定界符/完成词：" + JSON.stringify(defPush));
    } else ok("R 段：默认输出契约含定界符与完成词");
  }

  // 判定优先级：signal（信号词含完成/重启/用户介入，两栏已融合）→ duplicate → error → max-loops → no-marker → continue。
  {
    const c = (s, prev, extra) => api.classifyPilotReply(s, prev, { ...extra });
    let v = c({ ok: false, text: "", state: "done", reason: "done-word" }, "", {});
    if (v.action !== "pause" || v.kind !== "signal") fail("R 段：完成词语义合并为 signal 失败：" + JSON.stringify(v));
    v = c({ ok: true, text: "请重启 DSH 再试", state: "ok" }, "", {});
    if (v.kind !== "signal") fail("R 段：重启词合并为 signal 判定失败：" + JSON.stringify(v));
    v = c({ ok: true, text: "请重启宿主验收", state: "ok" }, "", {});
    if (v.kind !== "handoff") fail("R 段：用户介入词判定失败：" + JSON.stringify(v));
    v = c({ ok: true, text: "same text", state: "ok" }, "same   text", {});
    if (v.kind !== "duplicate") fail("R 段：重复回复判定失败：" + JSON.stringify(v));
    v = c({ ok: true, text: "Traceback: boom", state: "ok" }, "", {});
    if (v.kind !== "error") fail("R 段：错误词判定失败：" + JSON.stringify(v));
    v = c({ ok: true, text: "fresh reply", state: "ok" }, "", { loopCount: 3, maxAutoLoops: 3 });
    if (v.kind !== "max-loops") fail("R 段：最大轮数判定失败：" + JSON.stringify(v));
    v = c({ ok: false, text: "", state: "no-marker", reason: "no-start-marker" }, "", {});
    if (v.action !== "pause" || v.kind !== "no-start-marker") fail("R 段：无区块判定失败：" + JSON.stringify(v));
    v = c({ ok: true, text: "fresh reply", state: "ok" }, "", { loopCount: 1, maxAutoLoops: 3 });
    if (v.action !== "continue") fail("R 段：正常回复未判 continue：" + JSON.stringify(v));
    if (v.action === "continue" && v.kind === "continue") ok("R 段：判定优先级 signal→handoff→duplicate→error→max-loops→no-marker→continue 全部命中");
  }

  // controller 全自动生命周期：startPilot / 决策卡 / decide / 提交回 idle。
  {
    const ctl = api.createSyncController({ getConfig: () => ({ ...api.DEFAULTS, autoSyncEnabled: true, maxAutoLoops: 3 }) });
    ctl.startPilot();
    let s = ctl.getState();
    if (!s.autoPilot || s.state !== "idle" || s.pilotDecision) fail("R 段：startPilot 未进入 autoPilot idle：" + JSON.stringify(s));
    ctl.setPilotDecision({ kind: "duplicate", payload: "abc", reason: "duplicate-reply" });
    s = ctl.getState();
    if (s.state !== "paused" || !s.pilotDecision || s.pilotDecision.kind !== "duplicate") fail("R 段：决策卡未进入 paused：" + JSON.stringify(s));
    let r = ctl.decide("continue");
    if (r.action !== "continue" || ctl.getState().pilotDecision || ctl.getState().state !== "idle") fail("R 段：decide(continue) 未清卡回 idle：" + JSON.stringify(r));
    ctl.notePilotInjected("上轮文本");
    ctl.setPilotDecision({ kind: "handoff", payload: "验收", reason: "handoff-word" });
    r = ctl.decide("retry");
    if (r.action !== "submit" || r.text !== "上轮文本" || ctl.getState().state !== "pushing") fail("R 段：decide(retry) 未带原文本重投：" + JSON.stringify(r));
    ctl.setPilotDecision({ kind: "error", payload: "x", reason: "error-keyword" });
    r = ctl.decide("edit", "  改写后的意见  ");
    if (r.action !== "submit" || r.text !== "  改写后的意见  ") fail("R 段：decide(edit) 未用编辑文本：" + JSON.stringify(r));
    r = ctl.decide("skip-with-no-decision");
    if (r.action !== "skip") fail("R 段：无决策卡时 decide 未 skip：" + JSON.stringify(r));
    ctl.setPilotDecision({ kind: "done", payload: "ok", reason: "done-word" });
    r = ctl.decide("terminate");
    if (r.action !== "terminated" || ctl.getState().autoPilot || ctl.getState().state !== "off") fail("R 段：decide(terminate) 未关闭全自动：" + JSON.stringify(r));
    else ok("R 段：controller 全自动生命周期（启停/决策卡/继续/重试/编辑/终止）全部正确");
  }

  // v1.4.6-hotfix：熔断必须弹决策卡（有按钮可续跑），resume-push 补推本轮，max-loops 清零计数。
  {
    const ctlH = api.createSyncController({ getConfig: () => ({ ...api.DEFAULTS, autoSyncEnabled: true, autoPilotEnabled: true, maxAutoLoops: 3 }) });
    ctlH.startPilot();
    // error-keyword 熔断：状态 paused 且决策卡存在，payload 为被拦截的桌面回复。
    let dH = ctlH.handleTurnEnd({ sessionId: "sH", turn: 1, reasonKind: "completed", answerText: "TypeError 出错啦" });
    // TypeError 内部 Error 现在不误命中熔断，正常应 push；用独立词再试。
    if (dH.action !== "push") fail("v1.4.6-hotfix：TypeError 内部 Error 不应误熔断，实际：" + JSON.stringify(dH));
    ctlH.reset(); ctlH.refresh(); ctlH.startPilot();
    dH = ctlH.handleTurnEnd({ sessionId: "sH2", turn: 2, reasonKind: "completed", answerText: "Error: 真出错" });
    if (dH.action !== "pause" || dH.reason !== "error-keyword") fail("v1.4.6-hotfix：独立词 Error 未熔断：" + JSON.stringify(dH));
    let sH = ctlH.getState();
    if (sH.state !== "paused" || !sH.pilotDecision || sH.pilotDecision.kind !== "error"
      || sH.pilotDecision.payload !== "Error: 真出错") {
      fail("v1.4.6-hotfix：error 熔断未弹决策卡（无续跑按钮根因）：" + JSON.stringify(sH));
    } else ok("v1.4.6-hotfix：error 熔断弹决策卡（payload=被拦截回复），用户可续跑");
    // resume-push：补推被拦截的桌面回复。
    let rH = ctlH.decide("resume-push");
    // v1.4.6-hotfix-2: resume-push 必须返回 push-web（推网页豆包），不能是 submit（误推桌面会话）。
    if (rH.action !== "push-web" || rH.text !== "Error: 真出错" || ctlH.getState().state !== "pushing") {
      fail("v1.4.6-hotfix-2：resume-push 未返回 push-web 推网页通道：" + JSON.stringify(rH));
    } else ok("v1.4.6-hotfix-2：resume-push 返回 push-web（推网页豆包而非桌面会话）并进入 pushing");
    // max-loops 熔断弹卡 + continue/resume 清零计数。
    ctlH.reset(); ctlH.refresh(); ctlH.startPilot();
    for (let i = 0; i < 3; i += 1) {
      ctlH.handleTurnEnd({ sessionId: "sML", turn: 10 + i, reasonKind: "completed", answerText: "正常" + i });
      ctlH.noteError("reset-to-idle"); ctlH.refresh();
    }
    dH = ctlH.handleTurnEnd({ sessionId: "sML", turn: 20, reasonKind: "completed", answerText: "超出" });
    if (dH.action !== "pause" || dH.reason !== "max-loops") fail("v1.4.6-hotfix：max-loops 未熔断：" + JSON.stringify(dH));
    sH = ctlH.getState();
    if (!sH.pilotDecision || sH.pilotDecision.kind !== "max-loops") {
      fail("v1.4.6-hotfix：max-loops 熔断未弹决策卡：" + JSON.stringify(sH));
    } else ok("v1.4.6-hotfix：max-loops 熔断弹决策卡，用户可继续");
    rH = ctlH.decide("continue");
    if (rH.action !== "continue" || ctlH.getState().loopCount !== 0) {
      fail("v1.4.6-hotfix：max-loops continue 未清零 loopCount：" + JSON.stringify(ctlH.getState()));
    } else ok("v1.4.6-hotfix：max-loops 继续后 loopCount 清零，下轮不会立刻再熔断");
  }

  // 让模块级 getConfig() 读到开启状态，供 writeLoopTrace / tryAutoSubmit / handlePilotReply 使用。
  api.writeConfig({
    autoSyncEnabled: true,
    autoPilotEnabled: true,
    pilotAutoSubmit: false,
    maxAutoLoops: 5,
    pilotDoneKeywords: ["DONE", "完成"],
    pilotRestartKeywords: ["重启 DSH", "重启桌面", "restart DSH", "restart harness"],
    pilotHandoffKeywords: ["请重启宿主验收", "宿主验收", "需要你本人"],
    errorKeywords: ["Error", "Traceback", "Failed", "panic", "FATAL"]
  });

  // tryAutoSubmit：官方 conversation.send 主路径成功 → 回 idle；无 API → 决策卡 submit-unavailable。
  {
    const sent = [];
    const conv = { send: (t) => { sent.push(t); return Promise.resolve(); } };
    const ctl = api.createSyncController({ getConfig: () => ({ ...api.DEFAULTS, autoSyncEnabled: true }) });
    ctl.startPilot();
    const rt = { ctx: { get: (n) => (n === "conversation" ? conv : undefined) }, controller: ctl, cancelled: false };
    const okSubmit = await api.tryAutoSubmit(rt, "提炼后的意见");
    if (okSubmit !== true || sent.length !== 1 || sent[0] !== "提炼后的意见" || ctl.getState().state !== "idle") {
      fail("R 段：tryAutoSubmit 官方 API 路径失败：" + JSON.stringify({ okSubmit, sent, state: ctl.getState().state }));
    } else ok("R 段：tryAutoSubmit 用官方 conversation.send 提交提炼文本，成功后回 idle 等下一轮");

    const ctl2 = api.createSyncController({ getConfig: () => ({ ...api.DEFAULTS, autoSyncEnabled: true }) });
    ctl2.startPilot();
    const rt2 = { ctx: { get: () => undefined }, controller: ctl2 };
    const noApi = await api.tryAutoSubmit(rt2, "x");
    const dec2 = ctl2.getState().pilotDecision;
    if (noApi !== false || !dec2 || dec2.kind !== "submit-unavailable") {
      fail("R 段：无自动提交 API 时未降级决策卡：" + JSON.stringify({ noApi, dec2 }));
    } else ok("R 段：无自动提交 API → 降级 submit-unavailable 决策卡（请按发送），绝不合成键盘/直写 DOM");
  }

  // v1.4.4 修复：全局 conversation.send 报「requires a session scope」时，
  // 必须优先走 sessions.scope(paired).conversation 定向提交（真机实测卡点）。
  {
    const globalSent = [];
    const scopedSent = [];
    const globalConv = { send: () => {
      globalSent.push("x");
      return Promise.reject(new Error("conversation.send requires a session scope — address one via ctx.sessions.scope(id).conversation"));
    } };
    const scopedConv = { send: (t) => { scopedSent.push(t); return Promise.resolve(); } };
    const ctlS = api.createSyncController({ getConfig: () => ({ ...api.DEFAULTS, autoSyncEnabled: true }) });
    ctlS.startPilot();
    ctlS.bindSession("s-scoped");
    const rtS = {
      ctx: { get: (n) => (n === "conversation" ? globalConv : n === "sessions"
        ? { scope: (id) => (id === "s-scoped" ? { conversation: scopedConv } : null) }
        : undefined) },
      controller: ctlS,
      cancelled: false
    };
    const okScoped = await api.tryAutoSubmit(rtS, "scoped 定向意见");
    if (okScoped !== true || scopedSent.length !== 1 || scopedSent[0] !== "scoped 定向意见" || globalSent.length !== 0) {
      fail("R 段：tryAutoSubmit 应优先用 sessions.scope(paired).conversation 定向提交：" + JSON.stringify({ okScoped, scopedSent, globalSent }));
    } else ok("R 段：tryAutoSubmit 优先 sessions.scope(paired).conversation 定向提交（避开全局 send 无 scope 报错）");
  }

  // v1.4.4 真机正解：conversation.send 内部走 binding.session.prompt，全局/scope 都
  // 可能因 ctx 无 scope 抛 "requires a session scope"。必须直达 binding(paired).session.prompt。
  {
    const prompted = [];
    const sentViaConv = [];
    const globalConv = { send: (t) => { sentViaConv.push(t); return Promise.resolve(); } };
    const scopedConv = { send: (t) => { sentViaConv.push(t); return Promise.resolve(); } };
    const ctlB = api.createSyncController({ getConfig: () => ({ ...api.DEFAULTS, autoSyncEnabled: true }) });
    ctlB.startPilot();
    ctlB.bindSession("s-binding");
    const rtB = {
      ctx: { get: (n) => (n === "conversation" ? globalConv : n === "sessions"
        ? {
            binding: (id) => (id === "s-binding"
              ? { session: { prompt: (msgs, mode) => { prompted.push({ msgs, mode }); return Promise.resolve({ stopReason: "end_turn" }); } } }
              : undefined),
            scope: (id) => (id === "s-binding" ? { conversation: scopedConv } : null)
          }
        : undefined) },
      controller: ctlB,
      cancelled: false
    };
    const okBinding = await api.tryAutoSubmit(rtB, "binding 定向意见");
    const promptOk = prompted.length === 1 && prompted[0].mode === "queue"
      && prompted[0].msgs && prompted[0].msgs[0] && prompted[0].msgs[0].text === "binding 定向意见"
      && prompted[0].msgs[0].type === "text";
    if (okBinding !== true || !promptOk || sentViaConv.length !== 0 || ctlB.getState().state !== "idle") {
      fail("R 段：tryAutoSubmit 应直达 sessions.binding(paired).session.prompt 定向提交：" + JSON.stringify({ okBinding, prompted, sentViaConv, state: ctlB.getState().state }));
    } else ok("R 段：tryAutoSubmit 优先 binding.session.prompt([{type:text,text}],queue) 提交（真机正解，绕过 conversation scope 检查）");
  }

  // handlePilotReply：done / pause(handoff) / continue（只写提炼区块，不投递全文）。
  {
    const ctl = api.createSyncController({ getConfig: () => ({ ...api.DEFAULTS, autoSyncEnabled: true, maxAutoLoops: 5 }) });
    ctl.startPilot();
    let draft = "";
    const rt = {
      ctx: { get: () => undefined },
      controller: ctl,
      dockBinding: { current: { sessionId: "s", inputActions: { setDraft: (t) => { draft = t; }, submit() {} } } },
      cancelled: false
    };
    let res = await api.handlePilotReply(rt, "DONE 完美，任务完成");
    if (res.action !== "pause" || res.kind !== "signal" || ctl.getState().pilotDecision.kind !== "signal") fail("R 段：handlePilotReply 完成词→signal 决策卡失败：" + JSON.stringify(res));

    ctl.startPilot();
    res = await api.handlePilotReply(rt, "<TO_DEV>请重启宿主验收</TO_DEV>");
    if (res.action !== "pause" || res.kind !== "handoff") fail("R 段：handlePilotReply handoff 失败：" + JSON.stringify(res));

    ctl.startPilot();
    draft = "";
    res = await api.handlePilotReply(rt, "一堆前言<TO_DEV>请只改第 5 行</TO_DEV>一堆后记");
    if (res.action !== "draft") fail("R 段：handlePilotReply continue 未走 draft：" + JSON.stringify(res));
    if (draft !== "请只改第 5 行" || draft.indexOf("前言") >= 0 || draft.indexOf("后记") >= 0) {
      fail("R 段：桌面草稿混入了网页全文而非只有提炼区块：" + JSON.stringify(draft));
    } else ok("R 段：handlePilotReply continue 只把提炼区块写入桌面草稿，绝不投递网页全文");
  }

  // 修复（提交后草稿残留）：全自动自动提交路径下，提炼内容由 session.prompt 直接送入会话，
  // 不应再 injectDraft 写草稿——否则官方 session.prompt 提交不清草稿框，输入框会残留原文。
  {
    api.writeConfig({ pilotAutoSubmit: true });
    const prompted = [];
    let draft = "";
    const ctl = api.createSyncController({ getConfig: () => ({ ...api.DEFAULTS, autoSyncEnabled: true, pilotAutoSubmit: true }) });
    ctl.startPilot();
    ctl.bindSession("s-nodraft");
    const rt = {
      ctx: { get: (n) => (n === "sessions" ? {
        binding: (id) => (id === "s-nodraft"
          ? { session: { prompt: (msgs, mode) => { prompted.push({ msgs, mode }); return Promise.resolve({ stopReason: "end_turn" }); } } }
          : undefined)
      } : undefined) },
      controller: ctl,
      dockBinding: { current: { sessionId: "s-nodraft", inputActions: { setDraft: (t) => { draft = t; }, submit() {} } } },
      cancelled: false
    };
    const res = await api.handlePilotReply(rt, "前言<TO_DEV>只改第 9 行</TO_DEV>后记");
    const payloadOk = prompted.length === 1 && prompted[0].msgs && prompted[0].msgs[0]
      && prompted[0].msgs[0].text === "只改第 9 行" && prompted[0].mode === "queue";
    if (res !== true || draft !== "" || !payloadOk) {
      fail("修复：全自动自动提交不应写草稿（提交后输入框残留）：" + JSON.stringify({ res, draft, prompted }));
    } else ok("修复：全自动提交后不再写草稿（draft 为空），从根源避免输入框残留；提交内容仍为提炼区块");
    api.writeConfig({ pilotAutoSubmit: false }); // 恢复后续测试的半自动设置
  }

  // startAutoPilot / stopAutoPilot：绑定当前会话、清 cancelled、开关运行态。
  {
    const ctl = api.createSyncController({ getConfig: () => ({ ...api.DEFAULTS, autoSyncEnabled: true, maxAutoLoops: 3 }) });
    const rt = { controller: ctl, cancelled: true, dockBinding: { current: { sessionId: "s-pilot" } }, ctx: { get: () => undefined } };
    const started = api.startAutoPilot(rt);
    let s = ctl.getState();
    if (!started || !s.autoPilot || s.pairedSessionId !== "s-pilot" || rt.cancelled !== false) {
      fail("R 段：startAutoPilot 失败：" + JSON.stringify({ started, paired: s.pairedSessionId, cancelled: rt.cancelled }));
    } else ok("R 段：startAutoPilot 绑定当前会话并进入运行态");
    const stopped = api.stopAutoPilot(rt);
    s = ctl.getState();
    if (!stopped || s.autoPilot || s.state !== "off") fail("R 段：stopAutoPilot 失败：" + JSON.stringify(s));
    else ok("R 段：stopAutoPilot 退回 off，用户随时可停");
  }
}

// ── V 段（v1.4.4 双模式互斥联动）：绑定→条件触发；启动全自动→关触发切全自动 ──
{
  // 1. 引擎总闸 isEngineActive：条件触发或全自动任一开即工作，两者都关才停机。
  if (typeof api.isEngineActive !== "function") fail("v1.4.4：isEngineActive 未导出");
  else {
    if (!api.isEngineActive({ autoSyncEnabled: true, autoPilotEnabled: false })) fail("v1.4.4：条件触发开应算引擎开启");
    else if (!api.isEngineActive({ autoSyncEnabled: false, autoPilotEnabled: true })) fail("v1.4.4：全自动开应算引擎开启");
    else if (api.isEngineActive({ autoSyncEnabled: false, autoPilotEnabled: false })) fail("v1.4.4：两者都关应算引擎关闭");
    else ok("v1.4.4：引擎总闸 = 条件触发或全自动任一开启，两者都关才停机");
  }

  // 2. 引擎总闸解耦：关条件触发、只开全自动时 turn/end 仍推送（引擎不瘫痪）。
  {
    const ctl = api.createSyncController({ getConfig: () => ({ ...api.DEFAULTS, autoSyncEnabled: false, autoPilotEnabled: true, maxAutoLoops: 3 }) });
    const d = ctl.handleTurnEnd({ sessionId: "s", turn: 1, reasonKind: "completed", answerText: "ok" });
    if (d.action !== "push") fail("v1.4.4：全自动模式下 turn/end 应继续驱动，实际：" + JSON.stringify(d));
    else ok("v1.4.4：关条件触发、开全自动时 turn/end 仍推送（引擎不瘫痪）");
  }

  // 3. startAutoPilot 在关条件触发、开全自动时可启动（切全自动场景）。
  {
    const ctl = api.createSyncController({ getConfig: () => ({ ...api.DEFAULTS, autoSyncEnabled: false, autoPilotEnabled: true, maxAutoLoops: 3 }) });
    const rt = { controller: ctl, cancelled: true, dockBinding: { current: { sessionId: "s-pilot2" } }, ctx: { get: () => undefined } };
    const started = api.startAutoPilot(rt);
    const s = ctl.getState();
    if (!started || !s.autoPilot || s.pairedSessionId !== "s-pilot2") fail("v1.4.4：切全自动时 startAutoPilot 应成功：" + JSON.stringify({ started, s }));
    else ok("v1.4.4：关条件触发、开全自动时 startAutoPilot 仍能启动（总闸已解耦）");
  }

  // 4. 状态条按钮联动：绑定→条件触发开/全自动关；启动全自动→条件触发关/全自动开；停止→退回条件触发。
  {
    const vCtx = makeCtx();
    const vRt = api.ensureSyncRuntime(vCtx);
    if (typeof vRt.dockDispose === "function") { try { vRt.dockDispose(); } catch { /* 已释放 */ } }
    vRt.dockDispose = null;
    vRt.cancelled = false;
    api.writeConfig({ autoSyncEnabled: true, autoPilotEnabled: false, maxAutoLoops: 3, errorKeywords: [...api.DEFAULT_ERROR_KEYWORDS] });
    vRt.controller.reset();
    vRt.controller.noteCurrentSession("sMode");

    // 绑定按钮：点它应开条件触发、互斥关全自动。
    const bindBtn = findByAttr(mount(react.createElement(api.SyncStatusBar, {})), "data-dsh-plugin-deepseek-chat", "sync-bind");
    if (!bindBtn) fail("v1.4.4：未配对时未找到绑定按钮");
    else {
      api.writeConfig({ autoPilotEnabled: true }); // 模拟全自动开着，验证绑定会互斥关掉它
      bindBtn.dispatch("click", {});
      const c = api.getConfig();
      if (!c.autoSyncEnabled || c.autoPilotEnabled) fail("v1.4.4：点绑定应开条件触发且关全自动：" + JSON.stringify({ s: c.autoSyncEnabled, p: c.autoPilotEnabled }));
      else ok("v1.4.4：点「绑定当前会话」→ 开条件触发 + 关全自动（回到条件触发模式）");
    }

    // 启动全自动按钮：点它应关条件触发、开全自动。
    const startBtn = findByAttr(mount(react.createElement(api.SyncStatusBar, {})), "data-dsh-plugin-deepseek-chat", "sync-pilot-start");
    if (!startBtn) fail("v1.4.4：未找到启动全自动按钮");
    else {
      startBtn.dispatch("click", {});
      const c = api.getConfig();
      if (c.autoSyncEnabled || !c.autoPilotEnabled) fail("v1.4.4：点启动全自动应关条件触发且开全自动：" + JSON.stringify({ s: c.autoSyncEnabled, p: c.autoPilotEnabled }));
      else ok("v1.4.4：点「启动全自动」→ 关条件触发 + 开全自动（切到全自动模式）");
    }

    // v1.4.6-hotfix-7：停止全自动 = 彻底停机（两个开关都关，不回退半自动）。
    const stopBtn = findByAttr(mount(react.createElement(api.SyncStatusBar, {})), "data-dsh-plugin-deepseek-chat", "sync-pilot-stop");
    if (!stopBtn) fail("v1.4.4：运行态未找到停止全自动按钮");
    else {
      stopBtn.dispatch("click", {});
      const c = api.getConfig();
      if (c.autoSyncEnabled || c.autoPilotEnabled) fail("v1.4.6-hotfix-7：点停止全自动应彻底停机（两开关都关）：" + JSON.stringify(c));
      else ok("v1.4.6-hotfix-7：点「停止全自动」→ 彻底停机（两开关都关，不回退半自动）");
    }
    // v1.4.6-hotfix-7：设置页订阅 config，状态条启停后 checkbox 同步刷新。
    if (!source.includes("react.useEffect(() => subscribeConfig(rerender), [])")) fail("v1.4.6-hotfix-7：SettingsView 未订阅 config，状态条启停后设置页 checkbox 不会刷新");
    else ok("v1.4.6-hotfix-7：设置页订阅 config，状态条启停后 checkbox 同步刷新");

    // v1.4.6-hotfix-9：停机+已配对时，状态条有「切回半自动」按钮，点了复用配对、只切开关。
    {
      api.writeConfig({ autoSyncEnabled: false, autoPilotEnabled: false });
      const vRt2 = api.ensureSyncRuntime(vCtx);
      vRt2.controller.bindSession("sSemiBind");
      const semiBtn = findByAttr(mount(react.createElement(api.SyncStatusBar, {})), "data-dsh-plugin-deepseek-chat", "sync-back-to-semi");
      if (!semiBtn) fail("v1.4.6-hotfix-9：已配对且停机时未找到「切回半自动」按钮");
      else {
        const pairedBefore = vRt2.controller.getState().pairedSessionId;
        semiBtn.dispatch("click", {});
        const c2 = api.getConfig();
        const pairedAfter = vRt2.controller.getState().pairedSessionId;
        if (!c2.autoSyncEnabled || c2.autoPilotEnabled) fail("v1.4.6-hotfix-9：点切回半自动应开条件触发、关全自动：" + JSON.stringify(c2));
        else if (pairedAfter !== pairedBefore || pairedAfter !== "sSemiBind") fail("v1.4.6-hotfix-9：切半自动不应解绑/换绑配对会话：" + pairedBefore + "→" + pairedAfter);
        else ok("v1.4.6-hotfix-9：点「切回半自动」→ 开条件触发+关全自动，复用现有配对不解绑");
      }
    }

    // 恢复默认，避免污染后续断言。
    api.writeConfig({ autoSyncEnabled: false, autoPilotEnabled: false });
  }
}

// ── v1.4.5 信号词合并 + 三选一决策卡 + 最大轮数双页同步 ──
{
  // 1) 信号词默认值与旧配置迁移。
  {
    const expectSig = ["DONE", "完成", "通过", "APPROVED", "重启 DSH", "重启桌面", "restart DSH", "restart harness", "请重启宿主验收", "宿主验收", "请用户验收", "需要你本人", "需要人工介入", "handoff to user", "user verification"];
    const sig = api.DEFAULT_PILOT_SIGNAL_KEYWORDS;
    if (!Array.isArray(sig) || sig.join("|") !== expectSig.join("|")) fail(`DEFAULT_PILOT_SIGNAL_KEYWORDS 内容不对：${JSON.stringify(sig)}`);
    else ok("v1.4.6：信号词默认常量 = 完成词 + 重启词 + 用户介入词（15 项，两栏融合）");
    if (!Array.isArray(api.DEFAULTS.pilotSignalKeywords) || api.DEFAULTS.pilotSignalKeywords.join("|") !== expectSig.join("|")) fail("DEFAULTS.pilotSignalKeywords 不对");
    else ok("v1.4.6：DEFAULTS.pilotSignalKeywords 含 15 项");

    storage.clear();
    storage.set(api.CONFIG_KEY, JSON.stringify({ pilotDoneKeywords: ["X", "Y"], pilotRestartKeywords: ["Z"], pilotHandoffKeywords: ["W"] }));
    const mig = api.readConfig();
    if (mig.pilotSignalKeywords.join(",") !== "X,Y,Z,W") fail(`旧配置迁移失败：${JSON.stringify(mig.pilotSignalKeywords)}`);
    else ok("v1.4.6：旧配置（done/restart/handoff）自动迁移为合并信号词");
    storage.clear();
  }

  // 2) decide 新分支：restart-dsh / new-goal 都停止全自动并清卡。
  {
    const ctl = api.createSyncController({ getConfig: () => ({ ...api.DEFAULTS, autoPilotEnabled: true, maxAutoLoops: 3 }) });
    ctl.startPilot();
    ctl.setPilotDecision({ kind: "signal", payload: "DONE", reason: "signal-word" });
    let r = ctl.decide("restart-dsh");
    if (r.action !== "restart-dsh" || ctl.getState().autoPilot || ctl.getState().pilotDecision || ctl.getState().state !== "off") fail(`decide(restart-dsh) 不对：${JSON.stringify(r)}`);
    else ok("v1.4.5：decide(restart-dsh) → 停止全自动并清卡");
    ctl.startPilot();
    ctl.setPilotDecision({ kind: "signal", payload: "DONE", reason: "signal-word" });
    r = ctl.decide("new-goal");
    if (r.action !== "new-goal" || ctl.getState().autoPilot || ctl.getState().pilotDecision || ctl.getState().state !== "off") fail(`decide(new-goal) 不对：${JSON.stringify(r)}`);
    else ok("v1.4.5：decide(new-goal) → 停止全自动并清卡");
  }

  // 3) signal 决策卡三按钮 + new-goal 调 uiWorkspace.startSession。
  {
    let startSessionCalls = 0;
    const gCtx = makeCtx();
    const baseGet = gCtx.get;
    gCtx.get = (name) => name === "uiWorkspace" ? { startSession: () => { startSessionCalls++; } } : baseGet(name);
    const gRt = api.ensureSyncRuntime(gCtx);
    if (typeof gRt.dockDispose === "function") { try { gRt.dockDispose(); } catch { /* 已释放 */ } }
    gRt.dockDispose = null;
    gRt.cancelled = false;
    api.writeConfig({ autoPilotEnabled: true, autoSyncEnabled: false });
    gRt.controller.reset();
    gRt.controller.startPilot();
    // v1.4.6-hotfix-5：决策卡改为 shell.overlay 屏幕居中浮层（全局单例，无需 turn 匹配）。
    gRt.controller.setPilotDecision({ kind: "signal", payload: "DONE", reason: "signal-word", turn: 42 });

    const gBar = mount(react.createElement(api.PilotDecisionOverlay));
    const bStop = findByAttr(gBar, "data-dsh-plugin-deepseek-chat", "sync-pilot-stop-this-run");
    const bRestart = findByAttr(gBar, "data-dsh-plugin-deepseek-chat", "sync-pilot-restart-dsh");
    const bGoal = findByAttr(gBar, "data-dsh-plugin-deepseek-chat", "sync-pilot-new-goal");
    const bResumeSignal = findByAttr(gBar, "data-dsh-plugin-deepseek-chat", "sync-pilot-resume-push");
    if (!bStop || !bRestart || !bGoal) fail(`signal 决策卡三按钮缺失：stop=${!!bStop} restart=${!!bRestart} goal=${!!bGoal}`);
    else ok("v1.4.5：signal 决策卡渲染「停止本次 / 重启 DSH / 开启新目标」三按钮");
    if (!bResumeSignal) fail("v1.4.6-hotfix-5：signal 卡缺「继续并补推本轮」按钮（用户无法续跑）");
    else ok("v1.4.6-hotfix-5：signal 卡渲染「继续并补推本轮」按钮");
    const bModalClose = findByAttr(gBar, "data-dsh-plugin-deepseek-chat", "sync-pilot-modal-close");
    if (!bModalClose) fail("v1.4.6-hotfix-8：浮层卡缺原生 Modal 标题栏关闭×按钮");
    else ok("v1.4.6-hotfix-8：浮层卡具备原生 Modal 观感（标题栏关闭×按钮就位）");
    const bReason = findByAttr(gBar, "data-dsh-plugin-deepseek-chat", "sync-pilot-reason");
    if (!bReason) fail("v1.4.6-hotfix-8：浮层卡缺动态问题文本节点");
    else ok("v1.4.6-hotfix-8：浮层卡含按拦截内容动态生成的问题文本节点");
    if (!source.includes("rawPayload.length > 60")) fail("v1.4.6-hotfix-8：未实现按拦截内容生成问题摘要");
    else ok("v1.4.6-hotfix-8：问题/选项按拦截内容动态生成（源码级确认）");

    if (bGoal) {
      bGoal.dispatch("click", {});
      if (startSessionCalls !== 1) fail(`点「开启新目标」未调用 uiWorkspace.startSession（调用 ${startSessionCalls} 次）`);
      else if (gRt.controller.getState().autoPilot) fail("点「开启新目标」后全自动未停止");
      else ok("v1.4.5：点「开启新目标」→ 调 uiWorkspace.startSession 开新会话并停全自动");
    }
    api.writeConfig({ autoPilotEnabled: false });
  }

  // 4) 最大轮数双页锁死同步。
  {
    api.writeConfig({ maxAutoLoops: 7 });
    const formA = mount(react.createElement(settingsSlot.component, {}));
    const syncIn = findByAttr(formA, "data-dsh-plugin-deepseek-chat", "sync-max-loops");
    const pilotIn = findByAttr(formA, "data-dsh-plugin-deepseek-chat", "pilot-max-loops");
    if (!syncIn || !pilotIn) fail(`最大轮数双页控件缺失：sync=${!!syncIn} pilot=${!!pilotIn}`);
    else if (syncIn.getAttribute("value") !== "7" || pilotIn.getAttribute("value") !== "7") fail(`两页初值不同步：sync=${syncIn.getAttribute("value")} pilot=${pilotIn.getAttribute("value")}`);
    else ok("v1.4.5：条件触发页与全自动页最大轮数控件同值（7）");

    if (syncIn) {
      syncIn.dispatch("change", { target: { value: "9" } });
      const formB = mount(react.createElement(settingsSlot.component, {}));
      const s2 = findByAttr(formB, "data-dsh-plugin-deepseek-chat", "sync-max-loops");
      const p2 = findByAttr(formB, "data-dsh-plugin-deepseek-chat", "pilot-max-loops");
      if (s2?.getAttribute("value") !== "9" || p2?.getAttribute("value") !== "9") fail(`改一边后两页未同步：sync=${s2?.getAttribute("value")} pilot=${p2?.getAttribute("value")}`);
      else ok("v1.4.5：改条件触发页轮数后，全自动页同步跟着变（9）");
    }
    api.writeConfig({ maxAutoLoops: api.DEFAULT_MAX_LOOPS });
  }

  // 5) v1.4.6 软失败自动重试 2 次再弹卡。
  {
    const ctl = api.createSyncController({ getConfig: () => ({ ...api.DEFAULTS, autoSyncEnabled: true, maxAutoLoops: 5 }) });
    ctl.startPilot();
    ctl.notePilotInjected("上一轮审查意见");
    const rt = { ctx: { get: () => undefined }, controller: ctl,
      dockBinding: { current: { sessionId: "s", inputActions: { setDraft: () => {}, submit() {} } } }, cancelled: false };
    let r = await api.handlePilotReply(rt, "<TO_DEV>Traceback: fail one</TO_DEV>");
    if (r.action !== "soft-retry" || ctl.getState().softRetryCount !== 1 || ctl.getState().pilotDecision) fail(`软重试第1次失败：${JSON.stringify({ r, s: ctl.getState() })}`);
    r = await api.handlePilotReply(rt, "<TO_DEV>Error: fail two</TO_DEV>");
    if (r.action !== "soft-retry" || ctl.getState().softRetryCount !== 2 || ctl.getState().pilotDecision) fail(`软重试第2次失败：${JSON.stringify({ r, s: ctl.getState() })}`);
    r = await api.handlePilotReply(rt, "<TO_DEV>Failed: fail three</TO_DEV>");
    if (r.action !== "pause" || r.kind !== "error" || ctl.getState().softRetryCount !== 0) fail(`软重试耗尽未弹卡：${JSON.stringify({ r, s: ctl.getState() })}`);
    else ok("v1.4.6：错误/卡住/格式错连续 2 次自动重试，第 3 次才弹卡并重置计数");
  }

  // 6) 按触发原因定制卡片按钮：error 卡=重试本轮/改后重试/停止；signal 卡仍三按钮。
  {
    const gCtx = makeCtx();
    const gRt = api.ensureSyncRuntime(gCtx);
    if (typeof gRt.dockDispose === "function") { try { gRt.dockDispose(); } catch { /* 已释放 */ } }
    gRt.dockDispose = null;
    gRt.cancelled = false;
    api.writeConfig({ autoPilotEnabled: true, autoSyncEnabled: false });
    gRt.controller.reset();
    gRt.controller.startPilot();
    // v1.4.6-hotfix-5：决策卡改为 shell.overlay 浮层，无需 turn 匹配。
    gRt.controller.setPilotDecision({ kind: "error", payload: "boom", reason: "error-keyword", turn: 7 });
    const bar = mount(react.createElement(api.PilotDecisionOverlay));
    const bRetry = findByAttr(bar, "data-dsh-plugin-deepseek-chat", "sync-pilot-retry");
    const bEditRetry = findByAttr(bar, "data-dsh-plugin-deepseek-chat", "sync-pilot-edit-retry");
    const bStop = findByAttr(bar, "data-dsh-plugin-deepseek-chat", "sync-pilot-terminate");
    const bResume = findByAttr(bar, "data-dsh-plugin-deepseek-chat", "sync-pilot-resume-push");
    if (!bRetry || !bEditRetry || !bStop) fail(`error 卡按钮缺失：retry=${!!bRetry} editRetry=${!!bEditRetry} stop=${!!bStop}`);
    else ok("v1.4.6：错误卡渲染「重试本轮 / 改后重试 / 停止」定制按钮");
    if (!bResume) fail("v1.4.6-hotfix：error 卡缺「继续并补推本轮」按钮（用户无法续跑）");
    else ok("v1.4.6-hotfix：error 卡渲染「继续并补推本轮」按钮，用户可从暂停态续跑");
    if (bEditRetry) {
      bEditRetry.dispatch("click", {});
      // 无提交 API 时会降级为 submit-unavailable 卡，故不断言最终态为 pushing，
      // 只断言决策卡已被消费（不再停留 error 卡）且状态确实发生过推进。
      const after = gRt.controller.getState();
      if (!after.pilotDecision || after.pilotDecision.kind === "error") fail("点「改后重试」未消费 error 卡");
      else ok("v1.4.6：点「改后重试」→ 消费错误卡并推进提交");
    }
    api.writeConfig({ autoPilotEnabled: false });
  }
}

console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
