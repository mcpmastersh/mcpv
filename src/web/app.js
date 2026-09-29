// mcpv local web UI — manage the vault without ever seeing a value.
//
// The API only returns environment addresses, key names and timestamps, and
// takes values write-only. This page keeps that promise on its side too: a
// value typed into a form goes straight into one request and the form is torn
// down with it. Framework-free and dependency-free so it can ship inlined in
// the single-file CLI; the DOM is built with textContent via h(), never
// innerHTML, since key names and .env contents are user data.
//
// Address handling is deliberately *not* implemented here. `mcpm://` has one
// grammar and one repair (src/address-input.ts), shared with the CLI, so this
// page asks the server what a half-typed address means (`/api/address/preview`)
// and renders the answer. A second copy of the rules in this file is exactly
// how the two surfaces would end up disagreeing about where a secret lives.

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
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5zM14 3v5h5",
  left: "M15 18l-6-6 6-6",
  right: "M9 6l6 6-6 6",
  check: "M4 12.5l5 5L20 7",
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
  if (!iso) return "";
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
const bytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

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
      const items = [...dialog.querySelectorAll("button, input, textarea, select")].filter((n) => !n.disabled);
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
  // Focus the first thing a person can actually see: the file input behind
  // "Choose file…" is in the DOM but never visible, and on a project-import
  // dialog most of the form starts hidden.
  const visible = [...dialog.querySelectorAll("input, textarea, select, button")].filter(
    (node) => !node.disabled && !node.closest("[hidden]"),
  );
  const focusTarget = dialog.querySelector("[autofocus]") || visible[0];
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

function field(label, input, hint) {
  const error = h("div", { class: "field-error", role: "alert", hidden: true });
  const wrap = h("div", { class: "field" }, h("label", { for: input.id }, label), input, hint && h("div", { class: "hint" }, hint), error);
  return { wrap, input, setError(message) { error.textContent = message || ""; error.hidden = !message; } };
}

let data = { state: null, check: null, page: null };

// ---------------------------------------------------------------------------
// The address builder
//
// Three boxes (plus a key box when a key is wanted), a live readout of the
// address they add up to, and one-click picks of what's already in the vault.
// Every question about the address — is it complete, what was repaired, what
// could go in this box — is answered by POST /api/address/preview, so this
// component never parses an address itself.
// ---------------------------------------------------------------------------

const PART_LABEL = { workspace: "Workspace", project: "Project", environment: "Environment", key: "Key" };
const PART_HINT = { workspace: "acme", project: "api", environment: "dev", key: "STRIPE_KEY" };

let builderCount = 0;

