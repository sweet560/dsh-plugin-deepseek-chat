// Offline validation for dsh-plugin-deepseek-chat's client bundle (v1.1.0).
//
// The bundle is a browser ModuleLoader script, so this harness:
//   1. runs it in a vm with a captured __ModuleLoader__.load call;
//   2. materializes the factory with stubbed react, DOM and localStorage;
//   3. exercises apply() on the web surface (inert) and the desktop surface;
//   4. drives the account sync store, then mini-renders the panel and exercises
//      the webview lease + conversation memory + crash containment.
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

/** Locate the account strip's text inside the panel root. */
function findAccountText(page) {
  const bar = page?.children.find((child) => child?.tag === "div" && child.style.flex === "none");
  const texts = [];
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") { texts.push(node); return; }
    if (node.text !== undefined) { texts.push(node.text); return; }
    for (const child of node.children ?? []) walk(child);
  };
  walk(bar);
  return texts.join(" ");
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
  URL,
  Date
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

const api = moduleExports.__test__;
if (api === undefined) {
  fail("exports.__test__ missing");
  process.exit(1);
}

// ── registration ───────────────────────────────────────────────────────────
const captured = { slots: [] };
const makeCtx = (remote) => ({
  slots: {
    inject: (name, factory) => factory(),
    register: (definition, component) => {
      captured.slots.push({ definition, component });
      return () => {};
    }
  },
  get: (name) => (name === "remote" ? remote : undefined),
  remote,
  effect: () => () => {},
  on: () => () => {}
});

moduleExports.apply(makeCtx(undefined));
if (captured.slots.length !== 0) fail("plugin registered on the web surface");
else ok("inert without the desktop bridge");

const remoteAccount = {
  account: {
    getState: async () => ({ ok: true, value: { status: "credential-stored" } }),
    getProfile: async () => ({ ok: true, value: { status: "ready", value: { id: "u-1", name: "Test User", contact: "test@example.com" } } })
  }
};
sandbox.globalThis.dshDesktop = { protocolVersion: 1, browser: {} };
moduleExports.apply(makeCtx(remoteAccount));
await flushMicrotasks();
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

// ── account sync store (v1.1.1) ────────────────────────────────────────────
{
  api.resetAccountSync();
  // Regression: the desktop shell caches ONE session per acquire() workspace
  // string. Any change to that string is a brand-new cookie jar and forces a
  // fresh QR login, so both identities must be absolute constants.
  if (api.partitionKeyFor() !== "panel:deepseek-chat") fail("partition key is not the constant legacy workspace");
  if (api.storageKeyFor() !== STORAGE_KEY) fail("storage key is not the constant legacy key");
  if (api.partitionKeyFor(api.ACCOUNT_SIGNED_IN, "whatever") !== "panel:deepseek-chat") fail("partition key varies with account state");
  if (api.storageKeyFor(api.ACCOUNT_SIGNED_OUT, "whatever") !== STORAGE_KEY) fail("storage key varies with account state");
  ok("guest partition and conversation key are state-independent constants");

  // Generated Remotes answer with an {ok,value} envelope; the probe must read
  // through BOTH envelope layers (getState -> AccountView, getProfile -> outcome).
  const probe = await api.probeAccount(makeCtx(remoteAccount));
  if (probe.status !== api.ACCOUNT_SIGNED_IN) fail(`envelope probe did not detect sign-in: ${probe.status}`);
  if (probe.label !== "Test User") fail(`envelope probe lost the profile name: ${probe.label}`);
  else ok("probe reads the generated Remote envelope and profile layers");
  const refused = await api.probeAccount(makeCtx({ account: { getState: async () => ({ ok: false, error: "denied" }), getProfile: async () => ({ ok: false }) } }));
  if (refused.status !== api.ACCOUNT_UNKNOWN) fail("a refused Remote was treated as sign-in");
  else ok("a refused account Remote degrades to unknown");

  // Status is display-only: no epoch, no identity, no guest lifecycle impact.
  api.publishAccount(api.ACCOUNT_SIGNED_IN);
  api.publishAccountLabel("Test User");
  if (!api.getSnapshot().probed) fail("first probe did not mark the store probed");
  api.publishAccount(api.ACCOUNT_UNKNOWN);
  if (api.getSnapshot().status !== api.ACCOUNT_SIGNED_IN) fail("a transient unknown overwrote the known sign-in state");
  if (api.getSnapshot().label !== "Test User") fail("a transient unknown cleared the display name");
  api.publishAccount(api.ACCOUNT_SIGNED_IN);
  api.publishAccount(api.ACCOUNT_SIGNED_OUT);
  if (api.getSnapshot().status !== api.ACCOUNT_SIGNED_OUT || api.getSnapshot().label !== "") fail("a confirmed sign-out was not published");
  ok("state changes never drive an epoch; transient unknown is ignored");

  const label = api.accountCopy({ status: api.ACCOUNT_SIGNED_IN, label: "Test User", probed: true });
  if (!label.text.includes("Test User")) fail("account strip does not show the signed-in profile");
  else ok("account strip shows the synced profile name");
  if (!api.accountCopy({ status: api.ACCOUNT_SIGNED_OUT, label: "", probed: true }).text.includes("未登录")) fail("signed-out strip copy is wrong");
  else ok("account strip shows the signed-out state");
}

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
  return { page, cleanups, calls, webview: findWebview(page), bridge };
}

