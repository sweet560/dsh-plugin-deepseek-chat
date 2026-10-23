// Offline validation for dsh-plugin-deepseek-chat's client bundle.
//
// The bundle is a browser ModuleLoader script, so this harness:
//   1. runs it in a vm with a captured __ModuleLoader__.load call;
//   2. materializes the factory with stubbed react, DOM and localStorage;
//   3. exercises apply() on the web surface (inert) and the desktop surface;
//   4. mini-renders the panel and drives the webview lease + conversation memory.
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

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`FAIL: ${message}`);
};
const ok = (message) => console.log(`ok: ${message}`);
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── fake DOM ────────────────────────────────────────────────────────────────
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
        if (node && typeof node === "object") node.isConnected = true;
      }
      element.children.push(...nodes);
    },
    remove() {
      element.removed = true;
      element.isConnected = false;
    },
    // Electron throws from every guest method once the element left the document;
    // the stub reproduces that so the teardown path is exercised for real.
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

// ── fake react with a minimal mount pass ────────────────────────────────────
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

/** Mount one rendered node tree into the fake DOM. */
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
      // Class components (the panel's error boundary) render through `render()`.
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

/** Run the effects queued by the last mount and return their cleanups. */
function flushEffects() {
  const cleanups = [];
  for (const effect of effects.splice(0)) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  return cleanups;
}

/** Locate the mounted guest webview inside the panel root. */
function findWebview(page) {
  const host = page?.children.find((child) => child?.tag === "div" && child.style.position === "relative");
  return host?.children.find((child) => child?.tag === "webview");
}

// ── load the bundle ─────────────────────────────────────────────────────────
let registration;
const sandbox = {
  window: { __ModuleLoader__: { load(value) { registration = value; } }, localStorage: localStorageStub },
  navigator: { language: "zh-CN" },
  document: documentStub,
  console,
  setTimeout,
  clearTimeout,
  URL
};
sandbox.globalThis = sandbox;
runInNewContext(source, sandbox, { filename: bundlePath });

if (!registration) throw new Error("bundle did not call window.__ModuleLoader__.load");
if (registration.id !== "dsh-plugin-deepseek-chat") fail(`unexpected bundle id: ${registration.id}`);
ok(`bundle id = ${registration.id}`);

const moduleExports = registration.factory((id) => {
  if (id === "react") return react;
  throw new Error(`unexpected require(${id})`);
});
if (typeof moduleExports.apply !== "function") fail("exports.apply missing");
if (!Array.isArray(moduleExports.inject)) fail("exports.inject missing");
ok(`exports.apply + inject = [${moduleExports.inject.join(", ")}]`);

// ── registration ───────────────────────────────────────────────────────────
const captured = { slots: [] };
const makeCtx = () => ({
  slots: {
    inject: (name, factory) => factory(),
    register: (definition, component) => {
      captured.slots.push({ definition, component });
      return () => {};
    }
  }
});

moduleExports.apply(makeCtx());
if (captured.slots.length !== 0) fail("plugin registered on the web surface");
else ok("inert without the desktop bridge");

sandbox.globalThis.dshDesktop = { protocolVersion: 1, browser: {} };
moduleExports.apply(makeCtx());
const mainSlot = captured.slots.find((slot) => slot.definition.name === "main");
const listSlot = captured.slots.find((slot) => slot.definition.name === "sidebar.panellist");
if (!mainSlot) fail("main panel slot not registered");
if (!listSlot) fail("sidebar.panellist entry not registered");
if (mainSlot?.definition.key !== "deepseek-chat") fail(`unexpected main key ${mainSlot?.definition.key}`);
if (listSlot?.definition.id !== "deepseek-chat" || listSlot?.definition.order !== 5) fail("panel list entry is wrong");
if (typeof listSlot?.definition.label() !== "string") fail("panel label is not a string");
ok(`panel ${listSlot.definition.id} order ${listSlot.definition.order} + main key ${mainSlot.definition.key}`);

const icon = mount(react.createElement(listSlot.component, { size: 16, active: true }));
if (icon?.tag !== "svg") fail("panel icon is not an svg");
else ok(`icon renders svg @ ${icon.getAttribute("width")}`);

// ── guest lifecycle helper ─────────────────────────────────────────────────
/** Mount the panel with a working lease bridge; returns the fixtures. */
async function mountPanel() {
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

  const page = mount(react.createElement(mainSlot.component, {}));
  const cleanups = flushEffects();
  resolveAcquire?.({ lease: "lease-1", partition: "persist:test" });
  await flushMicrotasks();
  return { page, cleanups, calls, webview: findWebview(page) };
}