function addressBuilder({ initial = {}, needKey = false, readonly = false, autofocusFirst = true } = {}) {
  const id = `b${++builderCount}`;
  const parts = needKey ? ["workspace", "project", "environment", "key"] : ["workspace", "project", "environment"];
  const fields = {};
  for (const part of parts) fields[part] = initial[part] ?? "";

  const inputs = {};
  const lists = {};
  const chips = h("div", { class: "chips" });
  const readout = h("div", { class: "addr-readout" });
  const note = h("div", { class: "addr-note", hidden: true });
  const error = h("div", { class: "field-error", role: "alert", hidden: true });
  let preview = null;
  let seq = 0;
  let touched = false;

  // A div, not a form: this sits inside the dialog's own form, and a nested
  // form is not a thing HTML has. As a plain div its inputs still belong to
  // the dialog's form, so Enter in any of them submits the dialog — which is
  // what someone typing a key name and hitting Enter expects. A nested form
  // would have swallowed that keystroke and done nothing at all.
  const element = h("div", { class: "addr-builder" });

  function setNote(message) {
    note.textContent = message || "";
    note.hidden = !message;
  }

  function setError(message) {
    error.textContent = message || "";
    error.hidden = !message;
  }

  function value() {
    return { ...fields };
  }

  function sync() {
    for (const part of parts) if (inputs[part].value !== fields[part]) inputs[part].value = fields[part];
  }

  function paint() {
    const complete = preview ? preview.valid : false;
    readout.replaceChildren(
      h("span", { class: `addr-preview mono ${complete ? "ok" : ""}` }, preview ? preview.address : ""),
      complete ? h("span", { class: "badge ok" }, icon("check"), "Ready") : null,
    );
    if (preview) setError(preview.problem);
    if (!preview || preview.valid) setNote(null);
    else if (preview.note) setNote(preview.note);

    // Datalists: what exists in the vault for this box, given the boxes to its
    // left. They turn each field into a pick-list instead of a guess.
    const suggestions = (preview && preview.suggestions) || {};
    const options = {
      workspace: suggestions.workspaces,
      project: suggestions.projects,
      environment: suggestions.environmentNames,
      key: suggestions.keys,
    };
    for (const part of parts) {
      const list = lists[part];
      list.replaceChildren(...(options[part] || []).map((name) => h("option", { value: name })));
    }

    // Picks, in the order the decision is made: whole environments that exist
    // (choosing one finishes all three boxes at once), then — once the address
    // is settled — the key names already stored there, so a new reference
    // reuses the exact spelling the vault already has.
    const environments = complete ? [] : suggestions.environments || [];
    const keyNames = needKey && complete ? suggestions.keys || [] : [];
    const rows = [];
    if (!readonly && environments.length > 0) {
      rows.push(h("div", { class: "chip-row" },
        h("span", { class: "chip-label" }, "Use an existing one"),
        chipsOf(environments, (address) => {
          Object.assign(fields, draftFrom(address), { key: fields.key });
          sync();
          touched = true;
          void refresh();
        })));
    }
    if (!readonly && keyNames.length > 0) {
      rows.push(h("div", { class: "chip-row" },
        h("span", { class: "chip-label" }, "Key names already here"),
        chipsOf(keyNames, (name) => { fields.key = name; sync(); touched = true; void refresh(); })));
    }
    chips.replaceChildren(...rows);
  }

  function chipsOf(values, pick) {
    return h("div", { class: "chip-set" }, values.map((text) =>
      h("button", { type: "button", class: "chip mono", onclick: () => pick(text), title: text }, text)));
  }

  // Ask the server what the boxes currently mean.
  async function refresh(why) {
    const mine = ++seq;
    let result;
    try {
      result = await api("POST", "/api/address/preview", { fields: value(), needKey });
    } catch (err) {
      if (err.message) setError(err.message);
      return null;
    }
    if (mine !== seq || !element.isConnected) return null;
    preview = result;
    paint();
    if (why === "blur") {
      // Repair what was typed — "Acme API" becomes acme-api — but only once the
      // box is left, so nothing shifts under the cursor mid-word.
      const repairs = [];
      for (const part of parts) {
        const wanted = result.parts[part];
        if (wanted === undefined || wanted === fields[part]) continue;
        repairs.push(`“${fields[part]}” → ${wanted}`);
        fields[part] = wanted;
      }
      if (repairs.length > 0) {
        sync();
        setNote(`${repairs.join(" · ")} — lowercase letters, digits and dashes`);
      }
    }
    if (why === "paste") {
      // A whole address pasted into one box belongs in all of them: the box it
      // landed in takes its own piece, the boxes before it keep what they had.
      const next = {};
      for (const part of parts) next[part] = result.parts[part] ?? fields[part];
      Object.assign(fields, next);
      sync();
      void refresh();
    }
    return result;
  }

  const scheduleRefresh = debounce(() => void refresh(), 120);

  for (const part of parts) {
    const list = h("datalist", { id: `${id}-${part}` });
    lists[part] = list;
    const input = h("input", {
      id: `${id}-${part}`,
      class: "mono",
      value: fields[part],
      placeholder: PART_HINT[part],
      list: list.id,
      autocomplete: "off",
      spellcheck: "false",
      readonly: readonly || undefined,
      autofocus: autofocusFirst && part === parts[0] && !readonly ? true : undefined,
      "aria-label": PART_LABEL[part],
    });
    inputs[part] = input;
    if (!readonly) {
      input.addEventListener("input", () => {
        fields[part] = input.value;
        touched = true;
        setError(null);
        // Slashes mean a whole address landed in one box — split it straight
        // away rather than making the person cut it up themselves.
        if (input.value.includes("/")) void refresh("paste");
        else scheduleRefresh();
      });
      input.addEventListener("blur", () => void refresh("blur"));
    }
  }

  const boxes = h("div", { class: "addr-fields" },
    parts.filter((part) => part !== "key").map((part) =>
      h("div", { class: "field" }, h("label", { for: inputs[part].id }, PART_LABEL[part]), inputs[part], lists[part])));
  element.append(boxes);

  if (needKey) {
    element.append(h("div", { class: "field" }, h("label", { for: inputs.key.id }, "Key name"), inputs.key, lists.key));
  }
  element.append(readout, note, chips, error);

  // Ask once up front: a form that opens with boxes already filled — or empty
  // and waiting — should show what the address is, and what the vault already
  // has, rather than staying blank until the first keystroke. The answer
  // arrives after the dialog is in the document, which is what `refresh`
  // requires before it paints.
  void refresh();

  return {
    element,
    value,
    /** The address as the server last saw it, and whether it's usable. */
    state: () => preview,
    isValid: () => Boolean(preview && preview.valid),
    /** True once a person has typed in it — prefills must not overwrite that. */
    isTouched: () => touched,
    /** Fills boxes that are still empty; used to seed an environment from a .env. */
    fill(seed) {
      for (const [part, wanted] of Object.entries(seed)) {
        if (inputs[part] && fields[part].trim() === "") fields[part] = wanted;
      }
      sync();
      void refresh();
    },
    setError,
    refresh: () => refresh(),
  };
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function secretDialog({ draft = {}, key = "", replacing = false } = {}) {
  openDialog((close) => {
    const builder = addressBuilder({ initial: { ...draft, ...(key ? { key } : {}) }, needKey: true, readonly: replacing, autofocusFirst: !key });
    const valueInput = h("input", { id: "f-value", type: "password", autocomplete: "off", spellcheck: "false", autofocus: Boolean(key) || undefined });
    const valueField = field(replacing ? "New value" : "Value", valueInput, "Stored encrypted on this machine. It's never shown again, here or anywhere else. To change it, replace it.");
    const submit = h("button", { class: "btn btn-primary", type: "submit" }, replacing ? "Replace" : "Save");

    return h("form", {
      onsubmit: async (e) => {
        e.preventDefault();
        if (valueInput.value === "") return valueField.setError("Enter a value");
        // Ask what the boxes mean *now* rather than trusting whatever the last
        // debounced keystroke answered — a form submitted the instant it's
        // filled would otherwise be judged by a preview that hasn't landed yet.
        await builder.refresh();
        if (!builder.isValid()) return builder.setError("Finish the address first — the boxes above say what's missing");
        submit.disabled = true;
        try {
          const result = await api("POST", "/api/secrets", { fields: builder.value(), value: valueInput.value });
          valueInput.value = "";
          close();
          toast(result.created ? `Stored ${result.address.split("/").pop()}` : `Replaced ${result.address.split("/").pop()}`);
          reload();
        } catch (error) {
          builder.setError(error.message);
          submit.disabled = false;
        }
      },
    },
      h("h2", {}, replacing ? `Replace ${key}` : "Add a secret"),
      h("p", { class: "desc" }, replacing
        ? "The old value is overwritten. Anything that references this address picks up the new one on its next run."
        : "Your .env then holds its address instead of the value, and mcpv run injects it."),
      builder.element,
      valueField.wrap,
      h("div", { class: "dialog-actions" }, h("button", { type: "button", class: "btn", onclick: close }, "Cancel"), submit));
  });
}

function importDialog() {
  openDialog((close) => {
    const projectFile = data.check?.file ?? null;
    const builder = addressBuilder({ initial: {}, needKey: false, autofocusFirst: false });
    // Two ways in, because they are different in an important way: this
    // folder's .env is read by mcpv itself, so no value ever crosses the
    // socket, while a chosen file is read by the browser and posted.
    const source = h("div", { class: "source" });
    // A real, visible file input — not the usual hidden input plus a styled
    // button that calls .click() on it. That pattern needs the browser to open
    // a dialog for a control it was told not to render, which some refused,
    // and it needs an `accept` filter to be satisfied, which `.env` can't do:
    // a dotfile has no MIME type and `.env.production` matches no extension
    // token, so the dialog showed the file a person needed greyed out and
    // unselectable. There is no filter now, and the control is one they click
    // themselves. What comes in is parsed and validated by the server, which
    // is where a wrong file gets caught.
    const picker = h("input", { type: "file", id: "i-file", class: "file-input", multiple: false, "aria-label": "Choose a .env file" });
    const textInput = h("textarea", { id: "i-text", spellcheck: "false", placeholder: "DATABASE_URL=postgres://…\nSTRIPE_KEY=sk_live_…" });
    const onlyInput = h("input", { id: "i-only", class: "mono", placeholder: "DATABASE_URL, STRIPE_KEY", autocomplete: "off", spellcheck: "false" });
    const planLine = h("div", { class: "plan-line" });
    const textField = field(".env contents", textInput);
    const onlyField = field("Only these keys (optional)", onlyInput, "Leave empty to import every plain value. Keep things like PORT out if they aren't secret.");
    const submit = h("button", { class: "btn btn-primary", type: "submit" }, "Import");
    let mode = projectFile ? "project" : "text";
    let seeded = false;

    const choice = (value, label, hint) =>
      h("label", { class: `source-option ${mode === value ? "active" : ""}` },
        h("input", { type: "radio", name: "import-source", value, checked: mode === value, onchange: () => setMode(value) }),
        h("span", {}, h("b", {}, label), hint && h("span", { class: "note" }, ` ${hint}`)));

    function setMode(value) {
      mode = value;
      renderSource();
      void plan();
    }

    function renderSource() {
      const projectOption = projectFile
        ? choice("project", "./.env in this folder", "read by mcpv — values stay on this machine")
        : null;
      const textOption = choice("text", projectFile ? "A file or pasted text" : "Choose a file or paste text",
        "read by your browser, then sent to the local mcpv process");
      source.replaceChildren(...[projectOption, textOption].filter(Boolean));
      // Both hidden with the `hidden` property, which is fine here because
      // nothing ever calls .click() on either of them.
      textField.wrap.hidden = mode !== "text";
      picker.hidden = mode !== "text";
    }

    // Reading the chosen file happens in the browser: the file input yields
    // contents and a name, never a path, so no route ever accepts "read this
    // path for me" — the request that would make this page worth attacking.
    // The contents land in the textarea, so what will be imported is what can
    // be read on screen before the button is pressed.
    async function loadFile(file) {
      if (!file) return;
      if (file.size > 900 * 1024) {
        textField.setError(`${file.name} is ${bytes(file.size)} — too large to send in one go (900 KB max). Delete what it doesn't need, or paste the keys you want.`);
        return;
      }
      textField.setError(null);
      try {
        textInput.value = await file.text();
        void plan();
      } catch {
        textField.setError(`Couldn't read ${file.name} — choose it again, or paste the contents below`);
      }
    }

    picker.addEventListener("change", () => void loadFile(picker.files && picker.files[0]));
    textInput.addEventListener("dragover", (e) => { e.preventDefault(); textInput.classList.add("dropping"); });
    textInput.addEventListener("dragleave", () => textInput.classList.remove("dropping"));
    textInput.addEventListener("drop", (e) => {
      e.preventDefault();
      textInput.classList.remove("dropping");
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) void loadFile(file);
    });

    // What this would do, before anything is stored. The answer names keys and
    // counts; the values in the request (for a pasted .env) are dropped unread,
    // and for this folder's .env they never leave the process at all.
    async function plan() {
      const body = mode === "project" ? { source: "project" } : { text: textInput.value };
      if (mode === "text" && textInput.value.trim() === "") {
        planLine.replaceChildren();
        return;
      }
      let result;
      try {
        result = await api("POST", "/api/import/preview", body);
      } catch (error) {
        planLine.replaceChildren(h("span", { class: "field-error" }, error.message));
        return;
      }
      if (!planLine.isConnected) return;
      if (result.error) {
        planLine.replaceChildren(h("span", { class: "field-error" }, result.error));
        return;
      }
      const bits = [h("span", { class: "badge ok" }, `${plural(result.plain.length, "plain value")} to store`)];
      if (result.references.length) bits.push(h("span", { class: "badge" }, `${plural(result.references.length, "reference")} already in the vault`));
      if (result.skipped.length) bits.push(h("span", { class: "badge" }, `${plural(result.skipped.length, "empty value")} skipped`));
      planLine.replaceChildren(...bits);
      // A .env that already holds references knows which environment it
      // belongs to: use what the file says instead of asking again.
      if (result.environment && !seeded && !builder.isTouched()) {
        seeded = true;
        builder.fill(draftFrom(result.environment));
      }
    }

    const debouncedPlan = debounce(() => void plan(), 350);
    textInput.addEventListener("input", debouncedPlan);

    renderSource();
    void plan();

    return h("form", {
      onsubmit: async (e) => {
        e.preventDefault();
        if (mode === "text" && textInput.value.trim() === "") return textField.setError("Choose a .env file, or paste its contents");
        await builder.refresh();
        if (!builder.isValid()) return builder.setError("Finish the address first — the boxes above say what's missing");
        const only = onlyInput.value.split(",").map((k) => k.trim()).filter(Boolean);
        submit.disabled = true;
        try {
          const result = await api("POST", "/api/import", {
            ...(mode === "project" ? { source: "project" } : { text: textInput.value }),
            fields: builder.value(),
            ...(only.length ? { only } : {}),
          });
          textInput.value = "";
          close();
          toast(`Imported ${plural(result.keys.length, "secret")} into ${result.environment}`);
          reload();
        } catch (error) {
          textField.setError(error.message);
          submit.disabled = false;
        }
      },
    },
      h("h2", {}, "Import a .env"),
      h("p", { class: "desc" }, "Values are encrypted into the vault; no file on disk is changed. To swap a .env's own values for references, run ",
        h("code", {}, "mcpv import .env --into <env> --rewrite"), " in your terminal."),
      source,
      h("div", { class: "file-row" }, picker, h("span", { class: "note" }, "or drop a file on the box below, or paste it")),
      textField.wrap,
      planLine,
      builder.element,
      onlyField.wrap,
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
    reload();
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

// The list's filters and page. Kept here rather than in the DOM so a refresh
// after adding a secret doesn't drop the person back to page 1 of everything.
const view = { search: "", workspace: "", project: "", environment: "", page: 1, pageSize: 25 };

function topbar() {
  return h("header", { class: "topbar" },
    h("div", { class: "brand" }, h("img", { src: "/logo.svg", alt: "" }), "mcpv"),
    h("nav", { class: "topnav", "aria-label": "On this page" },
      h("a", { href: "#commands" }, "Commands"),
      h("a", { href: "#project" }, ".env check"),
      h("a", { href: "#secrets" }, "Secrets")),
    h("span", { class: "spacer" }),
    h("span", { class: "note mono vault-path", title: "Where the vault lives" }, data.state?.home ?? ""),
    h("button", { class: "btn btn-sm btn-ghost", onclick: () => reload(true), "aria-label": "Refresh" }, icon("refresh")),
    h("button", { class: "btn btn-sm", onclick: shutdown }, icon("power"), "Close"));
}

function projectCard(check) {
  if (!check?.file) return null;
  const missing = check.references.filter((r) => !r.found);
  return h("section", { class: "card", id: "project" },
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
            h("button", { class: "btn btn-sm btn-primary", onclick: () => secretDialog({ draft: draftFrom(env), key: name }) }, "Set value")));
      })));
}

