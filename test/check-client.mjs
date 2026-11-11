// dsh-plugin-deepseek-chat 客户端包离线自检（v1.1.4）。
//
// 这个包是浏览器 ModuleLoader 脚本，因此自检：
//   1. 在 vm 里执行它，捕获 __ModuleLoader__.load 的注册；
//   2. 用桩化的 react / DOM / localStorage 实例化 factory；
//   3. 验证配置层（设置项默认值、类型校验、持久化、订阅通知）；
//   4. 在「Web 表层」（无桌面桥，应完全不注册）与「桌面表层」分别执行 apply()；
//   5. 校验四处槽位注册（左侧栏图标 / 全屏主面板 / 会话顶栏标签页 / 设置页）；
//   6. 验证设置页开关与自定义标签名能动态重注入顶栏标签页（标签行只在注册表变化时重算）；
//   7. 验证顶栏标签页是「铺满浮层」（盖住会话输入框）；
//   8. 迷你渲染面板，跑完 webview 租约、会话记忆、崩溃隔离、弹窗白名单等全流程，
//      并断言面板里不再有账号状态条。
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
let registration;
const sandbox = {
  window: { __ModuleLoader__: { load(value) { registration = value; } }, localStorage: localStorageStub },
  navigator: { language: "zh-CN" },
  document: documentStub,
  console,
  setTimeout,
  clearTimeout,
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
  if (api.DEFAULTS?.showTab !== true || api.DEFAULTS?.tabLabel !== "DeepSeek 聊天") fail(`默认值不对：${JSON.stringify(api.DEFAULTS)}`);
  else ok("设置默认值：showTab=true / tabLabel=DeepSeek 聊天");

  if (api.normalizeTabLabel("   ") !== "DeepSeek 聊天") fail("空白标签名没有回退默认");
  if (api.normalizeTabLabel("  X  ") !== "X") fail("标签名没有去首尾空格");
  if (api.normalizeTabLabel("x".repeat(50)).length !== 40) fail("超长标签名没有截断到 40");
  ok("标签名归一化：去空白、空回退默认、超长截断");

  storage.clear();
  storage.set(CONFIG_KEY, JSON.stringify({ showTab: "yes", tabLabel: 123 }));
  let c = api.readConfig();
  if (c.showTab !== true || c.tabLabel !== "DeepSeek 聊天") fail(`错误类型没有回退默认：${JSON.stringify(c)}`);
  storage.set(CONFIG_KEY, "{not json");
  c = api.readConfig();
  if (c.showTab !== true || c.tabLabel !== "DeepSeek 聊天") fail("损坏的 JSON 没有回退默认");
  storage.set(CONFIG_KEY, JSON.stringify({ showTab: false, tabLabel: "  X  " }));
  c = api.readConfig();
  if (c.showTab !== false || c.tabLabel !== "X") fail(`合法配置读取不对：${JSON.stringify(c)}`);
  ok("readConfig 按类型校验字段，损坏/错误类型回退默认");

  let received;
  const unsubscribe = api.subscribeConfig((next) => { received = next; });
  api.writeConfig({ showTab: false, tabLabel: "自定义" });
  if (received?.showTab !== false || received?.tabLabel !== "自定义") fail("writeConfig 没有通知订阅者");
  if (api.getConfig().showTab !== false || api.tabLabel() !== "自定义") fail("writeConfig 没有更新内存配置");
  if (storage.get(CONFIG_KEY) !== JSON.stringify({ showTab: false, tabLabel: "自定义" })) fail("writeConfig 没有持久化到 localStorage");
  else ok("writeConfig 合并 patch、持久化并通知订阅者");
  unsubscribe();
  received = void 0;
  api.writeConfig({ tabLabel: "再次" });
  if (received !== void 0) fail("取消订阅后仍然收到通知");
  else ok("subscribeConfig 返回的 disposer 能取消订阅");

  // 恢复模块级默认配置，避免影响后续注册测试；并清掉测试写入的 config 键。
  api.writeConfig({ showTab: true, tabLabel: "DeepSeek 聊天" });
  storage.clear();
  if (api.getConfig().showTab !== true || api.tabLabel() !== "DeepSeek 聊天") fail("测试后配置没有恢复默认");
  else ok("配置层测试结束，已恢复默认配置");
}

// ── 关于信息 + 检查更新逻辑（v1.1.5）────────────────────────────────────────
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

  // 语义版本比较（不能按字符串相等，本地 1.1.5 可领先已发布 1.1.2）。
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
const makeCtx = () => {
  const ctx = {
    registrations: [],
    history: [],
    injectCalls: [],
    effectCalls: [],
    effectCleanups: [],
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
    effect: (fn, name) => {
      ctx.effectCalls.push(name);
      const cleanup = fn();
      if (typeof cleanup === "function") ctx.effectCleanups.push(cleanup);
      return () => {};
    }
  };
  return ctx;
};
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
  const controls = (form) => {
    const inputs = findInputs(form);
    return {
      checkbox: inputs.find((input) => input.getAttribute("type") === "checkbox"),
      textbox: inputs.find((input) => input.getAttribute("type") === "text")
    };
  };
  const PLACEHOLDER = "DeepSeek 聊天";
  let { checkbox, textbox } = controls(mountForm());
  if (!checkbox || !textbox) fail("设置页缺少「显示顶部标签栏」复选框或「名称」输入框");
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

// ── 设置页渲染：关于本插件基础信息 + 检查更新按钮 ─────────────────────────
{
  api.resetUpdateState();
  const form = mount(react.createElement(settingsSlot.component, {}));
  const texts = collectTexts(form).join(" ");
  // 版本号 / 作者 / 功能简介 / 许可证 / 两个链接
  for (const required of [api.PLUGIN_VERSION, api.PLUGIN_AUTHOR, "功能简介", api.PLUGIN_LICENSE, "npm", "GitHub"]) {
    if (!texts.includes(required)) fail(`设置页缺少基础信息「${required}」`);
  }
  ok("设置页渲染基础信息：版本号 / 作者 / 功能简介 / 许可证 / npm·GitHub 链接");

  // 两个外链：https + target=_blank（桌面壳用系统浏览器打开）。
  const links = collectElements(form).filter((el) => el.tag === "a");
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

console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
