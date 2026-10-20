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
  assert.equal(InputKeys.owner(event(Key.Insert, Mod.Control), "hi", {}), "field")
  assert.equal(InputKeys.owner(event(Key.Insert, Mod.Shift), "hi", {}), "field")
  assert.equal(InputKeys.owner(event(Key.Delete, Mod.Shift), "hi", {}), "field")
  assert.equal(InputKeys.owner(event(Key.C, Mod.Control | Mod.Shift), "hi", { selected: true }), "copy")
})

test("paste, clear, an empty backspace, and navigation stay with the launcher", () => {
  assert.equal(InputKeys.owner(event(Key.V, Mod.Control), "hi", {}), "paste")
  assert.equal(InputKeys.owner(event(Key.V, Mod.Control | Mod.Shift), "hi", {}), "paste")
  assert.equal(InputKeys.owner(event(Key.Paste), "hi", {}), "paste")
  assert.equal(InputKeys.owner(event(Key.U, Mod.Control), "hi", {}), "clear")
  assert.equal(InputKeys.owner(event(Key.U, Mod.Control), "", {}), "launcher")
  assert.equal(InputKeys.owner(event(Key.Backspace), "", {}), "backspace-empty")
  assert.equal(InputKeys.owner(event(Key.Up), "hi", {}), "launcher")
  assert.equal(InputKeys.owner(event(Key.Down, Mod.Control), "hi", {}), "launcher")
  assert.equal(InputKeys.owner(event(Key.Escape), "hi", {}), "launcher")
  assert.equal(InputKeys.owner(event(Key.Space, 0, " "), "go", { blockSpace: true }), "launcher")
  assert.equal(InputKeys.owner(event(Key.Space, 0, " "), "go", {}), "field")
  assert.equal(InputKeys.owner(event(Key.C, Mod.Control | Mod.Shift), "hi", {}), "launcher")
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
  assert.equal(InputKeys.shapePaste("a\nb\n", false), "a b")
  assert.equal(InputKeys.shapePaste("hello\n", false), "hello")
  assert.equal(InputKeys.shapePaste("hello \n", false), "hello ")
  assert.equal(InputKeys.shapePaste("a\r\nb\r\n", false), "a b")
  assert.equal(InputKeys.shapePaste("\nhello", false), "hello")
  assert.equal(InputKeys.shapePaste("\na\nb\n", false), "a b")
  assert.equal(InputKeys.shapePaste("a b\n", true), "ab")
})

test("unhandled Ctrl, Alt, and Meta chords are swallowed, and undo copy cut pass through", () => {
  assert.equal(InputKeys.swallowModifier(event(Key.A, Mod.Alt)), true)
  assert.equal(InputKeys.swallowModifier(event(Key.A, Mod.Control | Mod.Alt)), true)
  assert.equal(InputKeys.swallowModifier(event(Key.A, Mod.Meta)), true)
  assert.equal(InputKeys.swallowModifier(event(Key.K, Mod.Control)), true)
  assert.equal(InputKeys.swallowModifier(event(Key.Z, Mod.Control)), false)
  assert.equal(InputKeys.swallowModifier(event(Key.Y, Mod.Control)), false)
  assert.equal(InputKeys.swallowModifier(event(Key.C, Mod.Control)), false)
  assert.equal(InputKeys.swallowModifier(event(Key.X, Mod.Control)), false)
  assert.equal(InputKeys.swallowModifier(event(Key.Z, Mod.Control | Mod.Shift)), false)
  assert.equal(InputKeys.swallowModifier(event(Key.Z, Mod.Control | Mod.Alt)), true)
  assert.equal(InputKeys.swallowModifier(event(Key.A, 0, "a")), false)
  assert.equal(InputKeys.swallowModifier(event(Key.Insert, Mod.Control)), false)
  assert.equal(InputKeys.swallowModifier(event(Key.Insert, Mod.Shift)), false)
  assert.equal(InputKeys.swallowModifier(event(Key.Delete, Mod.Shift)), false)
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
  assert.doesNotMatch(launcher, /placeholderText/)
  assert.doesNotMatch(panel, /placeholderText/)
  assert.match(launcher, /text: window\.placeholder/)
  assert.match(panel, /Search for actions/)
  assert.match(launcher, /onStreamFinished:/)
  assert.doesNotMatch(launcher, /fieldPaste\.prior/)
  assert.doesNotMatch(launcher.slice(launcher.indexOf("id: fieldPaste")), /onExited/)
  assert.match(launcher, /owned === "copy"/)
  assert.match(launcher, /\.copy\(\)/)
  assert.match(launcher, /swallowModifier\(event\)/)
  const pasteFn = launcher.slice(launcher.indexOf("function pasteInto("), launcher.indexOf("function recallHistory"))
  assert.match(pasteFn, /startFieldPaste\(field, true\)/)
  assert.doesNotMatch(pasteFn, /callLater|field\.text !==/)
  assert.match(panel, /filterInput\.text !== panel\.filter/)
  assert.match(panel, /panel\.filter !== text/)
})

const { spawnSync } = require("node:child_process")

function qmllintBin() {
  if (fs.existsSync("/usr/lib/qt6/bin/qmllint")) return "/usr/lib/qt6/bin/qmllint"
  const found = spawnSync("sh", ["-c", "command -v qmllint"], { encoding: "utf8" })
  return found.status === 0 ? found.stdout.trim() : ""
}

const qmllint = qmllintBin()

function placeholderHits(output) {
  // Qt 6.4: `no property "placeholderText"`. Qt 6.12: `Could not find property "placeholderText"`.
  return output.split("\n").filter((line) => /(?:Could not find property|no property) ["']placeholderText/.test(line))
}

test("the placeholder check matches Qt 6.12 and Qt 6.4 warnings, including LauncherWindow.qml", () => {
  const apollo = [
    'Warning: LauncherWindow.qml:576:9: Could not find property "placeholderText".',
    'Warning: LauncherWindow.qml:577:9: Could not find property "placeholderTextColor".',
    'Warning: ActionPanel.qml:172:7: Could not find property "placeholderText".'
  ].join("\n")
  const qt64 = 'Binding assigned to "placeholderText", but no property "placeholderText" exists in the current element.'
  assert.deepEqual(placeholderHits(apollo).length, 3)
  assert.deepEqual(placeholderHits(qt64).length, 1)
  assert.deepEqual(placeholderHits('Could not find property "text".'), [])
})

test("qmllint finds no placeholder properties on the text fields", { skip: !qmllint }, () => {
  for (const name of ["LauncherWindow.qml", "ActionPanel.qml"]) {
    const file = path.join(__dirname, "../plugin/ui", name)
    const run = spawnSync(qmllint, [file], { encoding: "utf8" })
    const out = `${run.stdout || ""}\n${run.stderr || ""}`
    assert.deepEqual(placeholderHits(out), [], name)
  }
})
