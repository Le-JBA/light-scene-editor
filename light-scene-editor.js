/*
 * Light Scene Editor — Home Assistant custom sidebar panel
 *
 * Edit native HA scenes (lights only) WITHOUT applying them.
 * Reads/writes through HA's scene config API (the same one the built-in
 * scene editor uses), so scenes stay ordinary scene.* entities in scenes.yaml.
 *
 * Non-light entities already in a scene are kept untouched.
 * Lights you don't edit are saved back byte-for-byte as they were.
 */
const LSE_VERSION = "1.0.0";
const COLOR_MODES = ["hs", "xy", "rgb", "rgbw", "rgbww"];

/* ---------- helpers ---------- */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;
const errMsg = (e) => e?.body?.message || e?.message || (typeof e === "string" ? e : JSON.stringify(e));

function hsToRgb(h, s) {
  s = clamp(s, 0, 100) / 100;
  h = ((h % 360) + 360) % 360;
  const c = s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = 1 - c;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255));
}

function rgbToHs(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, max === 0 ? 0 : (d / max) * 100];
}

const rgbToHex = (rgb) => "#" + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
const hexToRgb = (hex) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hsToHex = (hs) => rgbToHex(hsToRgb(hs[0], hs[1]));
const hexToHs = (hex) => rgbToHs(...hexToRgb(hex));

function kelvinToHex(k) {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return rgbToHex([r, g, b]);
}

const stateAttrs = (so) => ({ ...so.attributes, state: so.state });

/** What a light can do. Falls back to attributes stored in the scene if the entity is unavailable. */
function caps(so, raw) {
  const src = so?.attributes?.supported_color_modes?.length ? so.attributes : raw && typeof raw === "object" ? raw : {};
  const modes = src.supported_color_modes || [];
  let brightness, temp, color;
  if (modes.length) {
    brightness = modes.some((m) => m !== "onoff");
    temp = modes.includes("color_temp");
    color = modes.some((m) => COLOR_MODES.includes(m));
  } else {
    brightness = src.brightness != null;
    temp = src.color_temp_kelvin != null;
    color = src.hs_color != null || src.rgb_color != null;
  }
  return {
    brightness,
    temp,
    color,
    minK: src.min_color_temp_kelvin || 2000,
    maxK: src.max_color_temp_kelvin || 6500,
  };
}

/** Stored scene entry (or live state attrs) -> editable model */
function parseEntry(raw) {
  const a = typeof raw === "string" ? { state: raw } : raw || {};
  const m = {
    state: a.state === "off" ? "off" : "on",
    brightnessPct: a.brightness != null ? clamp(Math.round(a.brightness / 2.55), 1, 100) : 100,
    mode: "none",
    kelvin: 2700,
    hs: [30, 70],
  };
  const cm = a.color_mode;
  if (cm === "color_temp" || (!cm && a.color_temp_kelvin != null)) m.mode = "temp";
  else if (COLOR_MODES.includes(cm) || (!cm && (a.hs_color || a.rgb_color))) m.mode = "color";
  if (a.color_temp_kelvin != null) m.kelvin = a.color_temp_kelvin;
  else if (a.color_temp) m.kelvin = Math.round(1e6 / a.color_temp);
  if (Array.isArray(a.hs_color)) m.hs = [a.hs_color[0], a.hs_color[1]];
  else if (Array.isArray(a.rgb_color)) m.hs = rgbToHs(...a.rgb_color);
  return m;
}

/** Editable model -> scene entry that HA's light reproduce_state understands */
function buildEntry(m, c) {
  if (m.state === "off") return { state: "off" };
  const e = { state: "on" };
  if (c.brightness) e.brightness = clamp(Math.round(m.brightnessPct * 2.55), 1, 255);
  if (m.mode === "temp" && c.temp) {
    e.color_mode = "color_temp";
    e.color_temp_kelvin = Math.round(clamp(m.kelvin, c.minK, c.maxK));
  } else if (m.mode === "color" && c.color) {
    e.color_mode = "hs";
    e.hs_color = [round1(m.hs[0]), round1(m.hs[1])];
  }
  return e;
}

/* ---------- panel ---------- */

class LightSceneEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._view = "list";
    this._filter = "";
    this._pickFilter = "";
    this._pickerMode = null; // "ha" | "fallback"
    this._error = null;
    this._keepScroll = false;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._bind();
      this._render();
      this._loadPicker();
      return;
    }
    if (this._view === "list") {
      if (this._sceneKey() !== this._lastKey) this._render();
    } else {
      this._refreshLive();
    }
  }
  get hass() { return this._hass; }

  set narrow(v) {
    this._narrow = v;
    const b = this.shadowRoot.querySelector(".menu");
    if (b) b.hidden = !v;
  }
  set panel(p) { this._panel = p; }
  set route(r) { this._route = r; }

  /* ----- HA's own entity picker (same as automation editor), with fallback ----- */
  async _loadPicker() {
    let ok = !!customElements.get("ha-entity-picker");
    if (!ok) {
      try {
        const helpers = await window.loadCardHelpers?.();
        if (helpers) {
          await helpers.createCardElement({ type: "entities", entities: [] });
          const cls = customElements.get("hui-entities-card");
          if (cls?.getConfigElement) await cls.getConfigElement();
        }
        await Promise.race([customElements.whenDefined("ha-entity-picker"), new Promise((r) => setTimeout(r, 4000))]);
      } catch (_) { /* fall back */ }
      ok = !!customElements.get("ha-entity-picker");
    }
    this._pickerMode = ok ? "ha" : "fallback";
    if (this._view === "editor") this._mountPicker();
  }

  /* ----- data ----- */
  _scenes() {
    return Object.values(this._hass.states)
      .filter((s) => s.entity_id.startsWith("scene."))
      .map((s) => {
        const ents = s.attributes.entity_id || [];
        return {
          entity_id: s.entity_id,
          id: s.attributes.id,
          name: s.attributes.friendly_name || s.entity_id,
          icon: s.attributes.icon,
          lights: ents.filter((e) => e.startsWith("light.")).length,
          total: ents.length,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  _sceneKey() {
    return this._scenes().map((s) => `${s.entity_id}|${s.id}|${s.name}|${s.icon}|${s.total}`).join(";");
  }

  _areaName(eid) {
    const h = this._hass;
    const ent = h.entities?.[eid];
    if (!ent) return "";
    const areaId = ent.area_id || h.devices?.[ent.device_id]?.area_id;
    return areaId ? h.areas?.[areaId]?.name || "" : "";
  }

  _curText(so) {
    if (!so) return "Entity not found";
    if (so.state === "unavailable" || so.state === "unknown") return "Unavailable";
    if (so.state === "on") {
      const b = so.attributes.brightness;
      return b != null ? `Now on · ${Math.round(b / 2.55)}%` : "Now on";
    }
    return "Now off";
  }

  /* ----- events ----- */
  _bind() {
    const r = this.shadowRoot;
    r.addEventListener("click", (e) => this._onClick(e));
    r.addEventListener("input", (e) => this._onInput(e));
    r.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s" && this._view === "editor") {
        e.preventDefault();
        this._save();
      }
    });
  }

  _onClick(e) {
    const t = e.target.closest("[data-action]");
    if (!t || t.disabled) return;
    const { action, eid, value, id } = t.dataset;
    const l = eid ? this._lights?.get(eid) : null;
    switch (action) {
      case "menu":
        this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true }));
        break;
      case "new": this._newScene(); break;
      case "open": this._openScene(id); break;
      case "activate":
        this._hass.callService("scene", "turn_on", { entity_id: t.dataset.entity });
        this._toast("Scene activated");
        break;
      case "dismiss": this._error = null; this._render(); break;
      case "back": this._back(); break;
      case "save": this._save(); break;
      case "delete": this._delete(); break;
      case "pick": this._addLight(eid); break;
      case "state":
        if (!l) return;
        l.m.state = value; l.dirty = true; this._markDirty(); this._rerenderRow(eid);
        break;
      case "mode":
        if (!l) return;
        l.m.mode = value; l.dirty = true; this._markDirty(); this._rerenderRow(eid);
        break;
      case "current": {
        const so = this._hass.states[eid];
        if (!l || !so) return;
        l.m = parseEntry(stateAttrs(so)); l.dirty = true; this._markDirty(); this._rerenderRow(eid);
        break;
      }
      case "preview": this._preview(eid); break;
      case "remove":
        this._lights.delete(eid);
        this._order = this._order.filter((x) => x !== eid);
        this._markDirty();
        this._render();
        break;
    }
  }

  _onInput(e) {
    const t = e.target;
    const f = t.dataset?.field;
    if (!f) return;
    const eid = t.dataset.eid;
    const l = eid ? this._lights?.get(eid) : null;
    const q = (sel) => this.shadowRoot.querySelector(sel);
    switch (f) {
      case "filter":
        this._filter = t.value;
        q(".scene-list").innerHTML = this._sceneRowsHtml();
        break;
      case "name":
        this._name = t.value;
        q("[data-title]").textContent = t.value || "Unnamed scene";
        this._markDirty();
        break;
      case "icon":
        this._icon = t.value.trim();
        q("[data-iconpreview]")?.setAttribute("icon", this._icon || "mdi:palette");
        this._markDirty();
        break;
      case "brightness":
        if (!l) return;
        l.m.brightnessPct = +t.value; l.dirty = true;
        q(`[data-label="b:${CSS.escape(eid)}"]`).textContent = `${t.value}%`;
        this._markDirty();
        break;
      case "kelvin":
        if (!l) return;
        l.m.kelvin = +t.value; l.dirty = true;
        q(`[data-label="k:${CSS.escape(eid)}"]`).textContent = `${t.value} K`;
        this._paintIcon(eid);
        this._markDirty();
        break;
      case "color":
        if (!l) return;
        l.m.hs = hexToHs(t.value); l.dirty = true;
        this._paintIcon(eid);
        this._markDirty();
        break;
      case "pick":
        this._pickFilter = t.value;
        q("[data-dropdown]").innerHTML = this._dropdownHtml();
        break;
    }
  }

  /* ----- actions ----- */
  async _openScene(id) {
    if (!id) {
      this._error = "That scene is defined in YAML outside the UI scene file, so it can't be edited here.";
      this._render();
      return;
    }
    this._view = "editor";
    this._loading = true;
    this._keepScroll = false;
    this._render();
    try {
      const cfg = await this._hass.callApi("GET", `config/scene/config/${id}`);
      this._loadCfg(cfg, false);
    } catch (e) {
      this._loading = false;
      this._view = "list";
      this._error = `Couldn't load scene: ${errMsg(e)}`;
    }
    this._keepScroll = false;
    this._render();
  }

  _newScene() {
    this._loadCfg({ id: String(Date.now()), name: "", entities: {} }, true);
    this._view = "editor";
    this._keepScroll = false;
    this._render();
    this.shadowRoot.querySelector('[data-field="name"]')?.focus();
  }

  _loadCfg(cfg, isNew) {
    this._cfg = cfg;
    this._isNew = isNew;
    this._name = cfg.name || "";
    this._icon = cfg.icon || "";
    this._lights = new Map();
    this._others = {};
    this._order = Object.keys(cfg.entities || {});
    for (const eid of this._order) {
      const raw = cfg.entities[eid];
      if (eid.startsWith("light.")) this._lights.set(eid, { raw, m: parseEntry(raw), dirty: false });
      else this._others[eid] = raw;
    }
    this._dirty = isNew;
    this._loading = false;
    this._pickFilter = "";
    this._error = null;
  }

  _addLight(eid) {
    if (!eid || this._lights.has(eid)) return;
    const so = this._hass.states[eid];
    const m = so ? parseEntry(stateAttrs(so)) : parseEntry({ state: "on" });
    this._lights.set(eid, { raw: null, m, dirty: true });
    this._order.push(eid);
    this._pickFilter = "";
    this._markDirty();
    this._render();
  }

  _preview(eid) {
    const l = this._lights.get(eid);
    if (!l) return;
    const e = buildEntry(l.m, caps(this._hass.states[eid], l.raw));
    if (e.state === "off") {
      this._hass.callService("light", "turn_off", { entity_id: eid });
      return;
    }
    const data = { entity_id: eid };
    if (e.brightness != null) data.brightness = e.brightness;
    if (e.color_temp_kelvin != null) data.color_temp_kelvin = e.color_temp_kelvin;
    if (e.hs_color) data.hs_color = e.hs_color;
    this._hass.callService("light", "turn_on", data);
  }

  _back() {
    if (this._dirty && !confirm("Discard unsaved changes?")) return;
    this._view = "list";
    this._dirty = false;
    this._error = null;
    this._keepScroll = false;
    this._render();
  }

  async _save() {
    if (!this._dirty || this._saving) return;
    if (!this._name.trim()) { this._error = "Give the scene a name."; this._render(); return; }
    if (!this._order.length) { this._error = "A scene needs at least one light."; this._render(); return; }

    const entities = {};
    const metadata = { ...(this._cfg.metadata || {}) };
    for (const eid of this._order) {
      const l = this._lights.get(eid);
      if (l) {
        entities[eid] = l.dirty || l.raw == null ? buildEntry(l.m, caps(this._hass.states[eid], l.raw)) : l.raw;
        if (!metadata[eid]) metadata[eid] = { entity_only: true };
      } else {
        entities[eid] = this._others[eid];
      }
    }
    for (const k of Object.keys(metadata)) if (!(k in entities)) delete metadata[k];

    const out = { ...this._cfg, name: this._name.trim(), entities };
    if (this._icon) out.icon = this._icon; else delete out.icon;
    if (Object.keys(metadata).length) out.metadata = metadata; else delete out.metadata;

    this._saving = true;
    try {
      await this._hass.callApi("POST", `config/scene/config/${out.id}`, out);
      this._cfg = out;
      for (const [eid, l] of this._lights) { l.raw = entities[eid]; l.dirty = false; }
      this._isNew = false;
      this._dirty = false;
      this._error = null;
      this._toast("Scene saved");
    } catch (e) {
      this._error = `Save failed: ${errMsg(e)}`;
    }
    this._saving = false;
    this._keepScroll = true;
    this._render();
  }

  async _delete() {
    if (!confirm(`Delete scene "${this._name || "Unnamed scene"}"?`)) return;
    try {
      await this._hass.callApi("DELETE", `config/scene/config/${this._cfg.id}`);
      this._toast("Scene deleted");
      this._dirty = false;
      this._view = "list";
      this._keepScroll = false;
    } catch (e) {
      this._error = `Delete failed: ${errMsg(e)}`;
    }
    this._render();
  }

  _markDirty() {
    this._dirty = true;
    const b = this.shadowRoot.querySelector('[data-action="save"]');
    if (b) b.disabled = false;
  }

  _toast(message) {
    this.dispatchEvent(new CustomEvent("hass-notification", { detail: { message }, bubbles: true, composed: true }));
  }

  /* ----- rendering ----- */
  _render() {
    const prev = this.shadowRoot.querySelector(".content");
    const scroll = prev ? prev.scrollTop : 0;
    this.shadowRoot.innerHTML = `<style>${STYLE}</style>${this._view === "list" ? this._listHtml() : this._editorHtml()}`;
    if (this._view === "list") this._lastKey = this._sceneKey();
    const c = this.shadowRoot.querySelector(".content");
    if (c && this._keepScroll) c.scrollTop = scroll;
    this._keepScroll = true;
    if (this._view === "editor" && !this._loading) this._mountPicker();
  }

  _toolbar(inner) {
    return `<div class="toolbar">
      <button class="iconbtn menu" data-action="menu" ${this._narrow ? "" : "hidden"} title="Menu"><ha-icon icon="mdi:menu"></ha-icon></button>
      ${inner}
    </div>`;
  }

  _banner() {
    return this._error
      ? `<div class="banner"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><span>${esc(this._error)}</span>
         <button class="iconbtn" data-action="dismiss" title="Dismiss"><ha-icon icon="mdi:close"></ha-icon></button></div>`
      : "";
  }

  _listHtml() {
    return `${this._toolbar(`<div class="title">Light scenes</div>`)}
      <div class="content"><div class="inner">
        ${this._banner()}
        <input class="text" data-field="filter" placeholder="Search scenes" value="${esc(this._filter)}">
        <div class="card scene-list">${this._sceneRowsHtml()}</div>
        <div class="footnote">Light Scene Editor ${LSE_VERSION} · edits are stored without applying the scene</div>
      </div></div>
      <button class="fab" data-action="new"><ha-icon icon="mdi:plus"></ha-icon><span>Add scene</span></button>`;
  }

  _sceneRowsHtml() {
    const f = this._filter.trim().toLowerCase();
    const list = this._scenes().filter((s) => !f || s.name.toLowerCase().includes(f) || s.entity_id.includes(f));
    if (!list.length) return `<div class="empty">${f ? "No matching scenes" : "No scenes yet"}</div>`;
    return list
      .map((s) => {
        const others = s.total - s.lights;
        const sub = s.id
          ? `${s.lights} light${s.lights === 1 ? "" : "s"}${others ? ` · ${others} other` : ""}`
          : "Defined in YAML — not editable here";
        return `<div class="row ${s.id ? "" : "disabled"}" ${s.id ? `data-action="open" data-id="${esc(s.id)}"` : ""}>
          <ha-icon icon="${esc(s.icon || "mdi:palette")}"></ha-icon>
          <div class="meta"><div class="name">${esc(s.name)}</div><div class="sub">${esc(sub)}</div></div>
          <button class="iconbtn" data-action="activate" data-entity="${esc(s.entity_id)}" title="Activate scene"><ha-icon icon="mdi:play"></ha-icon></button>
          ${s.id ? `<ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>` : ""}
        </div>`;
      })
      .join("");
  }

  _editorHtml() {
    const bar = this._toolbar(`
      <button class="iconbtn" data-action="back" title="Back"><ha-icon icon="mdi:arrow-left"></ha-icon></button>
      <div class="title" data-title>${esc(this._name || (this._loading ? "Loading…" : "Unnamed scene"))}</div>
      ${!this._isNew && !this._loading ? `<button class="iconbtn" data-action="delete" title="Delete scene"><ha-icon icon="mdi:delete-outline"></ha-icon></button>` : ""}
      <button class="btn save" data-action="save" ${this._dirty ? "" : "disabled"}>Save</button>`);
    if (this._loading) return `${bar}<div class="content"><div class="inner"><div class="empty">Loading scene…</div></div></div>`;

    const lightIds = this._order.filter((e) => this._lights.has(e));
    const otherIds = this._order.filter((e) => !this._lights.has(e));
    return `${bar}<div class="content"><div class="inner">
      ${this._banner()}
      <div class="card"><div class="card-body grid2">
        <div><label class="field">Name</label><input class="text" data-field="name" value="${esc(this._name)}" placeholder="e.g. Evening"></div>
        <div><label class="field">Icon</label><div class="iconrow">
          <ha-icon data-iconpreview icon="${esc(this._icon || "mdi:palette")}"></ha-icon>
          <input class="text" data-field="icon" value="${esc(this._icon)}" placeholder="mdi:sofa"></div></div>
      </div></div>

      <div class="card">
        <div class="card-header">Lights <span class="count">${lightIds.length}</span></div>
        <div class="hint">Nothing is applied while you edit. Use <ha-icon icon="mdi:play"></ha-icon> on a light to preview just that bulb.</div>
        <div class="card-body picker"><div id="picker"></div></div>
        ${lightIds.map((eid) => this._rowHtml(eid)).join("") || `<div class="empty">No lights in this scene yet</div>`}
      </div>

      ${otherIds.length ? `<div class="card">
        <div class="card-header">Other entities <span class="count">${otherIds.length}</span></div>
        <div class="hint">Not lights — kept exactly as they are when you save.</div>
        ${otherIds.map((e) => `<div class="other"><ha-icon icon="mdi:shape-outline"></ha-icon>
          <span>${esc(this._hass.states[e]?.attributes?.friendly_name || e)}</span><small>${esc(e)}</small></div>`).join("")}
      </div>` : ""}
    </div></div>`;
  }

  _iconColor(eid) {
    const l = this._lights.get(eid);
    const c = caps(this._hass.states[eid], l.raw);
    if (l.m.state !== "on") return "var(--disabled-text-color, #8a8a8a)";
    if (l.m.mode === "color" && c.color) return hsToHex(l.m.hs);
    if (l.m.mode === "temp" && c.temp) return kelvinToHex(l.m.kelvin);
    return "var(--state-light-active-color, #ffc107)";
  }

  _paintIcon(eid) {
    const el = this.shadowRoot.querySelector(`[data-licon="${CSS.escape(eid)}"]`);
    if (el) el.style.color = this._iconColor(eid);
  }

  _rowHtml(eid) {
    const l = this._lights.get(eid);
    const so = this._hass.states[eid];
    const c = caps(so, l.raw);
    const m = l.m;
    const name = so?.attributes?.friendly_name || eid;
    const area = this._areaName(eid);
    const on = m.state === "on";
    const e = esc(eid);

    const modeOpts = [];
    if (c.temp || c.color) modeOpts.push(["none", c.brightness ? "Brightness only" : "On only"]);
    if (c.temp) modeOpts.push(["temp", "Colour temp"]);
    if (c.color) modeOpts.push(["color", "Colour"]);
    const mode = modeOpts.some(([v]) => v === m.mode) ? m.mode : "none";
    const k = Math.round(clamp(m.kelvin, c.minK, c.maxK));

    return `<div class="light" data-row="${e}">
      <div class="lhead">
        <ha-icon data-licon="${e}" icon="${on ? "mdi:lightbulb" : "mdi:lightbulb-outline"}" style="color:${this._iconColor(eid)}"></ha-icon>
        <div class="meta">
          <div class="name">${esc(name)}${l.dirty ? ` <span class="dot" title="Changed"></span>` : ""}</div>
          <div class="sub">${area ? `${esc(area)} · ` : ""}${e} · <span data-cur="${e}">${esc(this._curText(so))}</span></div>
        </div>
        <button class="iconbtn" data-action="current" data-eid="${e}" title="Copy the bulb's current state" ${so ? "" : "disabled"}><ha-icon icon="mdi:eyedropper"></ha-icon></button>
        <button class="iconbtn" data-action="preview" data-eid="${e}" title="Preview on this bulb only"><ha-icon icon="mdi:play"></ha-icon></button>
        <button class="iconbtn" data-action="remove" data-eid="${e}" title="Remove from scene"><ha-icon icon="mdi:close"></ha-icon></button>
      </div>
      <div class="lbody">
        <div class="seg">
          <button class="${on ? "on" : ""}" data-action="state" data-eid="${e}" data-value="on">On</button>
          <button class="${on ? "" : "on"}" data-action="state" data-eid="${e}" data-value="off">Off</button>
        </div>
        ${on && c.brightness ? `<div class="slider"><ha-icon icon="mdi:brightness-6"></ha-icon>
          <input type="range" min="1" max="100" step="1" value="${m.brightnessPct}" data-field="brightness" data-eid="${e}">
          <span class="val" data-label="b:${e}">${m.brightnessPct}%</span></div>` : ""}
        ${on && modeOpts.length > 1 ? `<div class="seg">${modeOpts
          .map(([v, lbl]) => `<button class="${mode === v ? "on" : ""}" data-action="mode" data-eid="${e}" data-value="${v}">${lbl}</button>`)
          .join("")}</div>` : ""}
        ${on && mode === "temp" ? `<div class="slider"><ha-icon icon="mdi:thermometer"></ha-icon>
          <input class="kelvin" type="range" min="${c.minK}" max="${c.maxK}" step="50" value="${k}" data-field="kelvin" data-eid="${e}">
          <span class="val" data-label="k:${e}">${k} K</span></div>` : ""}
        ${on && mode === "color" ? `<div class="slider"><ha-icon icon="mdi:palette"></ha-icon>
          <input type="color" value="${hsToHex(m.hs)}" data-field="color" data-eid="${e}">
          <span class="sub">Hue/saturation stored; brightness set above</span></div>` : ""}
      </div>
    </div>`;
  }

  _rerenderRow(eid) {
    const el = this.shadowRoot.querySelector(`[data-row="${CSS.escape(eid)}"]`);
    if (el) el.outerHTML = this._rowHtml(eid);
  }

  _refreshLive() {
    this.shadowRoot.querySelectorAll("[data-cur]").forEach((el) => {
      el.textContent = this._curText(this._hass.states[el.dataset.cur]);
    });
    if (this._picker) this._picker.hass = this._hass;
  }

  _mountPicker() {
    const slot = this.shadowRoot.getElementById("picker");
    if (!slot) return;
    if (this._pickerMode === "ha") {
      const p = document.createElement("ha-entity-picker");
      p.hass = this._hass;
      p.includeDomains = ["light"];
      p.excludeEntities = [...this._lights.keys()];
      p.label = "Add light";
      p.value = "";
      p.addEventListener("value-changed", (ev) => {
        const v = ev.detail?.value;
        if (v) this._addLight(v);
      });
      slot.replaceChildren(p);
      this._picker = p;
    } else {
      slot.innerHTML = `<input class="text" data-field="pick" placeholder="Add light… search name, entity ID or area" value="${esc(this._pickFilter)}">
        <div class="dropdown" data-dropdown>${this._dropdownHtml()}</div>`;
      this._picker = null;
    }
  }

  _dropdownHtml() {
    const f = this._pickFilter.trim().toLowerCase();
    if (!f) return "";
    const hits = Object.values(this._hass.states)
      .filter((s) => s.entity_id.startsWith("light.") && !this._lights.has(s.entity_id))
      .map((s) => ({ eid: s.entity_id, name: s.attributes.friendly_name || s.entity_id, area: this._areaName(s.entity_id) }))
      .filter((x) => `${x.name} ${x.eid} ${x.area}`.toLowerCase().includes(f))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 30);
    if (!hits.length) return `<div class="opt empty">No matching lights</div>`;
    return hits
      .map((x) => `<button class="opt" data-action="pick" data-eid="${esc(x.eid)}"><ha-icon icon="mdi:lightbulb-outline"></ha-icon>
        <span class="name">${esc(x.name)}</span><small>${esc([x.area, x.eid].filter(Boolean).join(" · "))}</small></button>`)
      .join("");
  }
}

