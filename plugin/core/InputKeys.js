// Which keys the text field handles, and how a paste lands.
// QML import and node require both load this file, so it imports nothing.

var Shift = 0x02000000
var Control = 0x04000000
var Alt = 0x08000000
var Meta = 0x10000000

var Key = {
  Escape: 0x01000000,
  Backspace: 0x01000003,
  Insert: 0x01000006,
  Delete: 0x01000007,
  Home: 0x01000010,
  End: 0x01000011,
  Left: 0x01000012,
  Up: 0x01000013,
  Right: 0x01000014,
  Down: 0x01000015,
  Space: 0x20,
  A: 0x41,
  C: 0x43,
  K: 0x4b,
  U: 0x55,
  V: 0x56,
  X: 0x58,
  Y: 0x59,
  Z: 0x5a,
  Paste: 0x010000e2
}

function flagged(mods, flag) {
  return (mods & flag) !== 0
}

function isMotion(key) {
  return key === Key.Left || key === Key.Right || key === Key.Home || key === Key.End
}

function isPlainText(event) {
  var mods = event.modifiers || 0
  if (flagged(mods, Control) || flagged(mods, Alt) || flagged(mods, Meta)) return false
  var text = event.text || ""
  if (!text) return false
  var code = text.charCodeAt(0)
  return code >= 32 && code !== 127
}

// "field" lets the TextInput edit. "paste" stays here so an empty Qt
// clipboard can fall through to wl-paste. Ctrl+Shift+V is paste too:
// Omarchy's Super+V sends that chord. "copy" is Ctrl+Shift+C while a
// selection exists. "clear" is Ctrl+U, which wipes the whole field.
// Qt binds Ctrl+K to delete-to-end, so a Ctrl+K the launcher does not
// use has to be swallowed before it reaches the field.
function owner(event, text, opts) {
  var key = event.key
  var mods = event.modifiers || 0
  var ctrl = flagged(mods, Control)
  var shift = flagged(mods, Shift)
  var alt = flagged(mods, Alt)
  var meta = flagged(mods, Meta)
  var value = String(text || "")
  var blockSpace = !!(opts && opts.blockSpace)
  var selected = !!(opts && opts.selected)

  if (!alt && !meta && ctrl && key === Key.V) return "paste"
  if (!alt && !meta && key === Key.Paste) return "paste"
  if (!alt && !meta && ctrl && shift && key === Key.C && selected) return "copy"
  if (!alt && !meta && ctrl && !shift && key === Key.Insert) return "field"
  if (!alt && !meta && !ctrl && shift && key === Key.Insert) return "field"
  if (!alt && !meta && !ctrl && shift && key === Key.Delete) return "field"
  if (!alt && !meta && ctrl && !shift && key === Key.U) return value ? "clear" : "launcher"
  if (key === Key.Backspace && !alt && !meta) {
    if (!value && !ctrl) return "backspace-empty"
    return "field"
  }
  if (!alt && !meta && isMotion(key)) return "field"
  if (!alt && !meta && ctrl && !shift && key === Key.A) return "field"
  if (blockSpace && !ctrl && !alt && !meta && key === Key.Space) return "launcher"
  if (isPlainText(event)) return "field"
  return "launcher"
}

function pastePlan(qtText) {
  var text = qtText == null ? "" : String(qtText)
  if (text.length) return { external: false, text: text }
  return { external: true, text: "" }
}

function clamp(n, lo, hi) {
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}

function applyPaste(text, start, end, incoming) {
  var value = String(text || "")
  var a = clamp(Math.min(start, end), 0, value.length)
  var b = clamp(Math.max(start, end), 0, value.length)
  var chunk = String(incoming || "")
  return { text: value.slice(0, a) + chunk + value.slice(b), cursor: a + chunk.length }
}

// Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, Ctrl+C, Ctrl+X, and Ctrl+Insert are the
// field's own undo, redo, copy, and cut. Every other Ctrl, Alt, or Meta
// chord is a launcher shortcut or nothing, and must not type into the field.
function swallowModifier(event) {
  var mods = event.modifiers || 0
  var ctrl = flagged(mods, Control)
  var alt = flagged(mods, Alt)
  var meta = flagged(mods, Meta)
  if (!ctrl && !alt && !meta) return false
  if (alt || meta) return true
  var shift = flagged(mods, Shift)
  var key = event.key
  if (shift) return key !== Key.Z
  return key !== Key.Z && key !== Key.Y && key !== Key.C && key !== Key.X && key !== Key.Insert
}

function shapePaste(text, blockSpace) {
  var value = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  if (blockSpace) return value.replace(/\s+/g, "")
  return value.replace(/^\n+|\n+$/g, "").replace(/\n+/g, " ")
}

if (typeof module !== "undefined") {
  module.exports = {
    Key: Key,
    Mod: { Shift: Shift, Control: Control, Alt: Alt, Meta: Meta },
    owner: owner,
    swallowModifier: swallowModifier,
    pastePlan: pastePlan,
    applyPaste: applyPaste,
    shapePaste: shapePaste
  }
}