// ── case 1: first visit, conversation memory, auth safety, cleanup ─────────
storage.clear();
api.resetAccountSync();
api.publishAccount(api.ACCOUNT_UNKNOWN);
{
  const { cleanups, calls, webview, page } = await mountPanel();
  if (!webview) fail("webview was not attached to the panel host");
  if (webview.getAttribute("name") !== "lease-1") fail(`webview name ${webview.getAttribute("name")}`);
  if (calls.acquire[0] !== "panel:deepseek-chat") fail(`unexpected partition key ${calls.acquire[0]}`);
  if (!findAccountText(page).includes("账号状态不可用")) fail("unknown account strip copy is missing");

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
for (const invalid of [AUTH, "https://example.com/chat", "not a url", "https://chat.deepseek.com:8443/a/chat/s/x"]) {
  storage.clear();
  storage.set(STORAGE_KEY, invalid);
  const { cleanups, webview } = await mountPanel();
  webview.dispatch("dom-ready");
  await flushMicrotasks();
  if (webview.loadURLCalls.at(-1) !== ROOT) fail(`invalid memory "${invalid}" loaded ${webview.loadURLCalls.at(-1)}`);
  for (const cleanup of cleanups) cleanup();
  await flushMicrotasks();
}
ok("auth pages, foreign origins and explicit ports never get restored");

// ── case 5: teardown after the DOM was removed never throws ────────────────
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
  const { cleanups, calls, webview, page } = await mountPanel();
  webview.dispatch("dom-ready");
  await flushMicrotasks();
  let threw;
  try {
    webview.dispatch(event, { reason: "crashed" });
  } catch (error) {
    threw = error;
  }
  if (threw !== void 0) fail(`guest "${event}" escaped the panel: ${threw.message}`);
  if (!webview.removed) fail(`dead guest not removed after "${event}" (Retry would stack webviews)`);
  if (findWebview(page) === webview) fail(`dead guest still mounted after "${event}"`);
  webview.remove();
  try {
    for (const cleanup of cleanups) cleanup();
  } catch (error) {
    fail(`cleanup after "${event}" threw: ${error.message}`);
  }
  await flushMicrotasks();
  if (calls.release.length !== 1) fail(`lease not released after "${event}"`);
}
ok("guest crash/destroy stays inside the panel, removes the dead guest, releases the lease");

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

// ── case 8: popup bridge only navigates to allowlisted hosts (v1.1.0) ──────
storage.clear();
{
  const { cleanups, calls, webview } = await mountPanel();
  webview.dispatch("dom-ready");
  await flushMicrotasks();
  const callback = calls.openRequested[0]?.callback;
  if (typeof callback !== "function") fail("popup callback not registered");
  else {
    const before = webview.loadURLCalls.length;
    callback("https://evil.example.com/steal");
    callback("http://chat.deepseek.com/");
    callback("https://chat.deepseek.com:8443/a/chat/s/x");
    callback("not a url");
    if (webview.loadURLCalls.length !== before) fail("a rejected popup URL was loaded into the guest");
    else ok("popup bridge rejects foreign origins, plain HTTP and explicit ports");
    callback(PLATFORM_POPUP);
    callback(CONV_B);
    if (webview.loadURLCalls.at(-2) !== PLATFORM_POPUP || webview.loadURLCalls.at(-1) !== CONV_B) fail("allowlisted popup URLs were not loaded");
    else ok("popup bridge admits chat.deepseek.com and platform.deepseek.com");
  }
  for (const cleanup of cleanups) cleanup();
  await flushMicrotasks();
}

