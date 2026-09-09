(() => {
  const IS_BROWSER = typeof browser !== "undefined";
  const API = IS_BROWSER ? browser : chrome;

  let parser = null;
  let debug = false;
  let useDisplayLines = false;
  let executor = null;
  let mode = "normal"; // normal | insert | visual | visualLine
  let tempNormal = false; // from <C-O>
  let replaceMode = false; // insert-overwrite (R)
  // Ops array recording user activity during insert / replace mode for '.' repeat.
  // Each op is either { type: 'text', value: 'abc' } or { type: 'bs', count: N }.
  // Backspaces collapse trailing text first; once the buffer is empty, additional
  // backspaces accumulate as bs ops so we can faithfully replay over pre-existing text.
  let insertOps = [];
  function resetInsertOps() {
    insertOps = [];
  }
  function appendOpText(s) {
    if (!s) return;
    const last = insertOps[insertOps.length - 1];
    if (last && last.type === "text") last.value += s;
    else insertOps.push({ type: "text", value: s });
  }
  function appendOpBs() {
    const last = insertOps[insertOps.length - 1];
    if (last && last.type === "text" && last.value.length > 0) {
      last.value = last.value.slice(0, -1);
      if (!last.value) insertOps.pop();
      return;
    }
    if (last && last.type === "bs") last.count++;
    else insertOps.push({ type: "bs", count: 1 });
  }
  let uiTheme = "vim";
  let ui = null;
  let vimEnabled = true;

  let executing = false;
  let draining = false;
  const commands = [];
  const inputs = [];
  let insertPending = [];
  let mappingTimer = null;

  function suppress(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  // Parse queued keys only after the preceding document operation has finished:
  // a change operator may enter Insert mode while it is awaiting Docs.
  function drain() {
    if (draining || executing) return;
    draining = true;
    try {
      while (!executing) {
        if (commands.length) {
          executing = true;
          const run = commands.shift();
          Promise.resolve().then(run).catch(err => {
            console.error("[VimExecutor]", err);
          }).finally(() => {
            executing = false;
            drain();
          });
        } else if (inputs.length) {
          const { event, literal } = inputs.shift();
          handleKey(event, true, literal);
        } else break;
      }
    } finally {
      draining = false;
    }
  }

  function runExec(result, after) {
    commands.push(async () => {
      await executor.exec(result);
      if (after) after();
    });
    drain();
  }

  function log(...args) {
    if (debug) console.log("[VimParser]", ...args);
  }

  const eventToToken = window.VimConfig.eventToToken;
  const printable = e => Array.from(e.key || "").length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;

  function clearInsertMapping() {
    clearTimeout(mappingTimer);
    mappingTimer = null;
    insertPending = [];
  }

  function flushInsertMapping(nextEvent) {
    const literal = insertPending.filter(e => !e.ctrlKey && !e.altKey && !e.metaKey)
      .map(event => ({ event, literal: true }));
    clearInsertMapping();
    parser.reset();
    if (ui) ui.setBufferText("");
    if (nextEvent) literal.push({ event: nextEvent, literal: false });
    inputs.unshift(...literal);
    drain();
  }

  function replayKey(event) {
    runExec({
      kind: "key",
      event: {
        key: event.key, code: event.code, keyCode: event.keyCode,
        ctrlKey: !!event.ctrlKey, altKey: !!event.altKey,
        metaKey: !!event.metaKey, shiftKey: !!event.shiftKey,
      },
    });
  }

  function applyConfig(config) {
    const error = window.VimConfig.validate(config);
    if (error) throw new Error(error);
    if (insertPending.length) flushInsertMapping();
    parser.setConfig(config);
    parser.reset();
  }

  function recordInsertCommand(id) {
    if (id === "insert_delete_char_back") appendOpBs();
    else if (id === "insert_line_break" && !replaceMode) appendOpText("\n");
    else if (id === "insert_delete_word") {
      try {
        const d = executor.nav.prevStartDelta("word");
        for (let i = 0; i < d; i++) appendOpBs();
      } catch (_) {}
    }
  }

  // Returns true if the parse result was handled (caller should stop).
  function dispatchInsertParse(res) {
    if (!res) return true;
    if (res.kind === "prefix" || res.kind === "await_char") {
      if (ui) ui.setBufferText((res.keys || []).join(""));
      return true;
    }
    if (res.kind === "invalid") {
      if (ui) ui.setBufferText("");
      return false;
    }
    if (res.kind !== "command") return false;
    if (ui) ui.setBufferText("");
    const id = res.command && res.command.id;
    if (id === "insert_temp_normal") {
      tempNormal = true;
      setMode("normal");
      return true;
    }
    if (id === "exit_insert" || id === "exit_insert_ctrl_c" || (id && String(id).startsWith("exit_"))) {
      try {
        executor.finishInsert(insertOps);
      } catch (_) {}
      resetInsertOps();
      replaceMode = false;
      runExec(res);
      return true;
    }
    if (id === "insert_register") {
      const ch = res.command.args && res.command.args.char;
      try {
        const text = ch ? executor.getRegisterText(ch) : "";
        if (text) appendOpText(text);
      } catch (_) {}
      runExec(res);
      return true;
    }
    recordInsertCommand(id);
    runExec(res);
    return true;
  }

  function findEditorDoc() {
    const editorIframe = document.querySelector(".docs-texteventtarget-iframe");
    if (editorIframe && editorIframe.contentDocument)
      return editorIframe.contentDocument;
    const anyIframe = document.getElementsByTagName("iframe")[0];
    if (anyIframe && anyIframe.contentDocument)
      return anyIframe.contentDocument;
    return document;
  }

  function restoreTempNormal() {
    if (!tempNormal) return;
    tempNormal = false;
    const savedOps = insertOps;
    setMode("insert");
    insertOps = savedOps;
  }

  function handleKey(e, replay = false, literal = false) {
    const token = eventToToken(e);
    try {
      if (literal || !vimEnabled) {
        if (mode === "insert" && printable(e)) appendOpText(e.key);
        else if (mode === "insert" && e.key === "Enter" && !replaceMode) appendOpText("\n");
        else if (mode === "insert" && e.key === "Backspace") appendOpBs();
        if (replaceMode && printable(e) && vimEnabled) {
          runExec({ kind: "command", command: { id: "insert_replace_char", args: { char: e.key } }, count: 1 });
        } else replayKey(e);
        return;
      }
      if (mode === "insert") {
        if (token && (parser.isPending() || parser.isBinding(token))) {
          suppress(e);
          clearTimeout(mappingTimer);
          const res = parser.feed(token);
          if (res.kind === "invalid") {
            flushInsertMapping(e);
            return;
          }
          if (res.kind === "prefix" || res.kind === "await_char") {
            insertPending.push(e);
            mappingTimer = setTimeout(() => flushInsertMapping(), parser.settings.mappingTimeoutMs);
          } else clearInsertMapping();
          dispatchInsertParse(res);
          return;
        }
        if (insertPending.length) {
          suppress(e);
          flushInsertMapping(e);
          return;
        }
        if (printable(e)) appendOpText(e.key);
        else if (e.key === "Enter" && !replaceMode) appendOpText("\n");
        else if (e.key === "Backspace") appendOpBs();
        if (replaceMode && printable(e)) {
          suppress(e);
          runExec({ kind: "command", command: { id: "insert_replace_char", args: { char: e.key } }, count: 1 });
        } else if (replay) replayKey(e);
        return;
      }

      // Unmapped navigation keys and application shortcuts retain native behavior.
      // Pending mappings can consume modified keys, even if those keys cannot start one.
      const nativeKey = !token || e.ctrlKey || e.altKey || e.metaKey ||
        (!printable(e) && !["Escape", "Enter", "Backspace", "Tab"].includes(e.key));
      if (parser.isCancel(token)) parser.reset();
      if (nativeKey && !parser.isBinding(token) && !parser.canContinue(token) && !parser.isCancel(token)) {
        parser.reset();
        if (ui) ui.setBufferText("");
        if (replay) replayKey(e);
        restoreTempNormal();
        return;
      }
      suppress(e);
      const res = parser.feed(token);
      if (!res || res.kind === "invalid") {
        if (ui) ui.setBufferText("");
        restoreTempNormal();
        return;
      }
      if (res.kind === "prefix" || res.kind === "await_char") {
        if (ui) ui.setBufferText((res.keys || []).join(""));
        return;
      }
      log("complete", res);
      const returnToInsert = tempNormal;
      runExec(res, () => {
        if (returnToInsert) restoreTempNormal();
      });
      if (ui) ui.setBufferText("");
    } catch (err) {
      console.error("Parser error", err);
    }
  }

  function attachKeyListener() {
    const doc = findEditorDoc();
    doc.addEventListener("keydown", e => {
      if (!vimEnabled || !e.isTrusted || e.isComposing || e.key === "Dead" ||
          e.key === "Process" || e.getModifierState?.("AltGraph")) return;
      // Modifier-only events do not change the document and need no buffering.
      if (!eventToToken(e)) return;
      // Browser shortcuts cannot be replayed with untrusted events.
      if ((e.ctrlKey || e.metaKey || e.altKey) && !parser.isBinding(eventToToken(e)) &&
          !parser.canContinue(eventToToken(e)) && !parser.isCancel(eventToToken(e)) &&
          !(executing && parser.commandsRootByMode.insert.children.has(eventToToken(e)))) {
        if (insertPending.length) flushInsertMapping();
        parser.reset();
        if (ui) ui.setBufferText("");
        if (executing) commands.push(async () => restoreTempNormal());
        else restoreTempNormal();
        return;
      }
      if (executing || inputs.length) {
        suppress(e);
        inputs.push({ event: e, literal: false });
        drain();
      } else handleKey(e);
    }, true);
  }

  function injectPageScript() {
    const script = document.createElement("script");
    script.src = API.runtime.getURL("page_script.js");
    document.documentElement.appendChild(script);
  }

  function migrateConfig(stored, base) {
    const storedVersion = stored.schemaVersion || 1;
    const baseVersion = base.schemaVersion || 1;
    if (storedVersion >= baseVersion) return stored;

    log(`Migrating config from schema v${storedVersion} to v${baseVersion}`);
    const migrated = JSON.parse(JSON.stringify(stored));
    migrated.schemaVersion = baseVersion;

    // Migration v1 -> v2: Add first_non_blank_down motion
    if (storedVersion < 2) {
      const hasMotion = (migrated.motions || []).some(
        (m) => m.id === "first_non_blank_down",
      );
      if (!hasMotion) {
        const baseMotion = (base.motions || []).find(
          (m) => m.id === "first_non_blank_down",
        );
        if (baseMotion) {
          migrated.motions = migrated.motions || [];
          const insertIdx = migrated.motions.findIndex(
            (m) => m.id === "line_end",
          );
          if (insertIdx >= 0) {
            migrated.motions.splice(insertIdx, 0, baseMotion);
          } else {
            migrated.motions.push(baseMotion);
          }
          log("Added first_non_blank_down motion (_) during migration");
        }
      }
    }

    // Migration v2 -> v3: Add toggle_case_char command
    if (storedVersion < 3) {
      const hasCommand = (migrated.commands || []).some(
        (c) => c.id === "toggle_case_char",
      );
      if (!hasCommand) {
        const baseCommand = (base.commands || []).find(
          (c) => c.id === "toggle_case_char",
        );
        if (baseCommand) {
          migrated.commands = migrated.commands || [];
          const insertIdx = migrated.commands.findIndex(
            (c) => c.id === "delete_char_back",
          );
          if (insertIdx >= 0) {
            migrated.commands.splice(insertIdx + 1, 0, baseCommand);
          } else {
            migrated.commands.push(baseCommand);
          }
          log("Added toggle_case_char command (~) during migration");
        }
      }
    }

    // Save migrated config back to storage
    try {
      API.storage.local.set({ motionsConfig: migrated });
    } catch (e) {
      console.warn("Failed to save migrated config", e);
    }

    return migrated;
  }

  async function loadConfig() {
    try {
      const base = await window.loadVimMotionsConfig();
      // Read debug flag and useDisplayLines from sync (small, sync-friendly)
      try {
        API.storage.sync.get(["debug", "useDisplayLines"], (data) => {
          debug = !!(data && data.debug);
          useDisplayLines = !!(data && data.useDisplayLines);
          try {
            window.__VIM_DEBUG__ = debug;
          } catch (_) {}
          try {
            window.__VIM_USE_DISPLAY_LINES__ = useDisplayLines;
          } catch (_) {}
        });
      } catch (_) {}

      // Read motionsConfig from local storage first, with a legacy sync fallback
      return new Promise((resolve) => {
        try {
          API.storage.local.get(["motionsConfig"], (localData) => {
            const finishWith = (src) => {
              if (!src) {
                resolve(base);
                return;
              }
              try {
                const parsed = typeof src === "string" ? JSON.parse(src) : src;
                const error = window.VimConfig.validate(parsed);
                if (error) throw new Error(error);
                const migrated = migrateConfig(parsed, base);
                resolve(migrated);
              } catch (e) {
                console.warn(
                  "Invalid motionsConfig in storage, using base file",
                  e,
                );
                resolve(base);
              }
            };

            if (localData && typeof localData.motionsConfig !== "undefined") {
              finishWith(localData.motionsConfig);
            } else {
              // Legacy fallback: look in sync storage if nothing is in local
              try {
                API.storage.sync.get(["motionsConfig"], (syncData) => {
                  if (
                    syncData &&
                    typeof syncData.motionsConfig !== "undefined"
                  ) {
                    finishWith(syncData.motionsConfig);
                  } else {
                    resolve(base);
                  }
                });
              } catch (e) {
                resolve(base);
              }
            }
          });
        } catch (e) {
          resolve(base);
        }
      });
    } catch (e) {
      console.error("Failed to load motions config", e);
      return {
        motions: [],
        operators: [],
        textObjects: [],
        operatorSelf: [],
        settings: {},
      };
    }
  }

  async function init() {
    const cfg = await loadConfig();
    parser = new window.VimMotionParser(cfg);
    log("Initialized with config", cfg);
    injectPageScript();
    attachKeyListener();
    try {
      API.storage.sync.get(["theme", "enabled"], (data) => {
        try {
          uiTheme = data && data.theme ? data.theme : "vim";
        } catch (_) {
          uiTheme = "vim";
        }
        try {
          vimEnabled =
            data && typeof data.enabled !== "undefined" ? !!data.enabled : true;
        } catch (_) {
          vimEnabled = true;
        }
        if (ui) ui.setTheme(uiTheme);
        try {
          if (ui && ui.ind) ui.ind.style.display = vimEnabled ? "" : "none";
        } catch (_) {}
      });
    } catch (_) {}
    try {
      ui = new VimUIV2();
      ui.setTheme(uiTheme);
      setMode(mode);
      try {
        if (ui && ui.ind) ui.ind.style.display = vimEnabled ? "" : "none";
      } catch (_) {}
    } catch (_) {}

    // Apply settings instantly when changed from popup/advanced (no tabs permission required)
    try {
      API.storage.onChanged.addListener((changes, area) => {
        // Sync-scoped settings (small, safe to sync)
        if (area === "sync") {
          if (changes && changes.debug) {
            try {
              debug = !!changes.debug.newValue;
              window.__VIM_DEBUG__ = debug;
            } catch (_) {}
            log("Debug changed via storage", debug);
          }
          if (changes && changes.useDisplayLines) {
            try {
              useDisplayLines = !!changes.useDisplayLines.newValue;
              window.__VIM_USE_DISPLAY_LINES__ = useDisplayLines;
            } catch (_) {}
            log("useDisplayLines changed via storage", useDisplayLines);
          }
          if (changes && changes.theme) {
            try {
              uiTheme = changes.theme.newValue || "vim";
              if (ui) ui.setTheme(uiTheme);
            } catch (_) {}
          }
          if (changes && changes.enabled) {
            try {
              if (insertPending.length) flushInsertMapping();
              vimEnabled = !!changes.enabled.newValue;
              if (ui && ui.ind) ui.ind.style.display = vimEnabled ? "" : "none";
            } catch (_) {}
          }
        }

        // motionsConfig can come from either sync (legacy) or local (new)
        if (changes && changes.motionsConfig) {
          try {
            const nv = changes.motionsConfig.newValue;
            if (typeof nv !== "undefined") {
              const newCfg = typeof nv === "string" ? JSON.parse(nv) : nv;
              applyConfig(newCfg);
              log("Applied updated motions config from storage");
            } else {
              // removed: fall back to base file
              loadConfig().then((baseCfg) => {
                applyConfig(baseCfg);
                log("Reverted to base motions config");
              });
            }
          } catch (e) {
            console.warn("Failed to apply motionsConfig change", e);
          }
        }
      });
    } catch (_) {}

    // Allow live reload via message
    API.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.action === "reloadMotionsConfig") {
        loadConfig().then((newCfg) => {
          applyConfig(newCfg);
          log("Reloaded config");
          sendResponse({ ok: true });
        });
        return true;
      } else if (msg && msg.action === "updateSettings" && msg.settings) {
        try {
          if (typeof msg.settings.debug !== "undefined") {
            debug = !!msg.settings.debug;
            try {
              window.__VIM_DEBUG__ = debug;
            } catch (_) {}
          }
          if (typeof msg.settings.theme !== "undefined") {
            uiTheme = msg.settings.theme || "vim";
            if (ui) ui.setTheme(uiTheme);
          }
          log("Updated debug setting", debug);
          sendResponse({ ok: true });
        } catch (e) {
          console.warn("Failed to apply settings update", e);
          sendResponse({ ok: false, error: String(e) });
        }
        return true;
      }
      return false;
    });

    // Persist last-exit position when the tab/window is closing
    try {
      window.addEventListener("beforeunload", () => {
        try {
          executor.exec({
            kind: "command",
            command: { id: "record_last_exit" },
            count: 1,
          });
        } catch (_) {}
      });
    } catch (_) {}
  }

  // Simple mode manager used by executor
  function setMode(newMode) {
    if (newMode === 'insert' && mode !== 'insert') resetInsertOps();
    mode = newMode;
    try {
      if (parser && typeof parser.setMode === "function")
        parser.setMode(newMode);
    } catch (_) {}
    if (debug) console.log("[VimMode] ->", mode, tempNormal ? "(temp)" : "");
    try {
      if (ui) {
        ui.setTempNormal(!!tempNormal);
        ui.setReplaceMode(!!replaceMode);
        ui.setMode(mode);
        ui.updateCursorStyle();
      }
    } catch (_) {}
  }
  const modeAPI = {
    setMode: (m) => {
      setMode(m);
    },
    getMode: () => mode,
    isVisual: () => mode === "visual" || mode === "visualLine",
    getReplaceMode: () => replaceMode,
    setReplaceMode: (v) => {
      replaceMode = !!v;
      try {
        if (ui) ui.setReplaceMode(replaceMode);
      } catch (_) {}
    },
  };
  const settingsAPI = {
    getUseDisplayLines: () => useDisplayLines,
  };
  // Initialize executor early so it is available in init
  executor = window.createVimExecutor(modeAPI, settingsAPI);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
