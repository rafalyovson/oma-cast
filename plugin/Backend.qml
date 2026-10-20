import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "core/Rpc.js" as Rpc
import "core/Paths.js" as Paths
import "core/Log.js" as Log
import "core/Schema.js" as Schema
import "core/Ranker.js" as Ranker
import "core/Frecency.js" as Frecency
import "core/OmarchyMenu.js" as OmarchyMenu
import "core/RootSearch.js" as RootSearch
import "core/Quicklinks.js" as Quicklinks
import "services"

// The clone's backend, in-process (SPEC §2.0). It owns the paths, the host
// config, the persisted documents, the root-search providers and the method
// registry; the launcher UI and the IPC handler both go through call().
Item {
  id: backend

  readonly property string version: "0.1.0"
  readonly property var paths: Paths.resolve(function(name) { return Quickshell.env(name) })
  readonly property string desktop: Quickshell.env("HYPRLAND_INSTANCE_SIGNATURE") ? "hyprland" : "unknown"

  // Omarchy's shared app library (shell.appLibrary), injected by Launcher.qml.
  property var appLibrary: null
  // Asks the shell to summon a plugin in-process; injected by Launcher.qml.
  property var summon: null

  property var config: Schema.withConfigDefaults(null)
  property bool directoriesReady: false
  readonly property bool ready: directoriesReady && settingsStore.loaded && frecencyStore.loaded
  property var pendingQuicklink: null

  readonly property var registry: Rpc.createRegistry()
  readonly property double startedAt: Date.now()
  readonly property var deps: ({ Ranker: Ranker, Frecency: Frecency, OmarchyMenu: OmarchyMenu })

  // Every root-search candidate, rebuilt when a provider changes.
  property var candidates: []
  property var candidatesById: ({})
  property int candidatesRevision: 0
  readonly property bool loading: menuSource.loading

  signal notification(string method, var data)
  // Fired after a clipboard read finishes and the quicklink actually opens.
  signal quicklinkReady(var outcome)

  // ------------------------------------------------------------- dispatch

  function call(method, data) { return Rpc.call(backend.registry, method, data) }
  function callSync(method, data) { return Rpc.callSync(backend.registry, method, data) }
  function subscribe(method, callback) { return Rpc.subscribe(backend.registry, method, callback) }

  function emit(method, data) {
    Rpc.emit(backend.registry, method, data, function(m, error) {
      backend.log("error", "rpc", "subscriber of " + m + " threw: " + error)
    })
    backend.notification(method, data)
  }

  function log(level, category, message, metadata) {
    if (!Log.shouldLog(level, backend.config.logLevel)) return
    var line = Log.format(level, category, message, metadata)
    var i = Log.levelIndex(level)
    if (i >= Log.levelIndex("error")) console.error(line)
    else if (i >= Log.levelIndex("warning")) console.warn(line)
    else if (i >= Log.levelIndex("info")) console.info(line)
    else console.log(line)
  }

  // ------------------------------------------------------------ candidates

  function appEntries() {
    if (backend.appLibrary) return backend.appLibrary.sortedEntries("").map(function(row) { return row.entry })
    // Outside a menu-kind load the shell hands us no library; read entries directly.
    return (DesktopEntries.applications.values || []).filter(function(e) { return !e.noDisplay })
  }

  function rebuildCandidates() {
    var next = []
    var apps = backend.appEntries()
    for (var i = 0; i < apps.length; i++) if (apps[i] && apps[i].id) next.push(RootSearch.appCandidate(apps[i]))
    next = next.concat(RootSearch.menuCandidates(menuSource.tree, menuSource.guards, menuSource.providerItems, backend.deps))
    for (var b = 0; b < RootSearch.BUILTINS.length; b++) next.push(RootSearch.builtinCandidate(RootSearch.BUILTINS[b]))
    if (quicklinksStore.loaded) {
      var links = Quicklinks.candidateItems(quicklinksStore.doc)
      for (var q = 0; q < links.length; q++) {
        var row = backend.quicklinkCandidate(links[q])
        if (row) next.push(row)
      }
    }
    var byId = ({})
    for (var j = 0; j < next.length; j++) byId[next[j].id] = next[j]
    backend.candidates = next
    backend.candidatesById = byId
    backend.candidatesRevision++
  }

  Timer {
    id: rebuildTimer
    interval: 30
    onTriggered: backend.rebuildCandidates()
  }

  function searchContext() {
    return {
      commands: settingsStore.loaded ? settingsStore.doc.commands : ({}),
      frecency: frecencyStore.loaded ? frecencyStore.doc.items : ({}),
      nowMs: Date.now(),
      sensitivity: settingsStore.loaded ? settingsStore.doc.general.rootSearchSensitivity : "medium"
    }
  }

  function decorated(id) {
    var c = backend.candidatesById[id]
    return c ? RootSearch.decorate(c, backend.searchContext(), backend.deps) : null
  }

  // ------------------------------------------------------------- execution

  // The shell lets a third-party plugin summon only itself in-process, so
  // other plugins (omarchy.menu, omarchy.clipboard) go through its CLI.
  function summonPlugin(id, payload) {
    if (backend.summon && backend.summon(id, payload)) return
    Quickshell.execDetached(["omarchy-shell", "shell", "summon", id, payload || "{}"])
  }

  function runShell(command) {
    var summon = OmarchyMenu.summonAction(command)
    if (summon) backend.summonPlugin(summon.id, summon.payload)
    else Util.execDetached(command)
  }

  function recordVisit(id, query) {
    if (!frecencyStore.loaded) return
    frecencyStore.update(function(doc) {
      doc.items[id] = Frecency.recordVisit(doc.items[id] || null, Date.now(), query || "")
      if (query) doc.searchHistory = Schema.pushSearchHistory(doc.searchHistory, query)
    })
  }

  function updateCommand(id, mutator) {
    settingsStore.update(function(doc) {
      var current = doc.commands[id] || {}
      var next = mutator(JSON.parse(JSON.stringify(current)))
      var empty = true
      for (var k in next) if (next[k] !== null && next[k] !== undefined && next[k] !== "") empty = false
      if (empty) delete doc.commands[id]
      else doc.commands[id] = next
    })
    backend.emit("settings.commandSettingsChanged", { commandId: id })
  }

  // The parent menu an action lives in, for "Open in Omarchy Menu".
  function omarchyRouteFor(candidate) {
    if (candidate.kind === "omarchy-action") {
      var item = menuSource.tree.items[candidate.menuId]
      return item && item.parent ? item.parent : "root"
    }
    return candidate.kind === "omarchy-link" ? candidate.target : candidate.menuId
  }

  function quicklinkCandidate(item) {
    return Quicklinks.toCandidate(item, { favicons: backend.config.quicklinkFavicons === true })
  }

  function quicklinkById(id) {
    if (!quicklinksStore.loaded) return null
    return Quicklinks.get(quicklinksStore.doc, id)
  }

  function quicklinkForm(mode, item) {
    return {
      kind: "quicklink-form",
      mode: mode,
      quicklinkId: item && item.id ? item.id : "",
      title: mode === "edit" ? "Edit Quicklink" : "Create Quicklink",
      focus: 0,
      fields: [
        { key: "name", label: "Name", value: item && item.name ? item.name : "" },
        { key: "link", label: "Link", value: item && item.link ? item.link : "" },
        { key: "openWith", label: "Open with", value: item && item.openWith ? item.openWith : "" }
      ]
    }
  }

  function argumentForm(item, parsed) {
    return {
      kind: "quicklink-args",
      quicklinkId: item.id,
      title: item.name,
      focus: 0,
      fields: parsed.arguments.map(function(arg) {
        var label = arg.name
        if (arg.options && arg.options.length)
          label = arg.name + " (" + arg.options.map(function(option) { return option.title }).join(", ") + ")"
        return { key: arg.name, label: label, value: arg.defaultValue || "" }
      })
    }
  }

  // hasArgs is true once the argument form has been submitted, even if a value is empty.
  function openQuicklink(candidate, args, hasArgs) {
    var item = backend.quicklinkById(candidate.quicklinkId || String(candidate.id || "").replace(/^quicklink:/, ""))
    if (!item) return { toast: { style: "failure", title: "Quicklink not found" } }
    var parsed = Quicklinks.parseLink(item.link)
    if (parsed.error) return { toast: { style: "failure", title: parsed.error } }
    if (parsed.arguments.length > 0 && !hasArgs) return { push: backend.argumentForm(item, parsed) }
    var values = args || ({})
    for (var i = 0; i < parsed.arguments.length; i++) {
      var arg = parsed.arguments[i]
      if (values[arg.name] == null || values[arg.name] === "") {
        if (arg.defaultValue) values[arg.name] = arg.defaultValue
        else if (arg.required) return { toast: { style: "failure", title: arg.name + " is required" } }
      }
    }
    if (parsed.needsClipboard) {
      backend.pendingQuicklink = { candidate: candidate, openWith: item.openWith || "", link: item.link, values: values }
      if (!pasteProc.running) {
        pasteProc.sawExit = false
        pasteProc.running = true
      }
      return { wait: true }
    }
    return backend.launchQuicklink(candidate, item.openWith || "", item.link, values, "")
  }

  function launchQuicklink(candidate, openWith, link, values, clipboard) {
    var expanded = Quicklinks.expand(link, {
      now: Date.now(),
      arguments: values,
      clipboard: clipboard ? [clipboard] : [],
      selection: "",
      uuid: Quicklinks.randomUuid()
    })
    if (!expanded.ok) return { toast: { style: "failure", title: expanded.error || "Could not expand link" } }
    var argv = Quicklinks.openArgv(openWith, expanded.url, backend.paths.home)
    if (!argv) {
      var target = String(expanded.url || "").trim()
      var title = !target || target.charAt(0) === "-" ? "Link cannot start with -" : "Open with must be a desktop id"
      return { toast: { style: "failure", title: title } }
    }
    Util.execArgv(argv)
    backend.recordVisit(candidate.id, "")
    return { close: true }
  }

  function openBrowser(url) {
    var argv = Quicklinks.browserArgv(url)
    if (!argv) return { toast: { style: "failure", title: "Link cannot start with -" } }
    Util.execArgv(argv)
    return { close: true }
  }

  function finishClipboardOpen(text) {
    var pending = backend.pendingQuicklink
    if (!pending) return
    backend.pendingQuicklink = null
    backend.quicklinkReady(backend.launchQuicklink(pending.candidate, pending.openWith, pending.link, pending.values, text))
  }

  function quicklinkCommand(name) {
    if (name === "create") return { push: backend.quicklinkForm("create", null) }
    if (name === "search") return { push: { kind: "quicklinks", title: "Quicklinks" } }
    if (name === "import") return { push: { kind: "quicklink-import", title: "Import Quicklinks", value: "" } }
    if (name === "export") return backend.exportQuicklinks()
    return { toast: { style: "failure", title: "Unknown quicklink command" } }
  }

  function exportQuicklinks() {
    if (!quicklinksStore.loaded) return { toast: { style: "failure", title: "Quicklinks are not loaded" } }
    var path = backend.paths.db + "/quicklinks-export.json"
    var json = JSON.stringify(Quicklinks.exportList(quicklinksStore.doc), null, 2) + "\n"
    exportFile.failed = false
    exportFile.errorText = ""
    exportFile.path = path
    exportFile.setText(json)
    // blockWrites makes FileView.saveSync emit saveFailed before setText
    // returns when it records an error (Quickshell 0.3.2). An atomic commit
    // failure does not set that error, and setText returns without writing
    // when the text is unchanged, so the bytes on disk are checked too.
    if (exportFile.failed) return { toast: { style: "failure", title: "Could not write " + path + ": " + exportFile.errorText } }
    var written = backend.readTextFile(path)
    if (written.error || written.text !== json) {
      var detail = written.error ? ": " + written.error : ""
      return { toast: { style: "failure", title: "Could not write " + path + detail } }
    }
    // wl-copy takes the file on stdin. Passing the JSON as an argument
    // fails once the library is over about 128 KiB, and the toast used to
    // say the copy had worked.
    copyProc.wrotePath = path
    copyProc.sawExit = false
    copyProc.command = ["sh", "-c", "wl-copy < \"$1\"", "wl-copy", path]
    copyProc.running = true
    return { wait: true }
  }

  function readTextFile(path) {
    importFile.readError = ""
    if (importFile.path === path) importFile.reload()
    else importFile.path = path
    var text = importFile.text()
    if (importFile.readError) return { error: importFile.readError, text: "" }
    return { error: "", text: text }
  }

  function importQuicklinksText(text) {
    if (!quicklinksStore.loaded) throw new Error("quicklinks not loaded")
    if (quicklinksStore.readOnly) throw new Error("quicklinks are read-only")
    var raw = String(text || "").trim()
    if (!raw) throw new Error("Paste a JSON array or a file path")
    var body = raw
    if (raw.charAt(0) !== "[" && raw.charAt(0) !== "{") {
      var path = raw
      if (path === "~" || path.indexOf("~/") === 0) path = backend.paths.home + path.slice(1)
      var read = backend.readTextFile(path)
      if (read.error) throw new Error("Could not read " + path + ": " + read.error)
      body = read.text
    }
    var result = Quicklinks.importText(quicklinksStore.doc, body, { now: Date.now() })
    if (result.error) throw new Error(result.error)
    quicklinksStore.update(function() { return result.doc })
    backend.emit("quicklinks.updated", null)
    return { added: result.added, skipped: result.skipped }
  }

  function urlAction(id, query) {
    var url = RootSearch.normalizedUrl(query)
    if (id === "url:open") return backend.openBrowser(url)
    return { push: backend.quicklinkForm("create", { link: url }) }
  }

  // One action on one row. Returns what the UI should do next:
  // { close, push: {view}, toast: {style, title}, hud: "text" }.
  function performAction(data) {
    var id = String(data && data.id || "")
    var action = String(data && data.action || "open")
    var query = String(data && data.query || "").trim()
    var candidate = backend.decorated(id)
    if (!candidate) throw new Error("Unknown command " + id)

    if (action === "open") {
      switch (candidate.kind) {
        case "app":
          backend.recordVisit(id, query)
          if (backend.appLibrary) backend.appLibrary.launch(candidate.appId, candidate.title)
          else Util.execArgv(["uwsm-app", "--", "gtk-launch", candidate.appId + ".desktop"])
          return { close: true }
        case "omarchy-action":
          if (candidate.disabled) return { toast: { style: "failure", title: candidate.title + " is already set up" } }
          backend.recordVisit(id, query)
          backend.runShell(candidate.action)
          return { close: true }
        case "omarchy-menu":
          backend.recordVisit(id, query)
          return { push: { kind: "menu", menuId: candidate.menuId, title: candidate.title } }
        case "omarchy-link":
          backend.recordVisit(id, query)
          var target = menuSource.tree.items[candidate.target]
          if (!target) return { toast: { style: "failure", title: "Menu " + candidate.target + " not found" } }
          return { push: { kind: "menu", menuId: target.id, title: target.label } }
        case "builtin":
          backend.recordVisit(id, query)
          if (candidate.run && candidate.run.quicklink) return backend.quicklinkCommand(candidate.run.quicklink)
          if (candidate.run && candidate.run.summon) backend.summonPlugin(candidate.run.summon, candidate.run.payload || "{}")
          return { close: true }
        case "quicklink":
          return backend.openQuicklink(candidate, null, false)
        case "fallback":
          return backend.openBrowser(RootSearch.fallbackUrl(candidate, query))
      }
      throw new Error("Cannot open " + id)
    }

    switch (action) {
      case "open-in-omarchy-menu":
        backend.summonPlugin("omarchy.menu", JSON.stringify({ menu: backend.omarchyRouteFor(candidate) }))
        return { close: true }
      case "copy-command":
      case "copy-id":
      case "copy-link":
        var copied = action === "copy-id" ? candidate.appId + ".desktop" : (action === "copy-link" ? (candidate.link || candidate.subtitle || "") : candidate.action)
        Util.execArgv(["wl-copy", "--", copied])
        return { close: true, hud: "Copied to Clipboard" }
      case "edit-quicklink":
        var editing = backend.quicklinkById(candidate.quicklinkId)
        if (!editing) return { toast: { style: "failure", title: "Quicklink not found" } }
        return { push: backend.quicklinkForm("edit", editing) }
      case "delete-quicklink":
        return { push: { kind: "confirm-delete-quicklink", quicklinkId: candidate.quicklinkId, title: "Delete " + candidate.title + "?" } }
      case "favorite-add":
      case "favorite-remove":
      case "favorite-up":
      case "favorite-down":
        var orders = RootSearch.reorderFavorites(settingsStore.doc.commands, id, action)
        settingsStore.update(function(doc) {
          for (var key in orders) {
            var entry = doc.commands[key] || {}
            if (orders[key] === null) delete entry.favoriteOrder
            else entry.favoriteOrder = orders[key]
            if (Object.keys(entry).length === 0) delete doc.commands[key]
            else doc.commands[key] = entry
          }
        })
        var titles = { "favorite-add": "Added to Favorites", "favorite-remove": "Removed from Favorites", "favorite-up": "Moved Up", "favorite-down": "Moved Down" }
        return { toast: { style: "success", title: titles[action] } }
      case "set-alias":
        return { push: { kind: "alias", commandId: id, title: "Alias for " + candidate.title, value: candidate.alias } }
      case "remove-alias":
        backend.updateCommand(id, function(s) { delete s.alias; return s })
        return { toast: { style: "success", title: "Alias removed" } }
      case "reset-ranking":
        frecencyStore.update(function(doc) { delete doc.items[id] })
        return { toast: { style: "success", title: "Ranking reset" } }
      case "disable":
        backend.updateCommand(id, function(s) { s.enabled = false; return s })
        return { toast: { style: "success", title: candidate.title + " disabled" } }
    }
    throw new Error("Unknown action " + action)
  }

  // ------------------------------------------------------------- services

  function registerServices() {
    Rpc.register(backend.registry, "system", {
      // Raycast's probe answers with nothing [O]; the round trip is the point.
      healthPing: function() { return null },
      healthDatabase: function() {
        var t0 = Date.now()
        JSON.stringify(settingsStore.doc)
        JSON.stringify(frecencyStore.doc)
        JSON.stringify(quicklinksStore.doc)
        return {
          workMs: Date.now() - t0,
          settings: { loaded: settingsStore.loaded, readOnly: settingsStore.readOnly, error: settingsStore.lastError },
          frecency: { loaded: frecencyStore.loaded, readOnly: frecencyStore.readOnly, error: frecencyStore.lastError },
          quicklinks: { loaded: quicklinksStore.loaded, readOnly: quicklinksStore.readOnly, error: quicklinksStore.lastError },
          // Kept for Phase 0 callers.
          loaded: settingsStore.loaded, readOnly: settingsStore.readOnly, error: settingsStore.lastError
        }
      },
      info: function() {
        return {
          version: backend.version,
          desktop: backend.desktop,
          ready: backend.ready,
          uptimeMs: Date.now() - backend.startedAt,
          candidates: backend.candidates.length,
          appLibrary: !!backend.appLibrary,
          methods: Rpc.methods(backend.registry)
        }
      },
      getPaths: function() { return backend.paths }
    })

    Rpc.register(backend.registry, "settings", {
      getGeneralSettings: function() {
        if (!settingsStore.loaded) throw new Error("settings not loaded")
        return settingsStore.doc.general
      },
      // Partial update; only known keys with a matching type are accepted.
      updateGeneralSettings: function(data) {
        if (!settingsStore.loaded) throw new Error("settings not loaded")
        if (settingsStore.readOnly) throw new Error("settings are read-only: " + (settingsStore.lastError || "written by a newer build"))
        var patch = data && typeof data === "object" ? data : {}
        var current = settingsStore.doc.general
        for (var key in patch) {
          if (current[key] === undefined) throw new Error("Unknown general setting " + key)
          if (typeof patch[key] !== typeof current[key]) throw new Error("Setting " + key + " must be a " + typeof current[key])
        }
        settingsStore.update(function(doc) { for (var k in patch) doc.general[k] = patch[k] })
        backend.emit("settings.generalSettingsChanged", settingsStore.doc.general)
        return settingsStore.doc.general
      },
      getAllCommandSettings: function() { return settingsStore.doc.commands },
      getCommandSettings: function(data) { return settingsStore.doc.commands[String(data && data.commandId || "")] || {} },
      // {commandId, alias?, enabled?}; null clears a field. [O name]
      updateCommandSettings: function(data) {
        var id = String(data && data.commandId || "")
        if (!backend.candidatesById[id]) throw new Error("Unknown command " + id)
        if (data.alias !== undefined && data.alias !== null) {
          var alias = String(data.alias).trim().toLowerCase()
          if (/\s/.test(alias)) throw new Error("An alias cannot contain spaces")
          var commands = settingsStore.doc.commands
          for (var other in commands) {
            if (other !== id && commands[other].alias === alias && alias) throw new Error("Alias “" + alias + "” is already used by " + ((backend.candidatesById[other] || {}).title || other))
          }
        }
        backend.updateCommand(id, function(s) {
          if (data.alias !== undefined) { if (data.alias) s.alias = String(data.alias).trim().toLowerCase(); else delete s.alias }
          if (data.enabled !== undefined) { if (data.enabled === false) s.enabled = false; else delete s.enabled }
          return s
        })
        return settingsStore.doc.commands[id] || {}
      }
    })

    Rpc.register(backend.registry, "rootSearch", {
      // {query, view?: {kind:"menu", menuId}} -> sections of plain rows.
      search: function(data) {
        var query = String(data && data.query || "")
        var view = data && data.view
        var ctx = backend.searchContext()
        var sections = view && view.kind === "menu"
          ? RootSearch.submenuSections(backend.candidates, view.menuId, query, ctx, backend.deps)
          : view && view.kind === "quicklinks"
            ? RootSearch.quicklinkSections(backend.candidates, query, ctx, backend.deps)
            : RootSearch.rootSections(backend.candidates, query, ctx, backend.deps)
        return sections.map(function(s) {
          return { id: s.id, title: s.title, rows: s.rows.map(function(r) { return r.candidate }) }
        })
      },
      getActions: function(data) {
        var rowId = String(data && data.id || "")
        if (rowId === "url:open") return RootSearch.actionsFor({ kind: "url-open", title: "Open in Browser" })
        if (rowId === "url:create") return RootSearch.actionsFor({ kind: "url-create", title: "Create Quicklink" })
        var candidate = backend.decorated(rowId)
        if (!candidate) {
          var fallback = RootSearch.FALLBACKS.filter(function(f) { return f.id === data.id })[0]
          if (!fallback) throw new Error("Unknown command " + (data && data.id))
          return RootSearch.actionsFor({ kind: "fallback", title: fallback.title })
        }
        return RootSearch.actionsFor(candidate)
      },
      performAction: function(data) {
        var rowId = String(data && data.id || "")
        if (rowId === "url:open" || rowId === "url:create") return backend.urlAction(rowId, String(data && data.query || ""))
        // Fallbacks are rows, not stored candidates.
        var fallback = RootSearch.FALLBACKS.filter(function(f) { return f.id === (data && data.id) })[0]
        if (fallback) return backend.openBrowser(RootSearch.fallbackUrl(fallback, data.query))
        return backend.performAction(data)
      },
      getSearchHistory: function() { return frecencyStore.loaded ? frecencyStore.doc.searchHistory : [] }
    })

    Rpc.register(backend.registry, "quicklinks", {
      list: function() { return quicklinksStore.loaded ? Quicklinks.list(quicklinksStore.doc) : [] },
      getQuicklink: function(data) {
        var item = backend.quicklinkById(String(data && data.id || ""))
        if (!item) throw new Error("Quicklink not found")
        return item
      },
      save: function(data) {
        if (!quicklinksStore.loaded) throw new Error("quicklinks not loaded")
        if (quicklinksStore.readOnly) throw new Error("quicklinks are read-only")
        var result = Quicklinks.save(quicklinksStore.doc, data || {}, { now: Date.now() })
        if (result.error) throw new Error(result.error)
        quicklinksStore.update(function() { return result.doc })
        backend.emit("quicklinks.updated", { id: result.item.id })
        return result.item
      },
      update: function(data) {
        if (!quicklinksStore.loaded) throw new Error("quicklinks not loaded")
        if (quicklinksStore.readOnly) throw new Error("quicklinks are read-only")
        var result = Quicklinks.update(quicklinksStore.doc, data || {}, { now: Date.now() })
        if (result.error) throw new Error(result.error)
        quicklinksStore.update(function() { return result.doc })
        backend.emit("quicklinks.updated", { id: result.item.id })
        return result.item
      },
      "delete": function(data) {
        if (!quicklinksStore.loaded) throw new Error("quicklinks not loaded")
        if (quicklinksStore.readOnly) throw new Error("quicklinks are read-only")
        var id = String(data && data.id || "")
        var result = Quicklinks.remove(quicklinksStore.doc, id)
        if (result.error) throw new Error(result.error)
        quicklinksStore.update(function() { return result.doc })
        backend.emit("quicklinks.updated", { id: id })
        return null
      },
      "import": function(data) { return backend.importQuicklinksText(data && data.text) },
      "export": function() {
        var outcome = backend.exportQuicklinks()
        if (outcome.toast && outcome.toast.style === "failure") throw new Error(outcome.toast.title)
        return { path: backend.paths.db + "/quicklinks-export.json" }
      },
      open: function(data) {
        var id = String(data && (data.id || data.quicklinkId) || "")
        var candidate = backend.candidatesById["quicklink:" + id]
        if (!candidate) {
          var item = backend.quicklinkById(id)
          if (!item) throw new Error("Quicklink not found")
          candidate = backend.quicklinkCandidate(item)
        }
        var supplied = data && (data.values || data.arguments)
        var hasArgs = !!supplied
        return backend.openQuicklink(candidate, hasArgs ? supplied : null, hasArgs)
      }
    })

    Rpc.register(backend.registry, "frecency", {
      visit: function(data) { backend.recordVisit(String(data.id), String(data.query || "")); return null },
      get: function(data) {
        var entry = frecencyStore.doc.items[String(data && data.id || "")]
        return entry ? { anchor: entry.anchor, openedAt: entry.openedAt, score: Frecency.score(entry.anchor, Date.now() / 1000), searchTerms: entry.searchTerms } : null
      }
    })
  }

  Component.onCompleted: {
    registerServices()
    mkdirs.running = true
  }

  onAppLibraryChanged: rebuildTimer.restart()

  Connections {
    target: backend.appLibrary
    ignoreUnknownSignals: true
    function onAppsChanged() { rebuildTimer.restart() }
  }

  Connections {
    target: backend.appLibrary ? null : DesktopEntries.applications
    ignoreUnknownSignals: true
    function onValuesChanged() { rebuildTimer.restart() }
  }

  // Guards and providers describe live system state. Refreshing them starts
  // a few hundred milliseconds of scripts, so wait until the layer has mapped.
  // A toggle that hides again before then never starts them.
  Component.onDestruction: { settingsStore.flush(); frecencyStore.flush(); quicklinksStore.flush() }
  onNotification: function(method, data) {
    if (method !== "window.visibilityChanged") return
    if (data && data.visible) menuRefreshTimer.restart()
    else menuRefreshTimer.stop()
  }

  Timer {
    id: menuRefreshTimer
    interval: 500
    onTriggered: menuSource.refresh()
  }

  // ------------------------------------------------------------ persistence

  Process {
    id: mkdirs
    command: ["mkdir", "-p"].concat(Paths.directoriesToCreate(backend.paths))
    onExited: function(exitCode) {
      if (exitCode !== 0) backend.log("error", "paths", "could not create data directories", { exitCode: exitCode })
      backend.directoriesReady = true
    }
  }

  OmarchyMenuSource {
    id: menuSource
    onRevisionChanged: rebuildTimer.restart()
    onMessage: function(level, text, metadata) { backend.log(level, "omarchy-menu", text, metadata) }
  }

  JsonStore {
    id: settingsStore
    ready: backend.directoriesReady
    path: backend.paths.db + "/" + Schema.documents.settings.file
    migrations: Schema.documents.settings.migrations
    onMessage: function(level, text, metadata) { backend.log(level, "store", text, metadata) }
  }

  JsonStore {
    id: frecencyStore
    ready: backend.directoriesReady
    path: backend.paths.db + "/" + Schema.documents.frecency.file
    migrations: Schema.documents.frecency.migrations
    onMessage: function(level, text, metadata) { backend.log(level, "store", text, metadata) }
  }

  // Bumped whenever ranking inputs change, so views re-query.
  readonly property int dataRevision: candidatesRevision + (settingsStore.loaded ? 1 : 0) + (frecencyStore.loaded ? 1 : 0) + (quicklinksStore.loaded ? 1 : 0)
  property int storeRevision: 0
  Connections { target: settingsStore; function onChanged() { backend.storeRevision++ } }
  Connections { target: frecencyStore; function onChanged() { backend.storeRevision++ } }
  Connections { target: quicklinksStore; function onChanged() { backend.storeRevision++; rebuildTimer.restart() } }

  JsonStore {
    id: quicklinksStore
    ready: backend.directoriesReady
    path: backend.paths.db + "/" + Schema.documents.quicklinks.file
    migrations: Schema.documents.quicklinks.migrations
    onMessage: function(level, text, metadata) { backend.log(level, "store", text, metadata) }
  }

  FileView {
    id: exportFile
    printErrors: false
    atomicWrites: true
    blockWrites: true
    property bool failed: false
    property string errorText: ""
    onSaved: exportFile.failed = false
    onSaveFailed: function(error) {
      exportFile.failed = true
      exportFile.errorText = FileViewError.toString(error)
    }
  }

  FileView {
    id: importFile
    printErrors: false
    blockAllReads: true
    property string readError: ""
    onLoaded: importFile.readError = ""
    onLoadFailed: function(error) { importFile.readError = FileViewError.toString(error) }
  }

  Process {
    id: copyProc
    property bool sawExit: false
    property string wrotePath: ""
    onExited: function(exitCode) {
      copyProc.sawExit = true
      var path = copyProc.wrotePath
      if (exitCode === 0) backend.quicklinkReady({ toast: { style: "success", title: "Wrote " + path + " and copied it to the clipboard" } })
      else backend.quicklinkReady({ toast: { style: "failure", title: "Wrote " + path + " but could not copy it to the clipboard" } })
    }
    // FailedToStart changes `running` and does not emit exited.
    onRunningChanged: {
      if (copyProc.running || copyProc.sawExit || !copyProc.wrotePath) return
      Qt.callLater(function() {
        if (copyProc.running || copyProc.sawExit || !copyProc.wrotePath) return
        var path = copyProc.wrotePath
        copyProc.wrotePath = ""
        backend.quicklinkReady({ toast: { style: "failure", title: "Wrote " + path + " but could not copy it to the clipboard" } })
      })
    }
  }

  Process {
    id: pasteProc
    property bool sawExit: false
    command: ["wl-paste", "-n", "--type", "text/plain"]
    stdout: StdioCollector { id: pasteOut }
    // streamFinished runs inside the exit path, before this signal. Launch only here.
    onExited: function(exitCode) {
      pasteProc.sawExit = true
      backend.finishClipboardOpen(exitCode === 0 ? String(pasteOut.text || "") : "")
    }
    onRunningChanged: {
      if (pasteProc.running || pasteProc.sawExit || !backend.pendingQuicklink) return
      Qt.callLater(function() {
        if (!pasteProc.running && !pasteProc.sawExit && backend.pendingQuicklink) backend.finishClipboardOpen("")
      })
    }
  }

  // config.json is optional and hand-edited; it hot-reloads on save.
  FileView {
    path: backend.directoriesReady ? backend.paths.configFile : ""
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try {
        backend.config = Schema.withConfigDefaults(JSON.parse(text()))
      } catch (e) {
        backend.config = Schema.withConfigDefaults(null)
        backend.log("warning", "config", "ignoring unreadable " + path + ": " + e)
      }
    }
    onLoadFailed: backend.config = Schema.withConfigDefaults(null)
  }
}
