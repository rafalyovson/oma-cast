const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const InputKeys = require("../plugin/core/InputKeys.js")

const Key = InputKeys.Key
const Mod = InputKeys.Mod

function event(key, modifiers, text) {
  return { key: key, modifiers: modifiers || 0, text: text || "" }
}

test("printable text, cursor motion, and a non-empty backspace belong to the field", () => {
  assert.equal(InputKeys.owner(event(Key.A, 0, "a"), "hi", {}), "field")
  assert.equal(InputKeys.owner(event(Key.Left), "hi", {}), "field")
  assert.equal(InputKeys.owner(event(Key.Right, Mod.Shift), "hi", {}), "field")
  assert.equal(InputKeys.owner(event(Key.Home), "", {}), "field")
  assert.equal(InputKeys.owner(event(Key.End, Mod.Control), "hi", {}), "field")
  assert.equal(InputKeys.owner(event(Key.Left, Mod.Control), "hi", {}), "field")
  assert.equal(InputKeys.owner(event(Key.A, Mod.Control), "hi", {}), "field")
  assert.equal(InputKeys.owner(event(Key.Backspace), "hi", {}), "field")
  assert.equal(InputKeys.owner(event(Key.Backspace, Mod.Control), "hi", {}), "field")
})

test("paste, clear, an empty backspace, and navigation stay with the launcher", () => {
  assert.equal(InputKeys.owner(event(Key.V, Mod.Control), "hi", {}), "paste")
  assert.equal(InputKeys.owner(event(Key.Insert, Mod.Shift), "", {}), "paste")
  assert.equal(InputKeys.owner(event(Key.U, Mod.Control), "hi", {}), "clear")
  assert.equal(InputKeys.owner(event(Key.U, Mod.Control), "", {}), "launcher")
  assert.equal(InputKeys.owner(event(Key.Backspace), "", {}), "backspace-empty")
  assert.equal(InputKeys.owner(event(Key.Up), "hi", {}), "launcher")
  assert.equal(InputKeys.owner(event(Key.Down, Mod.Control), "hi", {}), "launcher")
  assert.equal(InputKeys.owner(event(Key.Escape), "hi", {}), "launcher")
  assert.equal(InputKeys.owner(event(Key.Space, 0, " "), "go", { blockSpace: true }), "launcher")
  assert.equal(InputKeys.owner(event(Key.Space, 0, " "), "go", {}), "field")
})

test("a Qt clipboard string is inserted, and an empty one asks for wl-paste", () => {
  assert.deepEqual(InputKeys.pastePlan("https://example.com"), { external: false, text: "https://example.com" })
  assert.deepEqual(InputKeys.pastePlan(""), { external: true, text: "" })
  assert.deepEqual(InputKeys.pastePlan(null), { external: true, text: "" })
})

test("paste replaces the selection and keeps a single line", () => {
  assert.deepEqual(InputKeys.applyPaste("abcd", 1, 3, "XY"), { text: "aXYd", cursor: 3 })
  assert.deepEqual(InputKeys.applyPaste("abcd", 4, 4, "Z"), { text: "abcdZ", cursor: 5 })
  assert.equal(InputKeys.shapePaste("a\nb", false), "a b")
  assert.equal(InputKeys.shapePaste("a b", true), "ab")
})

test("show and hide do not read the clipboard, and each typing surface is a TextInput", () => {
  const launcher = fs.readFileSync(path.join(__dirname, "../plugin/ui/LauncherWindow.qml"), "utf8")
  const panel = fs.readFileSync(path.join(__dirname, "../plugin/ui/ActionPanel.qml"), "utf8")
  const prepare = launcher.slice(launcher.indexOf("function prepare("), launcher.indexOf("onShownChanged:"))
  const shown = launcher.slice(launcher.indexOf("onShownChanged:"), launcher.indexOf("Timer {"))
  assert.match(prepare, /focusField\(/)
  assert.doesNotMatch(prepare, /wl-paste|pasteInto|readQtClipboard/)
  assert.match(shown, /focusField\(/)
  assert.doesNotMatch(shown, /wl-paste|pasteInto|readQtClipboard/)
  assert.match(launcher, /id: queryInput/)
  assert.match(launcher, /TextInput \{/)
  assert.match(launcher, /InputKeys\.pastePlan/)
  assert.doesNotMatch(launcher, /id: keyCatcher/)
  assert.match(panel, /id: filterInput/)
  assert.match(panel, /TextInput \{/)
})
