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
  Home: 0x01000010,
  End: 0x01000011,
  Left: 0x01000012,
  Up: 0x01000013,
  Right: 0x01000014,
  Down: 0x01000015,
  Space: 0x20,
  A: 0x41,
  U: 0x55,
  V: 0x56
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

// "field" lets the TextInput edit. "paste" and "clear" are launcher actions
// because Ctrl+U is not a TextInput binding, and an empty Qt clipboard has
// to fall through to wl-paste. Everything else stays a launcher shortcut.
function owner(event, text, opts) {
  var key = event.key
  var mods = event.modifiers || 0
  var ctrl = flagged(mods, Control)
  var shift = flagged(mods, Shift)
  var alt = flagged(mods, Alt)
  var meta = flagged(mods, Meta)
  var value = String(text || "")
  var blockSpace = !!(opts && opts.blockSpace)

  if (!alt && !meta && ctrl && !shift && key === Key.V) return "paste"
  if (!alt && !meta && !ctrl && shift && key === Key.Insert) return "paste"
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

function shapePaste(text, blockSpace) {
  var value = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  if (blockSpace) return value.replace(/\s+/g, "")
  return value.replace(/\n+/g, " ")
}

if (typeof module !== "undefined") {
  module.exports = {
    Key: Key,
    Mod: { Shift: Shift, Control: Control, Alt: Alt, Meta: Meta },
    owner: owner,
    pastePlan: pastePlan,
    applyPaste: applyPaste,
    shapePaste: shapePaste
  }
}
