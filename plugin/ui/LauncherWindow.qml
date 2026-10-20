import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import qs.Ui

// Launcher surface (SPEC §5.1, §10.2): 750×475 at uiZoom 1, 66 px search
// header, 42 px footer, centred horizontally about a quarter down the
// screen, coloured by the active Omarchy theme's [menu] tokens.
//
// Views form a navigation stack: root search, a pushed Omarchy submenu,
// Search Quicklinks, or an editor (alias, quicklink form, arguments,
// import, delete confirm). Each view keeps its own query. The header is
// the only text field. A form uses it for the focused field.
OverlayWindow {
  id: window

  required property var backend
  property var appLibrary: null

  signal dismissRequested()

  WlrLayershell.namespace: "oma-cast"

  // ------------------------------------------------------------ settings
  readonly property var general: {
    window.backend.storeRevision
    var r = window.backend.ready ? window.backend.callSync("settings.getGeneralSettings", null) : null
    return r && r.ok ? r.data : ({ uiZoom: 1, windowMode: "expanded", escapeKeyBehavior: "pop-back-or-close", popToRootTimeout: 90 })
  }
  readonly property real zoom: window.general.uiZoom > 0 ? window.general.uiZoom : 1
  function px(value) { return Math.round(Style.space(value) * window.zoom) }

  readonly property var look: ({
    background: Commons.Color.menu.background,
    foreground: Commons.Color.menu.text,
    accent: Commons.Color.menu.selectedText,
    selectedBackground: Commons.Color.menu.selectedBackground,
    fontFamily: Style.font.menuFamily
  })
  readonly property var borderSpec: Border.surfaceSpec("menu", "border", Commons.Color.menu.border, Math.max(1, Style.space(2)))

  // --------------------------------------------------------------- state
  property var stack: [{ kind: "root", title: "oma-cast", query: "" }]
  readonly property var view: window.stack[window.stack.length - 1]
  property string query: ""
  property int selectedIndex: -1
  property var selectedRow: null
  property bool actionPanelOpen: false
  property var actions: []
  property var toast: null
  property int historyIndex: -1
  // Last search the list was built from. An open with the same view, query,
  // and ranking inputs keeps the rows. Frecency is recomputed on search, so
  // the key also changes every 10 minutes. [D]
  property string listKey: ""

  readonly property bool atRoot: window.stack.length === 1
  readonly property bool compact: window.general.windowMode === "compact" && window.atRoot && !window.query
  readonly property bool editor: {
    var kind = window.view.kind
    return kind === "alias" || kind === "quicklink-form" || kind === "quicklink-args" || kind === "quicklink-import" || kind === "confirm-delete-quicklink"
  }
  readonly property bool formActive: window.view.kind === "quicklink-form" || window.view.kind === "quicklink-args"
  readonly property string placeholder: {
    var kind = window.view.kind
    if (kind === "alias") return "Type an alias, then press ↵"
    if (kind === "quicklink-import") return "Paste JSON or a file path, then press ↵"
    if (kind === "confirm-delete-quicklink") return "Press ↵ to delete"
    if (window.formActive) {
      var fields = window.view.fields || []
      var field = fields[window.view.focus || 0]
      return field && field.label ? field.label : "Type a value"
    }
    if (kind === "quicklinks") return "Search quicklinks…"
    if (kind === "menu") return "Search " + window.view.title + "…"
    return "Search for apps and commands…"
  }

  readonly property int cardWidth: Math.min(px(750), width - Style.gapsOut * 2)
  readonly property int fullHeight: Math.min(px(475), height - Style.gapsOut * 2)
  readonly property int headerHeight: px(66)
  readonly property int footerHeight: px(42)

  ListModel { id: rows }

  PointerMoveGate {
    id: pointerGate
    referenceItem: card
  }

  // ----------------------------------------------------------- lifecycle

  // Called on every open, before the surface maps.
  function prepare(payload) {
    popTimer.stop()
    if (typeof payload.query === "string") window.query = payload.query
    window.actionPanelOpen = false
    window.historyIndex = -1
    window.rebuild(true)
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  // The shell hid us: start the pop-to-root clock (SPEC §5.1).
  onShownChanged: {
    if (window.shown) return
    window.actionPanelOpen = false
    var seconds = Number(window.general.popToRootTimeout)
    if (!(seconds > 0)) window.popToRoot()
    else { popTimer.interval = seconds * 1000; popTimer.restart() }
  }

  Timer {
    id: popTimer
    onTriggered: window.popToRoot()
  }

  function popToRoot() {
    window.stack = [{ kind: "root", title: "oma-cast", query: "" }]
    window.query = ""
    window.rebuild(true)
  }

  // ---------------------------------------------------------- navigation

  function initialQuery(next) {
    if (!next) return ""
    if (next.kind === "alias" || next.kind === "quicklink-import") return next.value || ""
    if (next.fields && next.fields.length) {
      var field = next.fields[next.focus || 0]
      return field && field.value ? String(field.value) : ""
    }
    return ""
  }

  function push(next) {
    var saved = window.stack.slice()
    saved[saved.length - 1] = Object.assign({}, window.view, { query: window.query, selectedIndex: window.selectedIndex })
    window.stack = saved.concat([next])
    window.query = window.initialQuery(next)
    window.rebuild(true)
  }

  function pop() {
    if (window.atRoot) return
    var next = window.stack.slice(0, -1)
    var top = next[next.length - 1]
    window.stack = next
    window.query = top.query || ""
    window.rebuild(false)
    if (top.selectedIndex >= 0) window.select(top.selectedIndex)
  }

  // ---------------------------------------------------------------- rows

  function listSignature() {
    var view = window.view || ({})
    return [
      view.kind || "",
      view.menuId || "",
      window.query,
      window.backend.candidatesRevision,
      window.backend.dataRevision,
      window.backend.storeRevision,
      Math.floor(Date.now() / 600000)
    ].join("\u0001")
  }

  function rebuild(resetSelection) {
    pointerGate.reset()
    var key = window.listSignature()
    if (key === window.listKey) {
      if (resetSelection) window.select(window.editor ? -1 : window.nextSelectable(-1, 1))
      return
    }
    var keepId = !resetSelection && window.selectedRow ? window.selectedRow.itemId : ""
    // A failed search used to leave the previous key in place, so returning
    // to that query skipped the rebuild and the cleared rows stayed empty.
    window.listKey = ""
    rows.clear()
    if (window.editor) {
      window.listKey = key
      window.select(-1)
      return
    }
    var result = window.backend.callSync("rootSearch.search", { query: window.query, view: window.view })
    if (!result.ok) {
      window.showToast("failure", result.error)
      window.select(-1)
      return
    }
    var keepIndex = -1
    for (var s = 0; s < result.data.length; s++) {
      var section = result.data[s]
      if (section.title || s > 0) rows.append(window.rowData({ id: "section:" + section.id, title: section.title }, "section"))
      for (var r = 0; r < section.rows.length; r++) {
        var c = section.rows[r]
        if (c.id === keepId) keepIndex = rows.count
        rows.append(window.rowData(c, "item"))
      }
    }
    window.listKey = key
    window.select(keepIndex >= 0 ? keepIndex : window.nextSelectable(-1, 1))
  }

  function rowData(c, kind) {
    return {
      rowKind: kind,
      itemId: String(c.id || ""),
      title: String(c.title || ""),
      subtitle: String(c.subtitle || ""),
      glyph: String(c.glyph || ""),
      glyphFont: String(c.glyphFont || ""),
      iconName: String(c.iconName || ""),
      typeLabel: String(c.typeLabel || ""),
      alias: String(c.alias || ""),
      checked: !!c.checked,
      disabled: !!c.disabled,
      favorite: typeof c.favoriteOrder === "number"
    }
  }

  function nextSelectable(from, direction) {
    for (var i = from + direction; i >= 0 && i < rows.count; i += direction)
      if (rows.get(i).rowKind === "item") return i
    return -1
  }

  function select(index) {
    window.selectedIndex = index
    window.selectedRow = index >= 0 && index < rows.count ? rows.get(index) : null
    if (index >= 0) list.positionViewAtIndex(index, ListView.Contain)
    if (index === window.nextSelectable(-1, 1)) list.positionViewAtBeginning()
  }

  function move(delta) {
    pointerGate.reset()
    if (window.selectedIndex < 0) { window.select(window.nextSelectable(-1, 1)); return }
    var step = delta > 0 ? 1 : -1
    var target = window.selectedIndex
    for (var n = 0; n < Math.abs(delta); n++) {
      var next = window.nextSelectable(target, step)
      if (next < 0) break
      target = next
    }
    window.select(target)
  }

  function jumpSection(direction) {
    var i = window.selectedIndex
    for (i += direction; i >= 0 && i < rows.count; i += direction)
      if (rows.get(i).rowKind === "section") break
    if (direction < 0) {
      for (i -= 1; i >= 0; i--) if (rows.get(i).rowKind === "section") break
    }
    var first = window.nextSelectable(Math.max(-1, i), 1)
    if (first >= 0) window.select(first)
  }

  function nthItem(n) {
    var seen = 0
    for (var i = 0; i < rows.count; i++) {
      if (rows.get(i).rowKind !== "item") continue
      if (++seen === n) return i
    }
    return -1
  }

  // ------------------------------------------------------------- actions

  function actionsForSelected() {
    if (!window.selectedRow) return []
    var r = window.backend.callSync("rootSearch.getActions", { id: window.selectedRow.itemId })
    return r.ok ? r.data : []
  }

  function applyLaunchOutcome(outcome) {
    outcome = outcome || ({})
    if (outcome.push) { window.push(outcome.push); return }
    if (outcome.wait) return
    if (outcome.close) {
      if (window.view.kind === "quicklink-args") window.pop()
      if (outcome.hud) window.hud(outcome.hud)
      window.dismissRequested()
      // [I] A launch clears the root search, so the next open starts fresh
      // instead of appending to the old query. Pushed views stay until
      // pop-to-root, as the reference describes.
      if (window.atRoot) window.setQuery("")
      return
    }
    if (outcome.toast) window.showToast(outcome.toast.style, outcome.toast.title)
    window.rebuild(false)
  }

  function perform(actionId, index) {
    if (index !== undefined && index >= 0) window.select(index)
    if (!window.selectedRow) return
    var id = window.selectedRow.itemId
    window.actionPanelOpen = false
    var r = window.backend.callSync("rootSearch.performAction", { id: id, action: actionId, query: window.query })
    if (!r.ok) { window.showToast("failure", r.error); return }
    window.applyLaunchOutcome(r.data)
  }

  // nth action of the selected row: 0 primary (↵), 1 secondary (Ctrl ↵).
  function performNth(n) {
    var list = window.actionsForSelected()
    if (list.length > n) window.perform(list[n].id)
  }

  function performIfOffered(actionIds) {
    var list = window.actionsForSelected()
    for (var i = 0; i < list.length; i++) if (actionIds.indexOf(list[i].id) >= 0) { window.perform(list[i].id); return true }
    return false
  }

  function toggleActionPanel() {
    if (window.actionPanelOpen) { window.actionPanelOpen = false; return }
    window.actions = window.actionsForSelected()
    actionPanel.filter = ""
    window.actionPanelOpen = window.actions.length > 0
  }

  function saveAlias() {
    var r = window.backend.callSync("settings.updateCommandSettings", { commandId: window.view.commandId, alias: window.query })
    if (!r.ok) { window.showToast("failure", r.error); return }
    var saved = window.query.trim()
    window.pop()
    window.showToast("success", saved ? "Alias saved" : "Alias removed")
    window.rebuild(false)
  }

  function stashField() {
    var view = window.view
    if (!view.fields) return
    var focus = view.focus || 0
    var fields = []
    for (var i = 0; i < view.fields.length; i++) {
      var copy = ({})
      for (var k in view.fields[i]) copy[k] = view.fields[i][k]
      if (i === focus) copy.value = window.query
      fields.push(copy)
    }
    var stack = window.stack.slice()
    stack[stack.length - 1] = Object.assign({}, view, { fields: fields })
    window.stack = stack
  }

  function setFormFocus(index) {
    window.stashField()
    var view = window.view
    var fields = view.fields || []
    if (index < 0 || index >= fields.length) return
    var stack = window.stack.slice()
    stack[stack.length - 1] = Object.assign({}, view, { focus: index })
    window.stack = stack
    window.query = fields[index].value ? String(fields[index].value) : ""
  }

  function formPayload() {
    window.stashField()
    var data = ({})
    var fields = window.view.fields || []
    for (var i = 0; i < fields.length; i++) data[fields[i].key] = fields[i].value
    return data
  }

  function saveQuicklink() {
    var data = window.formPayload()
    var editing = window.view.mode === "edit"
    if (editing) data.id = window.view.quicklinkId
    var r = window.backend.callSync(editing ? "quicklinks.update" : "quicklinks.save", data)
    if (!r.ok) { window.showToast("failure", r.error); return }
    window.pop()
    window.showToast("success", editing ? "Quicklink updated" : "Quicklink created")
    window.rebuild(false)
  }

  function submitQuicklinkArgs() {
    var args = window.formPayload()
    var r = window.backend.callSync("quicklinks.open", { id: window.view.quicklinkId, values: args })
    if (!r.ok) { window.showToast("failure", r.error); return }
    window.applyLaunchOutcome(r.data)
  }

  function importQuicklinks() {
    var r = window.backend.callSync("quicklinks.import", { text: window.query })
    if (!r.ok) { window.showToast("failure", r.error); return }
    var added = r.data && r.data.added ? r.data.added : 0
    var skipped = r.data && r.data.skipped ? r.data.skipped : 0
    window.pop()
    window.showToast("success", added + " added, " + skipped + " skipped")
    window.rebuild(false)
  }

  function confirmDelete() {
    var r = window.backend.callSync("quicklinks.delete", { id: window.view.quicklinkId })
    if (!r.ok) { window.showToast("failure", r.error); return }
    window.pop()
    window.showToast("success", "Quicklink deleted")
    window.rebuild(false)
  }

  // ------------------------------------------------------------ feedback

  function showToast(style, title) {
    window.toast = { style: style, title: String(title || "") }
    toastTimer.restart()
  }

  Timer {
    id: toastTimer
    interval: 2500
    onTriggered: window.toast = null
  }

  // While hidden, a toast becomes a HUD: Omarchy's OSD pill. [D]
  function hud(text) {
    Quickshell.execDetached(["omarchy-shell", "osd", "show", JSON.stringify({ icon: "", message: String(text), duration: 1500 })])
  }

  // ----------------------------------------------------------- the query

  function setQuery(next) {
    if (window.query === next) return
    window.query = next
    window.historyIndex = -1
    if (!window.editor) window.rebuild(true)
  }

  // ↑ on an empty root walks back through queries that launched something.
  function recallHistory(direction) {
    var r = window.backend.callSync("rootSearch.getSearchHistory", null)
    var history = r.ok ? r.data : []
    if (history.length === 0) return false
    var next = Math.max(-1, Math.min(history.length - 1, window.historyIndex + direction))
    if (next === window.historyIndex) return true
    window.query = next < 0 ? "" : history[next]
    window.rebuild(true)
    window.historyIndex = next
    return true
  }

  function setZoom(value) {
    var z = Math.round(Math.max(0.8, Math.min(1.5, value)) * 10) / 10
    window.backend.callSync("settings.updateGeneralSettings", { uiZoom: z })
  }

  function handleEscape(shift) {
    if (window.actionPanelOpen) { window.actionPanelOpen = false; return }
    if (shift) { window.popToRoot(); return }
    if (window.general.escapeKeyBehavior === "close-and-pop-to-root") {
      window.dismissRequested()
      window.popToRoot()
      return
    }
    // pop-back-or-close [O]: clear the search, then go back, then close.
    if (window.query && !window.editor) window.setQuery("")
    else if (!window.atRoot) window.pop()
    else window.dismissRequested()
  }

  function handleKey(event) {
    var ctrl = (event.modifiers & Qt.ControlModifier) !== 0
    var shift = (event.modifiers & Qt.ShiftModifier) !== 0
    var alt = (event.modifiers & Qt.AltModifier) !== 0
    var key = event.key
    var enter = key === Qt.Key_Return || key === Qt.Key_Enter

    if (key === Qt.Key_Escape) { window.handleEscape(shift); return true }
    // Zoom in / out / reset (SPEC §10.3), persisted as uiZoom. [I] step 0.1
    if (ctrl && (key === Qt.Key_Plus || key === Qt.Key_Equal)) { window.setZoom(window.zoom + 0.1); return true }
    if (ctrl && key === Qt.Key_Minus) { window.setZoom(window.zoom - 0.1); return true }
    if (ctrl && key === Qt.Key_0) { window.setZoom(1); return true }
    if (ctrl && key === Qt.Key_BracketLeft) { window.pop(); return true }

    if (window.actionPanelOpen) {
      if (ctrl && key === Qt.Key_K) { window.actionPanelOpen = false; return true }
      if (key === Qt.Key_Down || (ctrl && key === Qt.Key_N)) { actionPanel.move(1); return true }
      if (key === Qt.Key_Up || (ctrl && key === Qt.Key_P)) { actionPanel.move(-1); return true }
      if (enter) { actionPanel.activateSelected(); return true }
      if (Util.editsFilter(event, actionPanel.filter)) { actionPanel.filter = Util.editedFilter(event, actionPanel.filter); return true }
      if (window.isTyping(event)) { actionPanel.filter += event.text; return true }
      return true
    }

    if (window.editor) {
      if (window.view.kind === "confirm-delete-quicklink") {
        if (enter && !event.isAutoRepeat) window.confirmDelete()
        return true
      }
      if (window.formActive) {
        var focus = window.view.focus || 0
        var last = (window.view.fields || []).length - 1
        if (enter && (ctrl || focus >= last)) {
          if (window.view.kind === "quicklink-args") window.submitQuicklinkArgs()
          else window.saveQuicklink()
          return true
        }
        if (enter || key === Qt.Key_Down || key === Qt.Key_Tab) { window.setFormFocus(focus + 1); return true }
        if (key === Qt.Key_Up || key === Qt.Key_Backtab) { window.setFormFocus(focus - 1); return true }
      } else if (window.view.kind === "alias") {
        if (enter) { window.saveAlias(); return true }
        if (key === Qt.Key_Space) return true
      } else if (window.view.kind === "quicklink-import") {
        if (enter) { window.importQuicklinks(); return true }
      }
    } else {
      if (ctrl && key === Qt.Key_K) { window.toggleActionPanel(); return true }
      if (enter && ctrl && shift) { window.performNth(2); return true }
      if (enter && ctrl) { window.performNth(1); return true }
      if (enter) { window.performNth(0); return true }
      if (ctrl && alt && key === Qt.Key_Up) { window.performIfOffered(["favorite-up"]); return true }
      if (ctrl && alt && key === Qt.Key_Down) { window.performIfOffered(["favorite-down"]); return true }
      if (ctrl && key === Qt.Key_Up) { window.jumpSection(-1); return true }
      if (ctrl && key === Qt.Key_Down) { window.jumpSection(1); return true }
      if (key === Qt.Key_Up || (ctrl && key === Qt.Key_P)) {
        if (window.atRoot && (window.query === "" || window.historyIndex >= 0) && window.selectedIndex === window.nextSelectable(-1, 1) && window.recallHistory(1)) return true
        window.move(-1); return true
      }
      if (key === Qt.Key_Down || (ctrl && key === Qt.Key_N)) {
        if (window.historyIndex >= 0) { window.recallHistory(-1); return true }
        window.move(1); return true
      }
      if (key === Qt.Key_PageUp) { window.move(-8); return true }
      if (key === Qt.Key_PageDown) { window.move(8); return true }
      if (ctrl && shift && key === Qt.Key_F) { window.performIfOffered(["favorite-add", "favorite-remove"]); return true }
      if (ctrl && shift && key === Qt.Key_C) { window.performIfOffered(["copy-command", "copy-id", "copy-link"]); return true }
      if (ctrl && !shift && !alt && key === Qt.Key_X && window.performIfOffered(["delete-quicklink"])) return true
      if (alt && shift && key === Qt.Key_D) { window.performIfOffered(["disable"]); return true }
      if (ctrl && key >= Qt.Key_1 && key <= Qt.Key_9) {
        var target = window.nthItem(key - Qt.Key_0)
        if (target >= 0) window.perform("open", target)
        return true
      }
    }

    if (Util.editsFilter(event, window.query)) { window.setQuery(Util.editedFilter(event, window.query)); return true }
    if (key === Qt.Key_Backspace && !window.query && !window.atRoot && (!window.editor || window.view.kind === "alias")) { window.pop(); return true }
    if (window.isTyping(event)) { window.setQuery(window.query + event.text); return true }
    return false
  }

  function isTyping(event) {
    return event.text && event.text.length === 1 && event.text.charCodeAt(0) >= 32 && event.text.charCodeAt(0) !== 127
      && (event.modifiers === Qt.NoModifier || event.modifiers === Qt.ShiftModifier)
  }

  // Ranking inputs changed (apps installed, guards answered, favourites
  // edited): refresh what is on screen without losing the selection.
  Connections {
    target: window.backend
    function onCandidatesRevisionChanged() { if (window.shown && !window.actionPanelOpen && !window.editor) window.rebuild(false) }
    function onQuicklinkReady(outcome) { window.applyLaunchOutcome(outcome) }
  }

  // ================================================================== UI

  // Clicking outside the card is the layer-shell form of focus loss.
  MouseArea {
    anchors.fill: parent
    onClicked: if (!window.backend.config.keepVisibleOnFocusLoss) window.dismissRequested()
  }

  BorderSurface {
    id: card
    width: window.cardWidth
    height: window.compact ? window.headerHeight + card.borderTop + card.borderBottom : window.fullHeight
    radius: Math.max(Style.cornerRadius, window.px(8))
    anchors.horizontalCenter: parent.horizontalCenter
    y: Math.max(Style.gapsOut, Math.min(Math.round(window.height / 4), window.height - window.fullHeight - Style.gapsOut))
    color: window.look.background
    borderSpec: window.borderSpec
    clip: true

    MouseArea { anchors.fill: parent; onClicked: { window.actionPanelOpen = false; keyCatcher.forceActiveFocus() } }

    Item {
      id: keyCatcher
      anchors.fill: parent
      focus: true
      Keys.priority: Keys.BeforeItem
      Keys.onPressed: function(event) { if (window.handleKey(event)) event.accepted = true }
    }

    // -------------------------------------------------------- header
    Item {
      id: header
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.topMargin: card.borderTop
      anchors.leftMargin: card.borderLeft
      anchors.rightMargin: card.borderRight
      height: window.headerHeight

      // Omarchy logo at the root, a back arrow inside pushed views.
      Item {
        id: lead
        width: window.px(28)
        height: window.px(28)
        anchors.left: parent.left
        anchors.leftMargin: window.px(18)
        anchors.verticalCenter: parent.verticalCenter

        Text {
          anchors.centerIn: parent
          textFormat: Text.PlainText
          text: window.atRoot ? "" : ""
          font.family: window.atRoot ? "omarchy" : window.look.fontFamily
          font.pixelSize: window.atRoot ? window.px(18) : window.px(15)
          color: window.atRoot ? window.look.accent : window.look.foreground
          opacity: window.atRoot ? 1 : 0.7
        }

        MouseArea {
          anchors.fill: parent
          enabled: !window.atRoot
          cursorShape: Qt.PointingHandCursor
          onClicked: window.pop()
        }
      }

      Text {
        id: queryText
        textFormat: Text.PlainText
        anchors.left: lead.right
        anchors.leftMargin: window.px(12)
        anchors.right: parent.right
        anchors.rightMargin: window.px(20)
        anchors.verticalCenter: parent.verticalCenter
        text: window.query || window.placeholder
        color: window.look.foreground
        opacity: window.query ? 1 : 0.45
        font.family: window.look.fontFamily
        font.pixelSize: Math.round(Style.font.heading * 1.15 * window.zoom)
        elide: Text.ElideLeft
      }

      Rectangle {
        width: Math.max(1, Style.space(2))
        height: queryText.font.pixelSize + Style.space(4)
        anchors.verticalCenter: parent.verticalCenter
        x: queryText.x + (window.query ? Math.min(queryText.contentWidth, queryText.width) + Style.space(1) : 0)
        color: window.look.accent
        visible: window.shown && !window.actionPanelOpen

        SequentialAnimation on opacity {
          running: window.shown
          loops: Animation.Infinite
          NumberAnimation { to: 1; duration: 0 }
          PauseAnimation { duration: 530 }
          NumberAnimation { to: 0; duration: 0 }
          PauseAnimation { duration: 530 }
        }
      }

      // 2 px loading bar under the header (SPEC §10.2).
      Rectangle {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        height: Style.spacing.hairline
        color: Util.alpha(window.look.foreground, 0.12)
        visible: !window.compact

        Rectangle {
          id: loader
          visible: window.backend.loading && window.shown
          height: Math.max(2, Style.space(2))
          width: parent.width / 4
          anchors.verticalCenter: parent.verticalCenter
          color: window.look.accent
          NumberAnimation on x {
            running: loader.visible
            loops: Animation.Infinite
            from: -loader.width
            to: header.width
            duration: 900
          }
        }
      }
    }

    // ---------------------------------------------------------- body
    Item {
      id: body
      visible: !window.compact
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: header.bottom
      anchors.bottom: footer.top
      anchors.leftMargin: card.borderLeft + window.px(8)
      anchors.rightMargin: card.borderRight + window.px(8)

      Column {
        id: formColumn
        visible: window.formActive
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: window.px(8)
        spacing: window.px(4)

        Repeater {
          model: window.formActive ? (window.view.fields || []) : []
          delegate: Item {
            required property var modelData
            required property int index
            width: formColumn.width
            height: window.px(42)

            Rectangle {
              anchors.fill: parent
              radius: Math.max(Style.cornerRadius, window.px(6))
              color: index === (window.view.focus || 0) ? window.look.selectedBackground : "transparent"
            }

            Text {
              id: fieldLabel
              anchors.left: parent.left
              anchors.leftMargin: window.px(12)
              anchors.verticalCenter: parent.verticalCenter
              width: window.px(110)
              textFormat: Text.PlainText
              text: modelData.label || ""
              color: window.look.foreground
              opacity: 0.55
              font.family: window.look.fontFamily
              font.pixelSize: Math.round(Style.font.body * window.zoom)
              elide: Text.ElideRight
            }

            Text {
              anchors.left: fieldLabel.right
              anchors.leftMargin: window.px(8)
              anchors.right: parent.right
              anchors.rightMargin: window.px(12)
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: index === (window.view.focus || 0) ? window.query : String(modelData.value || "")
              color: window.look.foreground
              font.family: window.look.fontFamily
              font.pixelSize: Math.round(Style.font.title * window.zoom)
              elide: Text.ElideRight
            }

            MouseArea {
              anchors.fill: parent
              cursorShape: Qt.PointingHandCursor
              onClicked: window.setFormFocus(index)
            }
          }
        }
      }

      ListView {
        id: list
        anchors.fill: parent
        anchors.topMargin: window.px(4)
        anchors.bottomMargin: window.px(4)
        visible: !window.editor
        clip: true
        model: rows
        boundsBehavior: Flickable.StopAtBounds

        delegate: ResultRow {
          selected: index === window.selectedIndex
          look: window.look
          appLibrary: window.appLibrary
          zoom: window.zoom
          // Only a real pointer move selects: a row sliding under a still
          // pointer (open, typing, scrolling) must not steal the cursor.
          onHovered: function(i, item, mouse) { if (!window.actionPanelOpen && pointerGate.moved(item, mouse)) window.select(i) }
          onClicked: function(i) { window.perform("open", i) }
        }
      }

      // Empty states.
      Column {
        anchors.centerIn: parent
        spacing: window.px(8)
        visible: !window.formActive && (window.editor || rows.count === 0)

        Text {
          anchors.horizontalCenter: parent.horizontalCenter
          textFormat: Text.PlainText
          text: window.view.kind === "alias" ? "" : (window.view.kind === "confirm-delete-quicklink" ? "" : "")
          color: window.look.accent
          font.family: window.view.kind === "alias" || window.view.kind === "confirm-delete-quicklink" ? window.look.fontFamily : "omarchy"
          font.pixelSize: window.px(28)
        }
        Text {
          anchors.horizontalCenter: parent.horizontalCenter
          textFormat: Text.PlainText
          text: window.editor ? window.view.title : (window.backend.ready ? "No results" : "Loading…")
          color: window.look.foreground
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.title * window.zoom)
        }
        Text {
          anchors.horizontalCenter: parent.horizontalCenter
          textFormat: Text.PlainText
          text: window.view.kind === "alias" ? "Typing the alias exactly in the root search puts this command on top. Leave it empty to remove it."
            : (window.view.kind === "quicklink-import" ? "Paste a JSON array, or type a path to one. A repeated name and link is skipped."
            : (window.view.kind === "confirm-delete-quicklink" ? "Press ↵ to delete this quicklink. Esc cancels." : ""))
          visible: text.length > 0
          color: window.look.foreground
          opacity: 0.55
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * window.zoom)
        }
      }
    }

    // -------------------------------------------------------- footer
    Rectangle {
      id: footer
      visible: !window.compact
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      anchors.bottomMargin: card.borderBottom
      anchors.leftMargin: card.borderLeft
      anchors.rightMargin: card.borderRight
      height: window.footerHeight
      color: Util.alpha(window.look.foreground, 0.04)

      Rectangle {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        height: Style.spacing.hairline
        color: Util.alpha(window.look.foreground, 0.12)
      }

      // Left: the active toast, or where we are.
      Row {
        anchors.left: parent.left
        anchors.leftMargin: window.px(16)
        anchors.verticalCenter: parent.verticalCenter
        spacing: window.px(8)

        Text {
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: window.toast ? (window.toast.style === "failure" ? "" : "") : ""
          font.family: window.toast ? window.look.fontFamily : "omarchy"
          font.pixelSize: window.toast ? window.px(12) : window.px(11)
          color: window.toast && window.toast.style === "failure" ? "#e06c75" : window.look.accent
        }
        Text {
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: window.toast ? window.toast.title : window.view.title
          color: window.look.foreground
          opacity: window.toast ? 0.9 : 0.6
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * window.zoom)
        }
      }

      // Right: primary action ↵ | Actions Ctrl K.
      Row {
        id: footerActions
        anchors.right: parent.right
        anchors.rightMargin: window.px(14)
        anchors.verticalCenter: parent.verticalCenter
        spacing: window.px(8)

        readonly property var primary: {
          window.selectedRow
          window.backend.storeRevision
          if (window.view.kind === "alias") return { title: "Save Alias", shortcut: "↵" }
          if (window.view.kind === "quicklink-form") return { title: "Save Quicklink", shortcut: "↵" }
          if (window.view.kind === "quicklink-args") return { title: "Open Quicklink", shortcut: "↵" }
          if (window.view.kind === "quicklink-import") return { title: "Import", shortcut: "↵" }
          if (window.view.kind === "confirm-delete-quicklink") return { title: "Delete Quicklink", shortcut: "↵" }
          var list = window.actionsForSelected()
          return list.length ? list[0] : null
        }

        Text {
          visible: footerActions.primary !== null
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: footerActions.primary ? footerActions.primary.title : ""
          color: window.look.foreground
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * window.zoom)
        }
        KeyHint {
          visible: footerActions.primary !== null
          anchors.verticalCenter: parent.verticalCenter
          keys: "↵"
          color: window.look.foreground
          zoom: window.zoom
        }
        Rectangle {
          visible: !window.editor
          anchors.verticalCenter: parent.verticalCenter
          width: 1
          height: window.px(14)
          color: Util.alpha(window.look.foreground, 0.2)
        }
        Text {
          visible: !window.editor
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: "Actions"
          color: window.look.foreground
          opacity: 0.7
          font.family: window.look.fontFamily
          font.pixelSize: Math.round(Style.font.bodySmall * window.zoom)
        }
        KeyHint {
          visible: !window.editor
          anchors.verticalCenter: parent.verticalCenter
          keys: "Ctrl K"
          color: window.look.foreground
          zoom: window.zoom
        }
      }
    }

    ActionPanel {
      id: actionPanel
      visible: window.actionPanelOpen
      z: 10
      anchors.right: parent.right
      anchors.rightMargin: card.borderRight + window.px(10)
      anchors.bottom: footer.top
      anchors.bottomMargin: window.px(6)
      actions: window.actions
      look: window.look
      zoom: window.zoom
      onActivated: function(actionId) { window.perform(actionId) }
    }
  }
}