// ── case 9: the guest starts immediately, without waiting for an account probe
storage.clear();
api.resetAccountSync();
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
  if (calls.acquire.length !== 1) fail("panel waited for the account probe before acquiring a lease");
  else if (calls.acquire[0] !== "panel:deepseek-chat") fail(`first lease used ${calls.acquire[0]}`);
  else ok("guest starts immediately with the constant partition");
  if (!findAccountText(page).includes("正在同步")) fail("probing account strip copy is missing");
  for (const cleanup of cleanups) cleanup();
  await flushMicrotasks();
}

// ── case 10: account state changes NEVER rebuild the guest ──────────────────
storage.clear();
api.resetAccountSync();
api.publishAccount(api.ACCOUNT_SIGNED_IN);
api.publishAccountLabel("Test User");
{
  const { cleanups, calls, webview, page } = await mountPanel();
  if (!webview) fail("signed-in panel did not mount a guest");
  if (calls.acquire[0] !== "panel:deepseek-chat") fail(`signed-in partition key ${calls.acquire[0]}`);
  else ok("signed-in guest uses the SAME partition as before sign-in");
  if (!findAccountText(page).includes("已与 DSH 登录账号同步")) fail("signed-in account strip copy is missing");
  else ok("signed-in account strip is shown");
  webview.dispatch("dom-ready");
  await flushMicrotasks();
  webview.currentUrl = CONV_A;
  webview.dispatch("did-stop-loading");
  if (storage.get(STORAGE_KEY) !== CONV_A) fail("conversation was not stored under the constant key");
  else ok("conversation uses the constant storage key");
  api.publishAccount(api.ACCOUNT_UNKNOWN);
  api.publishAccount(api.ACCOUNT_SIGNED_IN);
  api.publishAccount(api.ACCOUNT_SIGNED_OUT);
  api.publishAccount(api.ACCOUNT_SIGNED_IN);
  if (calls.acquire.length !== 1 || calls.release.length !== 0) fail(`account status churn rebuilt the guest: acquire=${JSON.stringify(calls.acquire)} release=${JSON.stringify(calls.release)}`);
  else ok("account status / reconnect churn never rebuilds the guest");
  for (const cleanup of cleanups) cleanup();
  await flushMicrotasks();
}

// ── case 11: switching away and back reuses the same workspace partition ────
{
  const first = await mountPanel();
  for (const cleanup of first.cleanups) cleanup();
  await flushMicrotasks();
  const second = await mountPanel();
  if (second.calls.acquire[0] !== first.calls.acquire[0]) fail("reopening the panel changed the guest partition");
  else ok("switching away and back reuses the SAME partition (login preserved)");
  for (const cleanup of second.cleanups) cleanup();
  await flushMicrotasks();
}

// ── case 12: sign-out only updates the strip, never the guest ───────────────
storage.clear();
api.resetAccountSync();
{
  const { cleanups, calls, webview } = await mountPanel();
  api.publishAccount(api.ACCOUNT_SIGNED_OUT);
  if (calls.acquire.length !== 1 || calls.release.length !== 0) fail("sign-out rebuilt the guest");
  else ok("sign-out leaves the guest and its cookies untouched");
  // The fake React harness does not re-render on setState; assert the store
  // and the copy function directly instead of the mounted DOM text.
  if (api.getSnapshot().status !== api.ACCOUNT_SIGNED_OUT) fail("sign-out state was not published");
  else if (!api.accountCopy(api.getSnapshot()).text.includes("未登录")) fail("signed-out strip copy is wrong");
  else ok("signed-out account strip is shown");
  for (const cleanup of cleanups) cleanup();
  await flushMicrotasks();
}

console.log(failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
