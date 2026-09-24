// mcpv local web UI — manage the vault without ever seeing a value.
//
// The API only returns environment addresses, key names and timestamps, and
// takes values write-only. This page keeps that promise on its side too: a
// value typed into a form goes straight into one request and the form is torn
// down with it. Framework-free and dependency-free so it can ship inlined in
// the single-file CLI; the DOM is built with textContent via h(), never
// innerHTML, since key names and .env contents are user data.

"use strict";

// ---------------------------------------------------------------------------
// Token: arrives once in the URL fragment (never sent to a server), kept in
// sessionStorage for this tab, then scrubbed from the address bar.
// ---------------------------------------------------------------------------

const TOKEN_KEY = "mcpv.token";

function readToken() {
  const match = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (match) {
    const value = decodeURIComponent(match[1]);
    try { sessionStorage.setItem(TOKEN_KEY, value); } catch { /* private mode */ }
    history.replaceState(null, "", location.pathname);
    return value;
  }
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}

let token = readToken();
let ended = false;

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    showEnded();
    throw new ApiError(0, "mcpv ui isn't running any more");
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401) {
    showEnded();
    throw new ApiError(401, "This session has ended");
  }
  if (!res.ok) throw new ApiError(res.status, data.error || "Something went wrong. Please try again.");
  return data;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "class") el.className = value;
    else if (key === "value") el.value = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const ICONS = {
  plus: "M12 5v14M5 12h14",
  upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
  refresh: "M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  edit: "M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4",
  power: "M12 3v9M6.4 6.4a8 8 0 1 0 11.2 0",
};

function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

function toast(message, kind = "ok") {
  const el = h("div", { class: `toast ${kind}`, role: "status" }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 3200);
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    toast("Couldn't copy — select the text and copy it manually", "fail");
  }
}