const STYLE = `
:host { display:block; height:100%; background:var(--primary-background-color); color:var(--primary-text-color);
  font-family:var(--ha-font-family-body, Roboto, Noto, sans-serif); -webkit-font-smoothing:antialiased; }
* { box-sizing:border-box; }
[hidden] { display:none !important; }
.toolbar { display:flex; align-items:center; gap:4px; height:var(--header-height, 56px); padding:0 8px 0 12px;
  background:var(--app-header-background-color, var(--primary-color)); color:var(--app-header-text-color, #fff);
  border-bottom:var(--app-header-border-bottom, none); font-size:20px; }
.title { flex:1; min-width:0; padding-left:8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.content { height:calc(100% - var(--header-height, 56px)); overflow:auto; padding:16px 16px 96px; }
.inner { max-width:880px; margin:0 auto; display:flex; flex-direction:column; gap:16px; }
.card { background:var(--ha-card-background, var(--card-background-color, #fff)); border-radius:var(--ha-card-border-radius, 12px);
  border:1px solid var(--ha-card-border-color, var(--divider-color)); box-shadow:var(--ha-card-box-shadow, none); overflow:hidden; }
.card-header { padding:16px 16px 4px; font-size:16px; font-weight:500; display:flex; align-items:center; gap:8px; }
.card-body { padding:12px 16px 16px; }
.card-body.picker { padding-top:4px; }
.count { font-size:12px; font-weight:500; padding:1px 8px; border-radius:10px; background:var(--secondary-background-color); color:var(--secondary-text-color); }
.hint { padding:0 16px 8px; font-size:13px; color:var(--secondary-text-color); --mdc-icon-size:16px; }
.footnote { text-align:center; font-size:12px; color:var(--secondary-text-color); }
.empty { padding:24px 16px; text-align:center; color:var(--secondary-text-color); }
.grid2 { display:grid; grid-template-columns:2fr 1fr; gap:16px; }
@media (max-width:600px) { .grid2 { grid-template-columns:1fr; } .lbody { margin-left:0 !important; } }
label.field { display:block; font-size:12px; color:var(--secondary-text-color); margin:0 0 4px; }
.iconrow { display:flex; align-items:center; gap:8px; }
.text { width:100%; padding:10px 12px; border:1px solid var(--divider-color); border-radius:8px; font:inherit; font-size:15px;
  background:var(--input-fill-color, var(--secondary-background-color)); color:var(--primary-text-color); outline:none; }
.text:focus { border-color:var(--primary-color); }
.iconbtn { background:none; border:none; color:inherit; cursor:pointer; padding:8px; border-radius:50%; display:inline-flex; --mdc-icon-size:22px; }
.iconbtn:hover:not([disabled]) { background:rgba(127,127,127,.18); }
.iconbtn[disabled] { opacity:.35; cursor:default; }
.btn { border:none; border-radius:18px; padding:8px 18px; font:inherit; font-size:14px; font-weight:500; cursor:pointer; }
.btn.save { background:var(--app-header-text-color, #fff); color:var(--app-header-background-color, var(--primary-color)); margin-left:4px; }
.btn[disabled] { opacity:.45; cursor:default; }
.fab { position:fixed; right:24px; bottom:24px; display:flex; align-items:center; gap:8px; padding:0 20px 0 16px; height:56px;
  border:none; border-radius:16px; background:var(--primary-color); color:var(--text-primary-color, #fff); font:inherit; font-size:15px;
  font-weight:500; cursor:pointer; box-shadow:0 3px 8px rgba(0,0,0,.3); }
.banner { display:flex; align-items:center; gap:10px; padding:8px 8px 8px 16px; border-radius:10px; background:var(--error-color, #db4437); color:#fff; }
.banner span { flex:1; }
.row { display:flex; align-items:center; gap:16px; padding:10px 8px 10px 16px; cursor:pointer; border-top:1px solid var(--divider-color); }
.row:first-child { border-top:none; }
.row:hover { background:var(--secondary-background-color); }
.row.disabled { cursor:default; opacity:.6; }
.row .chev { color:var(--secondary-text-color); }
.meta { flex:1; min-width:0; }
.name { font-size:15px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sub { font-size:12.5px; color:var(--secondary-text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--primary-color); vertical-align:middle; }
.light { border-top:1px solid var(--divider-color); padding:10px 8px 14px 16px; }
.lhead { display:flex; align-items:center; gap:12px; }
.lbody { margin:8px 8px 0 36px; display:flex; flex-direction:column; align-items:flex-start; gap:10px; }
.seg { display:inline-flex; border:1px solid var(--divider-color); border-radius:8px; overflow:hidden; flex-wrap:wrap; }
.seg button { background:none; border:none; padding:6px 14px; color:var(--primary-text-color); cursor:pointer; font:inherit; font-size:13px; }
.seg button + button { border-left:1px solid var(--divider-color); }
.seg button.on { background:var(--primary-color); color:var(--text-primary-color, #fff); }
.slider { display:flex; align-items:center; gap:12px; width:100%; --mdc-icon-size:20px; color:var(--secondary-text-color); }
.slider input[type=range] { flex:1; accent-color:var(--primary-color); }
.slider .val { min-width:64px; text-align:right; font-variant-numeric:tabular-nums; font-size:13px; }
input.kelvin { -webkit-appearance:none; appearance:none; height:8px; border-radius:4px; background:linear-gradient(to right, #ff9a3c, #ffe2b8, #fff8ef, #d6e6ff); }
input.kelvin::-webkit-slider-thumb { -webkit-appearance:none; width:18px; height:18px; border-radius:50%; background:#fff; border:2px solid var(--primary-color); cursor:pointer; }
input.kelvin::-moz-range-thumb { width:14px; height:14px; border-radius:50%; background:#fff; border:2px solid var(--primary-color); cursor:pointer; }
input[type=color] { width:64px; height:34px; padding:2px; border:1px solid var(--divider-color); border-radius:8px; background:none; cursor:pointer; }
.dropdown { margin-top:4px; border:1px solid var(--divider-color); border-radius:8px; max-height:320px; overflow:auto; }
.dropdown:empty { display:none; }
.opt { display:flex; width:100%; align-items:center; gap:12px; padding:8px 12px; background:none; border:none; border-top:1px solid var(--divider-color);
  color:inherit; text-align:left; cursor:pointer; font:inherit; }
.opt:first-child { border-top:none; }
.opt:hover { background:var(--secondary-background-color); }
.opt .name { flex:1; }
.opt small, .other small { color:var(--secondary-text-color); }
.opt.empty { cursor:default; color:var(--secondary-text-color); }
.other { display:flex; align-items:center; gap:12px; padding:10px 16px; border-top:1px solid var(--divider-color); }
.other span { flex:1; }
ha-entity-picker { display:block; }
`;

customElements.define("light-scene-editor", LightSceneEditor);
console.info(`%c LIGHT-SCENE-EDITOR %c ${LSE_VERSION} `, "background:#03a9f4;color:#fff", "background:#444;color:#fff");
