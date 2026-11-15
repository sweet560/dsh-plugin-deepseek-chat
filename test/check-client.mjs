// dsh-plugin-deepseek-chat 客户端包离线自检（v1.2.2）。
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
if (desktopCtx.registrations.length !== 4) fail(`桌面表层应有 4 处注册，实际 ${desktopCtx.registrations.length}`);
else ok("桌面表层恰好 4 处注册（主面板 / 左侧栏 / 顶栏标签 / 设置页）");

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
    if (desktopCtx.registrations.length !== 3) fail(`关闭后应剩 3 处注册，实际 ${desktopCtx.registrations.length}`);

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
    if (desktopCtx.registrations.length !== 4) fail(`恢复后应有 4 处注册，实际 ${desktopCtx.registrations.length}`);
    else ok("设置联动测试结束，恢复 4 处注册与默认标签名");
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
  if (noneCtx.registrations.length !== 4) fail("服务全缺席时应仍为 4 处槽位注册，实际 " + noneCtx.registrations.length);
  else if (noneCtx.cardRegistrations.length !== 0 || noneCtx.nativeRegistrations.length !== 0) fail("服务全缺席时不应注册任何右边栏卡片");
  else ok("服务全缺席：better-sidebar 未运行且原生 registry 未就绪 → 零卡片、其余四处表面照常");
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

  // 四组卡片边框（v1.2.0 增加自动闭环）：按逻辑分组、用主题令牌细边框/圆角/浅底。
  const cards = collectElements(form).filter((el) =>
    el.getAttribute("data-dsh-plugin-deepseek-chat") === "settings-card");
  if (cards.length !== 4) fail(`设置页应有 4 张分组卡片，实际 ${cards.length}`);
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

/** 纯网页聊天断言：根节点只有一个 host，无账号条、无账号文案。 */
function assertPureWebChat(page, where) {
  if (page?.children?.length !== 1) fail(`${where}：根节点应只有一个网页容器，实际 ${page?.children?.length} 个子节点`);
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

  // G. 状态条默认隐藏 + 设置页第 4 卡控件 + 总开关交互。
  const bar = mount(react.createElement(api.SyncStatusBar, {}));
  if (bar !== null) fail("autoSyncEnabled 默认 false 时状态条不该渲染");
  else ok("安全阀①：默认关闭时状态条隐藏，闭环完全不启动");
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

console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