// ── case 1: first visit, conversation memory, auth safety, cleanup ─────────
storage.clear();
{
  const { cleanups, calls, webview } = await mountPanel();
  if (!webview) fail("webview was not attached to the panel host");
  if (webview.getAttribute("name") !== "lease-1") fail(`webview name ${webview.getAttribute("name")}`);
  if (calls.acquire[0] !== "panel:deepseek-chat") fail(`unexpected partition key ${calls.acquire[0]}`);

  webview.dispatch("dom-ready");
  await flushMicrotasks();
  if (webview.loadURLCalls.at(-1) !== ROOT) fail(`first visit loaded ${webview.loadURLCalls.at(-1)}`);
  else ok(`first visit loads ${ROOT}`);

  webview.currentUrl = CONV_A;
  webview.dispatch("did-stop-loading");
  if (storage.get(STORAGE_KEY) !== CONV_A) fail(`conversation not remembered: ${storage.get(STORAGE_KEY)}`);
  else ok("conversation URL remembered on load");

  webview.currentUrl = CONV_B;
  webview.dispatch("did-navigate-in-page", { isMainFrame: true });
  if (storage.get(STORAGE_KEY) !== CONV_B) fail(`SPA navigation not remembered: ${storage.get(STORAGE_KEY)}`);
  else ok("SPA conversation change remembered");

  webview.currentUrl = AUTH;
  webview.dispatch("did-navigate");
  if (storage.get(STORAGE_KEY) !== CONV_B) fail(`auth page overwrote the memory: ${storage.get(STORAGE_KEY)}`);
  else ok("auth page leaves the conversation memory alone");

  webview.currentUrl = ROOT;
  webview.dispatch("did-navigate");
  if (storage.has(STORAGE_KEY)) fail("new-chat root did not clear the memory");
  else ok("new-chat root clears the memory");

  webview.currentUrl = CONV_A;
  for (const cleanup of cleanups) cleanup();
  await flushMicrotasks();
  if (calls.release.length !== 1 || calls.release[0] !== "lease-1") fail(`lease not released: ${JSON.stringify(calls.release)}`);
  else ok("lease released on unmount");
  if (!webview.removed) fail("webview element not removed on unmount");
  else ok("guest DOM removed on unmount");
  if (storage.get(STORAGE_KEY) !== CONV_A) fail("unmount did not remember the current conversation");
  else ok("unmount remembers the current conversation");
}

// ── case 2: later visits reopen the remembered conversation ────────────────
storage.clear();
storage.set(STORAGE_KEY, CONV_A);
{
  const { cleanups, webview } = await mountPanel();
  webview.dispatch("dom-ready");
  await flushMicrotasks();
  if (webview.loadURLCalls.at(-1) !== CONV_A) fail(`reopen loaded ${webview.loadURLCalls.at(-1)} instead of ${CONV_A}`);
  else ok(`reopen loads the remembered conversation (${CONV_A.slice(22)})`);
  for (const cleanup of cleanups) cleanup();
  await flushMicrotasks();
}

// ── case 3: a dead remembered conversation falls back to the root ──────────
storage.clear();
storage.set(STORAGE_KEY, CONV_A);
{
  const { cleanups, webview } = await mountPanel();
  webview.dispatch("dom-ready");
  await flushMicrotasks();
  webview.dispatch("did-fail-load", { isMainFrame: true, errorCode: -105, errorDescription: "NAME_NOT_RESOLVED" });
  await flushMicrotasks();
  if (webview.loadURLCalls.at(-1) !== ROOT) fail(`dead conversation fallback loaded ${webview.loadURLCalls.at(-1)}`);
  else ok("unreachable remembered conversation falls back to the root");
  for (const cleanup of cleanups) cleanup();
  await flushMicrotasks();
}

// ── case 4: invalid memory (auth page / foreign origin) starts clean ───────
for (const invalid of [AUTH, "https://example.com/chat", "not a url"]) {
  storage.clear();
  storage.set(STORAGE_KEY, invalid);
  const { cleanups, webview } = await mountPanel();
  webview.dispatch("dom-ready");
  await flushMicrotasks();
  if (webview.loadURLCalls.at(-1) !== ROOT) fail(`invalid memory "${invalid}" loaded ${webview.loadURLCalls.at(-1)}`);
  for (const cleanup of cleanups) cleanup();
  await flushMicrotasks();
}
ok("auth pages and foreign origins never get restored");

// ── case 5: teardown after the DOM was removed never throws ────────────────
// React runs effect cleanups after it has taken the panel DOM away, and Electron
// throws from getURL() on a detached webview. That uncaught error used to crash
// the whole application UI (DSH reports it as a crash of the root slot).
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
  if (threw !== void 0) fail(`teardown after DOM removal threw: ${threw.message}`);
  else ok("teardown after DOM removal does not throw");
  if (calls.release.length !== 1 || calls.release[0] !== "lease-1") fail(`lease not released after detach: ${JSON.stringify(calls.release)}`);
  else ok("detached teardown still releases the lease");
}

// ── case 6: a dead guest is contained inside the panel ─────────────────────
for (const event of ["render-process-gone", "destroyed"]) {
  storage.clear();
  const { cleanups, calls, webview } = await mountPanel();
  webview.dispatch("dom-ready");
  await flushMicrotasks();
  let threw;
  try {
    webview.dispatch(event, { reason: "crashed" });
  } catch (error) {
    threw = error;
  }
  if (threw !== void 0) fail(`guest "${event}" escaped the panel: ${threw.message}`);
  webview.remove();
  try {
    for (const cleanup of cleanups) cleanup();
  } catch (error) {
    fail(`cleanup after "${event}" threw: ${error.message}`);
  }
  await flushMicrotasks();
  if (calls.release.length !== 1) fail(`lease not released after "${event}"`);
}
ok("guest crash/destroy stays inside the panel and releases the lease");

// ── case 7: open/close churn never escapes an error ────────────────────────
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
    if (threw !== void 0) fail(`churn round ${round} threw: ${threw.message}`);
    if (calls.release.length !== 1) fail(`churn round ${round} did not release its lease`);
    await flushMicrotasks();
  }
}
ok("open/close churn creates and releases one guest per visit");

console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