function ago(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  const units = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "";
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The one modal: focus trapped, Escape closes, the page behind is inert.
// No window.confirm/alert anywhere.
function openDialog(build, onClose) {
  const previous = document.activeElement;
  const overlay = h("div", { class: "overlay" });
  const dialog = h("div", { class: "dialog", role: "dialog", "aria-modal": "true" });
  overlay.append(dialog);
  const app = document.getElementById("app");
  const close = () => {
    overlay.remove();
    app.inert = false;
    document.removeEventListener("keydown", onKey);
    if (previous && previous.focus) previous.focus();
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Tab") {
      const items = [...dialog.querySelectorAll("button, input, textarea")].filter((n) => !n.disabled);
      if (items.length === 0) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);
  append(dialog, [build(close)]);
  document.body.append(overlay);
  app.inert = true;
  const focusTarget = dialog.querySelector("[autofocus]") || dialog.querySelector("input, textarea, button");
  if (focusTarget) focusTarget.focus();
  return close;
}

function confirmDialog({ title, description, confirmLabel }) {
  return new Promise((resolve) => {
    let answer = false;
    openDialog((close) => [
      h("h2", {}, title),
      h("p", { class: "desc" }, description),
      h("div", { class: "dialog-actions" },
        h("button", { class: "btn", onclick: close }, "Cancel"),
        h("button", { class: "btn btn-danger", autofocus: true, onclick: () => { answer = true; close(); } }, confirmLabel)),
    ], () => resolve(answer));
  });
}

// ---------------------------------------------------------------------------
// Validation mirrors the CLI's address grammar, for inline messages only —
// the server is still the authority.
// ---------------------------------------------------------------------------

const ENV_RE = /^mcpm:\/\/[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*\/?$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkEnvironment(value) {
  if (!value) return "Enter an environment address";
  if (!ENV_RE.test(value)) return "Use mcpm://<workspace>/<project>/<environment> — lowercase letters, digits, - or _";
  return null;
}

function field(label, input, hint) {
  const error = h("div", { class: "field-error", role: "alert", hidden: true });
  const wrap = h("div", { class: "field" }, h("label", { for: input.id }, label), input, hint && h("div", { class: "hint" }, hint), error);
  return { wrap, setError(message) { error.textContent = message || ""; error.hidden = !message; } };
}

let data = { state: null, check: null };

function environmentList() {
  const list = h("datalist", { id: "env-list" });
  for (const env of data.state?.environments ?? []) list.append(h("option", { value: env.address }));
  return list;
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function secretDialog({ environment = "", key = "", replacing = false } = {}) {
  openDialog((close) => {
    const envInput = h("input", { id: "f-env", class: "mono", value: environment, placeholder: "mcpm://acme/api/dev", list: "env-list", autocomplete: "off", spellcheck: "false", readonly: replacing || undefined });
    const keyInput = h("input", { id: "f-key", class: "mono", value: key, placeholder: "STRIPE_KEY", autocomplete: "off", spellcheck: "false", readonly: replacing || undefined });
    const valueInput = h("input", { id: "f-value", type: "password", autocomplete: "off", spellcheck: "false", autofocus: replacing || Boolean(environment && key) || undefined });
    const envField = field("Environment", envInput);
    const keyField = field("Key", keyInput);
    const valueField = field(replacing ? "New value" : "Value", valueInput, "Stored encrypted on this machine. It's never shown again, here or anywhere else. To change it, replace it.");
    const submit = h("button", { class: "btn btn-primary", type: "submit" }, replacing ? "Replace" : "Save");

    const form = h("form", {
      onsubmit: async (e) => {
        e.preventDefault();
        const env = envInput.value.trim().replace(/\/$/, "");
        const name = keyInput.value.trim();
        const envError = checkEnvironment(env);
        const keyError = !name ? "Enter a key name" : KEY_RE.test(name) ? null : "Letters, digits and _ only, not starting with a digit";
        const valueError = valueInput.value === "" ? "Enter a value" : null;
        envField.setError(envError);
        keyField.setError(keyError);
        valueField.setError(valueError);
        if (envError || keyError || valueError) return;
        submit.disabled = true;
        try {
          const result = await api("POST", "/api/secrets", { address: `${env}/${name}`, value: valueInput.value });
          valueInput.value = "";
          close();
          toast(result.created ? `Stored ${name}` : `Replaced ${name}`);
          await refresh();
        } catch (error) {
          valueField.setError(error.message);
          submit.disabled = false;
        }
      },
    },
      h("h2", {}, replacing ? `Replace ${key}` : "Add a secret"),
      h("p", { class: "desc" }, replacing
        ? "The old value is overwritten. Anything that references this address picks up the new one on its next run."
        : "Your .env then holds its address instead of the value, and mcpv run injects it."),
      environmentList(),
      h("div", { class: "field-row" }, envField.wrap, keyField.wrap),
      valueField.wrap,
      h("div", { class: "dialog-actions" }, h("button", { type: "button", class: "btn", onclick: close }, "Cancel"), submit));
    return form;
  });
}

function importDialog() {
  openDialog((close) => {
    const envInput = h("input", { id: "i-env", class: "mono", placeholder: "mcpm://acme/api/dev", list: "env-list", autocomplete: "off", spellcheck: "false" });
    const textInput = h("textarea", { id: "i-text", spellcheck: "false", placeholder: "DATABASE_URL=postgres://…\nSTRIPE_KEY=sk_live_…" });
    const onlyInput = h("input", { id: "i-only", class: "mono", placeholder: "DATABASE_URL, STRIPE_KEY", autocomplete: "off", spellcheck: "false" });
    const envField = field("Into environment", envInput);
    const textField = field(".env contents", textInput, "Paste the file. Empty values and existing mcpm:// references are skipped.");
    const onlyField = field("Only these keys (optional)", onlyInput, "Leave empty to import every plain value. Keep settings like PORT out if they aren't secret.");
    const submit = h("button", { class: "btn btn-primary", type: "submit" }, "Import");

    return h("form", {
      onsubmit: async (e) => {
        e.preventDefault();
        const env = envInput.value.trim().replace(/\/$/, "");
        const envError = checkEnvironment(env);
        envField.setError(envError);
        textField.setError(textInput.value.trim() ? null : "Paste the contents of a .env file");
        if (envError || !textInput.value.trim()) return;
        const only = onlyInput.value.split(",").map((k) => k.trim()).filter(Boolean);
        submit.disabled = true;
        try {
          const result = await api("POST", "/api/import", { environment: env, text: textInput.value, ...(only.length ? { only } : {}) });
          textInput.value = "";
          close();
          toast(`Imported ${plural(result.keys.length, "secret")} into ${env}`);
          await refresh();
        } catch (error) {
          textField.setError(error.message);
          submit.disabled = false;
        }
      },
    },
      h("h2", {}, "Import a .env"),
      h("p", { class: "desc" }, "Values are encrypted into the vault. No file on disk is changed. To swap a .env's values for references, run ",
        h("code", {}, "mcpv import .env --into <env> --rewrite"), " in your terminal."),
      environmentList(),
      envField.wrap, textField.wrap, onlyField.wrap,
      h("div", { class: "dialog-actions" }, h("button", { type: "button", class: "btn", onclick: close }, "Cancel"), submit));
  });
}

async function removeSecret(address, name) {
  const ok = await confirmDialog({
    title: `Delete ${name}?`,
    description: `${address} will stop resolving, so anything that references it fails on its next run. This can't be undone.`,
    confirmLabel: "Delete",
  });
  if (!ok) return;
  try {
    await api("POST", "/api/secrets/delete", { address });
    toast(`Deleted ${name}`);
    await refresh();
  } catch (error) {
    toast(error.message, "fail");
  }
}

async function shutdown() {
  try { await api("POST", "/api/shutdown", {}); } catch { /* already gone */ }
  showEnded();
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const STORE_LABEL = { keychain: "Key in macOS Keychain", "secret-service": "Key in system keyring", file: "Key in a local file" };

function topbar() {
  return h("header", { class: "topbar" },
    h("div", { class: "brand" }, h("img", { src: "/logo.svg", alt: "" }), "mcpv"),
    h("span", { class: "note mono vault-path" }, data.state?.home ?? ""),
    h("span", { class: "spacer" }),
    h("button", { class: "btn btn-sm btn-ghost", onclick: () => refresh(true), "aria-label": "Refresh" }, icon("refresh")),
    h("button", { class: "btn btn-sm", onclick: shutdown }, icon("power"), "Close"));
}

function projectCard(check) {
  if (!check?.file) return null;
  const missing = check.references.filter((r) => !r.found);
  return h("section", { class: "card" },
    h("div", { class: "card-head" },
      h("h2", {}, "This project's .env"),
      check.error ? h("span", { class: "badge fail" }, "Can't read it")
        : check.references.length === 0 ? h("span", { class: "badge" }, "No references")
        : missing.length ? h("span", { class: "badge fail" }, `${missing.length} missing`)
        : h("span", { class: "badge ok" }, "All resolve")),
    h("p", { class: "sub mono" }, check.file),
    check.error ? h("p", { class: "field-error" }, check.error)
      : check.references.length === 0 ? h("p", { class: "note" }, "It has no mcpm:// references yet. Import it to move its values into the vault.")
      : h("ul", { class: "rows" }, check.references.map((ref) => {
        const [env] = splitAddress(ref.address);
        const name = ref.address.slice(env.length + 1);
        return h("li", { class: "row" },
          h("span", { class: `status-dot ${ref.found ? "ok" : "fail"}`, "aria-label": ref.found ? "Resolves" : "Missing" }),
          h("div", { class: "grow" }, h("span", { class: "name" }, ref.key), h("span", { class: "when mono" }, ref.address)),
          ref.found ? null : h("div", { class: "row-actions" },
            h("button", { class: "btn btn-sm btn-primary", onclick: () => secretDialog({ environment: env, key: name }) }, "Set value")));
      })));
}

function splitAddress(address) {
  const i = address.lastIndexOf("/");
  return [address.slice(0, i), address.slice(i + 1)];
}

function environmentCard(env) {
  return h("section", { class: "card" },
    h("div", { class: "card-head" },
      h("span", { class: "address" }, env.address),
      h("span", { class: "badge" }, plural(env.keys.length, "key")),
      h("span", { class: "spacer" }),
      h("button", { class: "btn btn-sm btn-ghost", onclick: () => copy(env.address, "Copied the environment address") }, icon("copy"), "Copy"),
      h("button", { class: "btn btn-sm", onclick: () => secretDialog({ environment: env.address }) }, icon("plus"), "Add")),
    h("ul", { class: "rows" }, env.keys.map((key) => {
      const address = `${env.address}/${key.name}`;
      return h("li", { class: "row" },
        h("div", { class: "grow" },
          h("span", { class: "name" }, key.name),
          h("span", { class: "when" }, key.updatedAt ? `Updated ${ago(key.updatedAt)}` : "")),
        h("span", { class: "masked", "aria-label": "Value hidden" }, "••••••••"),
        h("div", { class: "row-actions" },
          h("button", { class: "btn btn-sm btn-ghost", title: "Copy a .env line that references it", onclick: () => copy(`${key.name}=${address}`, `Copied ${key.name}=… reference`) }, icon("copy"), "Reference"),
          h("button", { class: "btn btn-sm btn-ghost icon-btn", "aria-label": `Replace ${key.name}`, title: "Replace value", onclick: () => secretDialog({ environment: env.address, key: key.name, replacing: true }) }, icon("edit")),
          h("button", { class: "btn btn-sm btn-ghost icon-btn", "aria-label": `Delete ${key.name}`, title: "Delete", onclick: () => removeSecret(address, key.name) }, icon("trash"))));
    })));
}

function render() {
  const app = document.getElementById("app");
  const { state, check } = data;
  const count = state.environments.reduce((n, env) => n + env.keys.length, 0);
  const actions = h("div", { class: "actions" },
    h("button", { class: "btn", onclick: importDialog }, icon("upload"), "Import .env"),
    h("button", { class: "btn btn-primary", onclick: () => secretDialog() }, icon("plus"), "Add secret"));

  app.replaceChildren(
    topbar(),
    h("main", {},
      h("div", { class: "page-head" },
        h("div", { class: "grow" },
          h("h1", {}, "Secrets"),
          h("p", {}, "Encrypted on this machine. Values are never shown here. Agents use them through ", h("code", {}, "mcpv run"), ".")),
        count ? actions : null),
      state.keyStore ? h("div", { class: "meta" },
        h("span", { class: `badge ${state.keyStore === "file" ? "warn" : "ok"}` }, STORE_LABEL[state.keyStore] ?? state.keyStore),
        h("span", { class: "badge" }, `${plural(state.environments.length, "environment")} · ${plural(count, "secret")}`)) : null,
      projectCard(check),
      count === 0
        ? h("section", { class: "card empty" },
          h("b", {}, "No secrets yet"),
          h("p", {}, "Add one, or import an existing .env. Then point your .env at mcpm:// addresses and start your app with mcpv run."),
          h("div", { class: "actions" }, h("button", { class: "btn", onclick: importDialog }, icon("upload"), "Import .env"),
            h("button", { class: "btn btn-primary", onclick: () => secretDialog() }, icon("plus"), "Add secret")))
        : state.environments.map(environmentCard)));
}

function showEnded() {
  if (ended) return;
  ended = true;
  token = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  document.querySelectorAll(".overlay").forEach((el) => el.remove());
  const app = document.getElementById("app");
  app.inert = false;
  app.replaceChildren(h("div", { class: "ended" },
    h("b", {}, "mcpv ui has stopped"),
    h("span", {}, "Nothing is running in the background. To open it again, run ", h("code", {}, "mcpv ui"), " in your terminal.")));
}

async function refresh(announce = false) {
  const [state, check] = await Promise.all([api("GET", "/api/state"), api("GET", "/api/check")]);
  data = { state, check };
  render();
  if (announce) toast("Up to date");
}

if (!token) showEnded();
else refresh().catch((error) => {
  if (ended) return;
  document.getElementById("app").replaceChildren(h("div", { class: "ended" },
    h("b", {}, "Couldn't open your vault"), h("span", {}, error.message), h("span", {}, "Run ", h("code", {}, "mcpv doctor"), " in your terminal for details.")));
});