/** A whole environment as the .env text that references it: one KEY=address line per key. */
function envFile(env) {
  return env.keys.map((key) => `${key.name}=${env.address}/${key.name}`).join("\n") + "\n";
}

function splitAddress(address) {
  const i = address.lastIndexOf("/");
  return [address.slice(0, i), address.slice(i + 1)];
}

function draftFrom(path) {
  const read = path.replace(/^mcpm:\/\//, "").replace(/\/$/, "").split("/");
  return { workspace: read[0] ?? "", project: read[1] ?? "", environment: read[2] ?? "" };
}

/** Every environment in the vault, with counts — the strip above the list. */
function environmentStrip(environments) {
  if (environments.length === 0) return null;
  const shown = environments.slice(0, 8);
  return h("section", { class: "card strip" },
    h("div", { class: "card-head" },
      h("h2", {}, "Environments"),
      h("span", { class: "spacer" }),
      environments.length > shown.length ? h("span", { class: "note" }, `showing ${shown.length} of ${environments.length} — use the Environment filter for the rest`) : null),
    h("div", { class: "env-chips" }, shown.map((env) => {
      const draft = draftFrom(env.address);
      const active = view.workspace === draft.workspace && view.project === draft.project && view.environment === draft.environment;
      return h("div", { class: `env-chip ${active ? "active" : ""}` },
        h("button", {
          type: "button",
          class: "env-chip-main mono",
          title: `Filter the list to ${env.address}`,
          onclick: () => setFilters({ ...draft, page: 1 }),
        }, h("span", {}, env.address.replace(/^mcpm:\/\//, "")), h("span", { class: "count" }, String(env.keys.length))),
        // Labelled, not icon-only: a tooltip is invisible to anyone who isn't
        // hovering, and this is the button a whole project's setup starts from.
        h("button", { type: "button", class: "btn btn-sm btn-ghost chip-copy", "aria-label": `Copy the address ${env.address}`, onclick: () => copy(env.address, "Copied the environment address") }, icon("copy"), "Address"),
        h("button", {
          type: "button",
          class: "btn btn-sm chip-copy chip-copy-env",
          "aria-label": `Copy a .env file with all ${env.keys.length} keys in ${env.address}`,
          onclick: () => copy(envFile(env), `Copied ${plural(env.keys.length, "line")} for a .env file`),
        }, icon("file"), "Copy .env"),
        h("button", { type: "button", class: "btn btn-sm btn-ghost icon-btn", "aria-label": `Add a secret to ${env.address}`, title: "Add a secret here", onclick: () => secretDialog({ draft }) }, icon("plus")));
    })));
}

function selectOptions(values, allLabel) {
  return [h("option", { value: "" }, allLabel), ...values.map((value) => h("option", { value }, value))];
}

function toolbar(page, facets) {
  const search = h("input", {
    id: "q",
    type: "search",
    class: "search",
    value: view.search,
    placeholder: "Search key names and addresses",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": "Search secrets",
  });
  search.addEventListener("input", debounce(() => setFilters({ search: search.value }), 200));

  const picker = (name, label, values) => {
    const select = h("select", { class: "select", "aria-label": label, onchange: (e) => setFilters({ [name]: e.target.value }) }, selectOptions(values, label));
    select.value = view[name];
    return select;
  };

  // Options narrow with the boxes to their left, so a project list can't offer
  // something that doesn't exist under the chosen workspace.
  const projects = facets.rows.filter((row) => !view.workspace || row.workspace === view.workspace);
  const environments = projects.filter((row) => !view.project || row.project === view.project);
  const dirty = Boolean(view.search || view.workspace || view.project || view.environment);

  return h("div", { class: "toolbar" },
    h("div", { class: "toolbar-row" },
      h("div", { class: "search-wrap" }, icon("search"), search),
      picker("workspace", "All workspaces", facets.workspaces),
      picker("project", "All projects", [...new Set(projects.map((row) => row.project))]),
      picker("environment", "All environments", [...new Set(environments.map((row) => row.environment))]),
      dirty ? h("button", { class: "btn btn-sm btn-ghost", onclick: () => setFilters({ search: "", workspace: "", project: "", environment: "" }) }, "Clear") : null),
    h("div", { class: "toolbar-row pager-row" },
      h("span", { class: "note" }, page.total === 0
        ? "No secrets match"
        : `Showing ${page.from}–${page.to} of ${plural(page.total, "secret")}`),
      h("span", { class: "spacer" }),
      h("label", { class: "note per-page" }, "Per page",
        h("select", { class: "select", "aria-label": "Secrets per page", onchange: (e) => setFilters({ pageSize: Number(e.target.value), page: 1 }) },
          [25, 50, 100].map((size) => h("option", { value: String(size), selected: view.pageSize === size }, String(size))))),
      page.pages > 1 ? h("div", { class: "pager" },
        h("button", { class: "btn btn-sm icon-btn", "aria-label": "Previous page", disabled: page.page <= 1, onclick: () => goTo(page.page - 1) }, icon("left")),
        h("span", { class: "note" }, `Page ${page.page} of ${page.pages}`),
        h("button", { class: "btn btn-sm icon-btn", "aria-label": "Next page", disabled: page.page >= page.pages, onclick: () => goTo(page.page + 1) }, icon("right"))) : null));
}

function secretRow(row) {
  return h("li", { class: "row" },
    h("div", { class: "grow" },
      h("span", { class: "name" }, row.key),
      h("span", { class: "when mono" }, row.path)),
    h("span", { class: "when" }, row.updatedAt ? `Updated ${ago(row.updatedAt)}` : ""),
    h("span", { class: "masked", "aria-label": "Value hidden" }, "••••••••"),
    h("div", { class: "row-actions" },
      h("button", { class: "btn btn-sm btn-ghost", "aria-label": `Copy the address of ${row.key}`, onclick: () => copy(row.address, `Copied the address of ${row.key}`) }, icon("copy"), "Address"),
      h("button", { class: "btn btn-sm btn-ghost", "aria-label": `Copy the .env line for ${row.key}`, onclick: () => copy(`${row.key}=${row.address}`, `Copied ${row.key}=… line`) }, icon("copy"), ".env line"),
      h("button", { class: "btn btn-sm btn-ghost icon-btn", "aria-label": `Replace ${row.key}`, title: "Replace value", onclick: () => secretDialog({ draft: draftFrom(`mcpm://${row.path}`), key: row.key, replacing: true }) }, icon("edit")),
      h("button", { class: "btn btn-sm btn-ghost icon-btn", "aria-label": `Delete ${row.key}`, title: "Delete", onclick: () => removeSecret(row.address, row.key) }, icon("trash"))));
}

function facetsFrom(environments) {
  const rows = [];
  for (const env of environments) {
    const draft = draftFrom(env.address);
    if (draft.workspace && draft.project && draft.environment) rows.push(draft);
  }
  return { rows, workspaces: [...new Set(rows.map((row) => row.workspace))].sort() };
}

// ---------------------------------------------------------------------------
// First-run guide
//
// A person who opens an empty vault has no idea what a secret "address" is for
// or what should happen next, and a tool that needs an explanation before it
// does anything is one people quit. So the empty state is a numbered path with
// a sample to try, and each step says what they should SEE when it worked.
// ---------------------------------------------------------------------------

const SAMPLE = { draft: { workspace: "demo", project: "hello", environment: "dev" }, key: "GREETING" };
const SAMPLE_LINE = "GREETING=mcpm://demo/hello/dev/GREETING";
const SAMPLE_RUN = `mcpv run -- node -e "console.log('GREETING is', process.env.GREETING)"`;
const AGENT_LINE = "Secrets are in mcpv. .env holds mcpm:// references, not values. Start anything that needs them with `mcpv run -- <command>`. Never ask me for a secret value; `mcpv check` shows what's missing.";

/** A command you copy, with the button labelled: a bare icon gets missed. */
function commandBlock(text) {
  return h("div", { class: "cmd" },
    h("code", {}, text),
    h("button", { type: "button", class: "btn btn-sm cmd-copy", "aria-label": `Copy: ${text}`, onclick: () => copy(text, "Copied") }, icon("copy"), "Copy"));
}

function guideStep(n, title, ...children) {
  return h("li", { class: "guide-step" },
    h("span", { class: "guide-n", "aria-hidden": "true" }, String(n)),
    h("div", { class: "guide-body" }, h("b", {}, title), ...children));
}

function expect(text) {
  return h("p", { class: "expect" }, h("span", {}, "You should see"), text);
}

const CHEAT_SHEET = [
  ["mcpv help", "Every command, with examples"],
  ["mcpv help set", "Examples for one command (try it on any of them)"],
  ["mcpv ui", "This page"],
  ["mcpv set <address>", "Add or replace one secret (hidden prompt)"],
  ["mcpv import .env --into mcpm://ws/proj/dev --rewrite", "Move a .env into the vault"],
  ["mcpv check", "Does every reference in ./.env resolve? Names only"],
  ["mcpv run -- <command>", "Run with your secrets; output is masked"],
  ["mcpv run --env mcpm://ws/proj/dev -- <command>", "Run with a whole environment injected"],
  ["mcpv list", "Environments and key names, never values"],
  ["mcpv list --search stripe", "Find a key by name across every environment"],
  ["mcpv rm <address>", "Delete a secret"],
  ["mcpv init", "Create the vault (keychain, secret-service or file)"],
  ["mcpv doctor", "Where the vault lives and whether it unlocks"],
  ["mcpv update", "Install the newest version"],
];

function cheatSheet() {
  return h("dl", { class: "cheats" }, CHEAT_SHEET.flatMap(([cmd, what]) => [
    h("dt", {}, h("button", { type: "button", class: "cheat-cmd mono", "aria-label": `Copy: ${cmd}`, onclick: () => copy(cmd, "Copied") }, cmd)),
    h("dd", {}, what),
  ]));
}

const CHEAT_KEY = "mcpv.cheat.open";

/** Collapsed unless the person opened it; their choice is remembered. */
function cheatCard() {
  let opened = false;
  try { opened = localStorage.getItem(CHEAT_KEY) === "1"; } catch { /* storage blocked */ }
  const details = h("details", { class: "card cheat-card", id: "commands", open: opened },
    h("summary", {}, h("h2", {}, "Command cheat sheet"), h("span", { class: "note" }, "Click a command to copy it")),
    cheatSheet());
  details.addEventListener("toggle", () => {
    try { localStorage.setItem(CHEAT_KEY, details.open ? "1" : "0"); } catch { /* storage blocked */ }
  });
  return details;
}

function guideCard() {
  return h("section", { class: "card guide" },
    h("div", { class: "card-head" }, h("h2", {}, "Get started in four steps")),
    h("p", { class: "sub" }, "mcpv keeps your secrets encrypted on this machine. Your ", h("code", {}, ".env"), " holds addresses instead of values, and ", h("code", {}, "mcpv run"), " fills the real values in for one command. An AI agent can run your app this way without ever seeing a key."),
    h("ol", { class: "guide-steps" },
      guideStep(1, "Store a sample secret",
        h("p", {}, "A throwaway, so you can see how it works before using a real key. Type any value you like (4+ characters, like hello-world)."),
        h("div", { class: "actions" }, h("button", { class: "btn btn-primary", onclick: () => secretDialog(SAMPLE) }, icon("plus"), "Add the sample")),
        expect("GREETING in the list below, with •••••••• where its value would be. Values are never shown, here or anywhere.")),
      guideStep(2, "Point your .env at it",
        h("p", {}, "In your project folder, add this line to ", h("code", {}, ".env"), ". It's an address, not a value, so it is safe to commit or paste to an agent."),
        commandBlock(SAMPLE_LINE),
        expect("Nothing secret in the file. Later, Import .env moves your real values in and rewrites the file this way for you.")),
      guideStep(3, "Run something with it",
        h("p", {}, "In a terminal opened in that same folder:"),
        commandBlock(SAMPLE_RUN),
        expect("GREETING is [redacted]. The program received the real value, but mcpv masks it on the way out, which is what keeps it out of logs and agent transcripts.")),
      guideStep(4, "Tell your agent",
        h("p", {}, "Paste this into Claude Code, Codex or Cursor (or your project's instructions file):"),
        commandBlock(AGENT_LINE),
        expect("The agent runs your app through mcpv run, and asks you to add a key yourself when one is missing.")),
    ));
}

function render() {
  const app = document.getElementById("app");
  const { state, check, page } = data;
  const total = state.environments.reduce((n, env) => n + env.keys.length, 0);
  const actions = h("div", { class: "actions" },
    h("button", { class: "btn", onclick: importDialog }, icon("upload"), "Import .env"),
    h("button", { class: "btn btn-primary", onclick: () => secretDialog() }, icon("plus"), "Add secret"));

  const body = [];
  if (total === 0) {
    body.push(guideCard());
    body.push(h("section", { class: "card empty" },
      h("b", {}, "Already have keys?"),
      h("p", {}, "Skip the sample: import an existing .env, or add a real secret."),
      h("div", { class: "actions" },
        h("button", { class: "btn", onclick: importDialog }, icon("upload"), "Import .env"),
        h("button", { class: "btn btn-primary", onclick: () => secretDialog() }, icon("plus"), "Add secret"))));
  } else {
    const strip = environmentStrip(state.environments);
    if (strip) strip.id = "secrets";
    body.push(strip);
    body.push(toolbar(page, facetsFrom(state.environments)));
    body.push(h("section", { class: "card list-card" },
      page.items.length === 0
        ? h("div", { class: "empty quiet" },
          h("b", {}, "Nothing matches"),
          h("p", {}, "Try a shorter search, or clear the filters."),
          h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => setFilters({ search: "", workspace: "", project: "", environment: "" }) }, "Clear filters")))
        : h("ul", { class: "rows" }, page.items.map(secretRow))));
  }

  // The search box is re-created by this render, so whichever control the
  // person is in has to be put back — otherwise typing a search term would
  // lose the caret on the first keystroke that triggers a request.
  const focused = document.activeElement;
  const restore = focused && focused.id && app.contains(focused)
    ? { id: focused.id, start: focused.selectionStart, end: focused.selectionEnd }
    : null;

  app.replaceChildren(
    topbar(),
    h("main", {},
      h("div", { class: "page-head" },
        h("div", { class: "grow" },
          h("h1", {}, "Secrets"),
          h("p", {}, "Encrypted on this machine. Values are never shown here. Agents use them through ", h("code", {}, "mcpv run"), ".")),
        total ? actions : null),
      state.keyStore ? h("div", { class: "meta" },
        h("span", { class: `badge ${state.keyStore === "file" ? "warn" : "ok"}` }, STORE_LABEL[state.keyStore] ?? state.keyStore),
        h("span", { class: "badge" }, `${plural(state.environments.length, "environment")} · ${plural(total, "secret")}`)) : null,
      cheatCard(),
      projectCard(check),
      body));

  if (restore) {
    const next = document.getElementById(restore.id);
    if (next) {
      next.focus();
      if (restore.start !== null && next.setSelectionRange) {
        try { next.setSelectionRange(restore.start, restore.end); } catch { /* not a text field */ }
      }
    }
  }
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

async function loadPage() {
  const query = new URLSearchParams();
  if (view.search) query.set("search", view.search);
  if (view.workspace) query.set("workspace", view.workspace);
  if (view.project) query.set("project", view.project);
  if (view.environment) query.set("environment", view.environment);
  query.set("page", String(view.page));
  query.set("limit", String(view.pageSize));
  return api("GET", `/api/secrets?${query.toString()}`);
}

/** Filters and paging are the server's job (same code as `mcpv list`), so a
 *  change here is a re-request, not a re-implementation. */
function setFilters(next) {
  Object.assign(view, next);
  // Narrowing what's shown starts the list over; moving to another page (or
  // changing the page size, which sets page explicitly) does not.
  if (next.page === undefined) view.page = 1;
  reload();
}

function goTo(pageNumber) {
  view.page = pageNumber;
  reload();
}

let loadSeq = 0;

async function refresh(announce = false) {
  const mine = ++loadSeq;
  const [state, check, page] = await Promise.all([api("GET", "/api/state"), api("GET", "/api/check"), loadPage()]);
  if (mine !== loadSeq) return; // a later request already won
  data = { state, check, page };
  if (page.page !== view.page) view.page = page.page; // the server clamps
  render();
  if (announce) toast("Up to date");
}

/**
 * A reload triggered by something a person did. It never rejects: `refresh`
 * throws so the boot path can show its own "couldn't open your vault" screen,
 * and an unhandled rejection from a button click would be a console error and
 * a stale list with no explanation.
 */
function reload(announce = false) {
  return refresh(announce).catch((error) => {
    if (!ended) toast(error.message, "fail");
  });
}

if (!token) showEnded();
else refresh().catch((error) => {
  if (ended) return;
  document.getElementById("app").replaceChildren(h("div", { class: "ended" },
    h("b", {}, "Couldn't open your vault"), h("span", {}, error.message), h("span", {}, "Run ", h("code", {}, "mcpv doctor"), " in your terminal for details.")));
});
