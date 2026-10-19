const test = require("node:test")
const assert = require("node:assert/strict")
const Migrate = require("../plugin/core/Migrate.js")
const Schema = require("../plugin/core/Schema.js")
const Ranker = require("../plugin/core/Ranker.js")
const Frecency = require("../plugin/core/Frecency.js")
const OmarchyMenu = require("../plugin/core/OmarchyMenu.js")
const RS = require("../plugin/core/RootSearch.js")
const QL = require("../plugin/core/Quicklinks.js")

const deps = { Ranker, Frecency, OmarchyMenu }
const NOW = Date.UTC(2026, 9, 19, 12)
const JUNE15 = Date.UTC(2022, 5, 15, 14, 45, 6)
const JUNE1_NOON = Date.UTC(2022, 5, 1, 12, 0, 0)
const JUNE15_1505 = Date.UTC(2022, 5, 15, 15, 5, 0)
const JUNE1_1845 = Date.UTC(2022, 5, 1, 18, 45, 0)

function ctx(extra) {
  return Object.assign({ commands: {}, frecency: {}, nowMs: NOW, sensitivity: "medium" }, extra || {})
}

function titles(sections) {
  return sections.flatMap((s) => s.rows.map((r) => r.candidate.title))
}

const SAMPLE = [
  { link: "https://duckduckgo.com/?q={argument}", name: "Search DuckDuckGo" },
  { openWith: "firefox.desktop", iconName: "folder-16", link: "https://example.com", name: "Example" },
  { openWith: "org.gnome.Music.desktop", link: "https://music.example/hits", name: "Hits Radio" },
  { link: "shortcuts://run-shortcut?Name={Test}", name: "Run Shortcut" }
]

test("a new quicklinks document is an empty library", () => {
  const r = Migrate.migrate(null, Schema.quicklinksMigrations, 5)
  assert.equal(r.doc.schemaVersion, 1)
  assert.deepEqual(r.applied, ["quicklinks"])
  assert.deepEqual(r.doc.items, [])
  assert.equal(Schema.documents.quicklinks.file, "quicklinks.json")
})

test("save, update, and delete keep a library the caller can read back", () => {
  const blank = QL.createDocument()
  const saved = QL.save(blank, { name: "  DDG  ", link: " https://duckduckgo.com/?q={query} " }, { now: 1000, id: "ql-1" })
  assert.equal(saved.error, "")
  assert.equal(saved.item.id, "ql-1")
  assert.equal(saved.item.name, "DDG")
  assert.equal(saved.item.link, "https://duckduckgo.com/?q={query}")
  assert.equal(saved.item.createdAt, 1000)
  assert.equal(saved.item.updatedAt, 1000)
  assert.deepEqual(blank.items, [])
  assert.deepEqual(QL.list(saved.doc).map((item) => item.name), ["DDG"])

  const renamed = QL.update(saved.doc, { id: "ql-1", name: "Duck" }, { now: 2000 })
  assert.equal(renamed.error, "")
  assert.equal(renamed.item.name, "Duck")
  assert.equal(renamed.item.link, saved.item.link)
  assert.equal(renamed.item.createdAt, 1000)
  assert.equal(renamed.item.updatedAt, 2000)
  assert.equal(QL.get(renamed.doc, "ql-1").name, "Duck")

  const removed = QL.remove(renamed.doc, "ql-1")
  assert.equal(removed.error, "")
  assert.deepEqual(QL.list(removed.doc), [])
  assert.equal(QL.get(removed.doc, "ql-1"), null)
})

test("save rejects a blank name or link, and update and delete miss an unknown id", () => {
  const doc = QL.createDocument()
  assert.match(QL.save(doc, { name: " ", link: "https://x.test" }, { now: 1 }).error, /name/i)
  assert.match(QL.save(doc, { name: "X", link: "  " }, { now: 1 }).error, /link/i)
  assert.deepEqual(doc.items, [])
  const saved = QL.save(doc, { name: "X", link: "https://x.test" }, { now: 1, id: "ql-1" })
  assert.match(QL.update(saved.doc, { id: "missing", name: "Y" }, { now: 2 }).error, /not found/i)
  assert.match(QL.remove(saved.doc, "missing").error, /not found/i)
  assert.equal(QL.list(saved.doc).length, 1)
})

test("save rejects a link whose placeholders cannot run", () => {
  const doc = QL.createDocument()
  assert.match(QL.save(doc, { name: "Bad", link: "https://x.test/{cursor}" }, { now: 1 }).error, /cursor/i)
  assert.match(QL.save(doc, { name: "Bad", link: "https://x.test/{a}{b}{c}{d}" }, { now: 1 }).error, /3/)
  assert.deepEqual(doc.items, [])
})

test("import accepts Raycast's JSON array and skips a repeated name and link", () => {
  const first = QL.importText(QL.createDocument(), JSON.stringify(SAMPLE), { now: 50 })
  assert.equal(first.error, "")
  assert.equal(first.added, 4)
  assert.equal(first.skipped, 0)
  assert.deepEqual(QL.list(first.doc).map((item) => item.name), ["Search DuckDuckGo", "Example", "Hits Radio", "Run Shortcut"])
  assert.equal(QL.list(first.doc)[1].openWith, "firefox.desktop")
  assert.equal(QL.list(first.doc)[1].iconName, "folder-16")

  const again = QL.importText(first.doc, JSON.stringify(SAMPLE), { now: 60 })
  assert.equal(again.added, 0)
  assert.equal(again.skipped, 4)
  assert.equal(QL.list(again.doc).length, 4)

  const sameLink = QL.importText(again.doc, JSON.stringify([{ name: "Other name", link: "https://example.com" }]), { now: 70 })
  assert.equal(sameLink.added, 1)
  assert.equal(sameLink.skipped, 0)

  const migrated = Migrate.migrate(null, Schema.quicklinksMigrations, 1).doc
  const kept = QL.importText(migrated, JSON.stringify([{ name: "One", link: "https://one.test" }]), { now: 3 })
  assert.equal(kept.doc.schemaVersion, 1)
  assert.equal(QL.list(kept.doc)[0].name, "One")
})

test("import rejects a file that is not the documented array", () => {
  const doc = QL.createDocument()
  assert.match(QL.importText(doc, "{", { now: 1 }).error, /JSON/i)
  assert.match(QL.importText(doc, "{}", { now: 1 }).error, /array/i)
  assert.match(QL.importText(doc, JSON.stringify([{ name: "X" }]), { now: 1 }).error, /link/i)
  assert.deepEqual(doc.items, [])
})

test("export writes the documented fields and drops empty ones", () => {
  const saved = QL.save(QL.createDocument(), {
    name: "Example", link: "https://example.com", openWith: "firefox.desktop", iconName: "folder-16"
  }, { now: 1, id: "ql-1" })
  const bare = QL.save(saved.doc, { name: "Plain", link: "https://plain.test" }, { now: 2, id: "ql-2" })
  assert.deepEqual(QL.exportList(bare.doc), [
    { name: "Example", link: "https://example.com", iconName: "folder-16", openWith: "firefox.desktop" },
    { name: "Plain", link: "https://plain.test" }
  ])
  const round = QL.importText(QL.createDocument(), JSON.stringify(QL.exportList(bare.doc)), { now: 3 })
  assert.equal(round.added, 2)
  assert.deepEqual(QL.exportList(round.doc), QL.exportList(bare.doc))
})

test("placeholders become at most three arguments, and a repeated name is one field", () => {
  const named = QL.parseLink('https://x.test/?q={argument name="query" default="oma"}&x={argument name="query"}')
  assert.equal(named.error, "")
  assert.deepEqual(named.arguments, [{ name: "query", defaultValue: "oma", required: false, options: [] }])

  const legacy = QL.parseLink("https://x.test/?q={query}&t={Search Term:docs}")
  assert.equal(legacy.error, "")
  assert.deepEqual(legacy.arguments.map((arg) => arg.name), ["query", "Search Term"])
  assert.equal(legacy.arguments[1].defaultValue, "docs")
  assert.equal(legacy.arguments[0].required, true)

  const choices = QL.parseLink('{argument name="tone" options="happy, sad, title: professional"}')
  assert.deepEqual(choices.arguments[0].options, [
    { title: "happy", value: "happy" },
    { title: "sad", value: "sad" },
    { title: "title", value: "professional" }
  ])

  assert.match(QL.parseLink("{a}{b}{c}{d}").error, /3/)
  assert.equal(QL.parseLink("{argument name=\"q\"}{argument name=\"q\"}{argument name=\"q\"}{argument name=\"q\"}").error, "")
})

test("expand percent-encodes values unless the placeholder says raw", () => {
  const both = QL.expand("https://x.test/{argument name=\"q\"}/{argument name=\"q\" | raw}", {
    arguments: { q: "a b&c" }
  })
  assert.equal(both.ok, true)
  assert.equal(both.url, "https://x.test/a%20b%26c/a b&c")

  const clip = QL.expand("https://x.test/?q={clipboard}", { clipboard: "a&b" })
  assert.equal(clip.url, "https://x.test/?q=a%26b")
  const older = QL.expand("{clipboard offset=1 | raw}", { clipboard: ["new", "old"] })
  assert.equal(older.url, "old")
  const missing = QL.expand("https://x.test/?q={clipboard}{selection | raw}", { clipboard: "", selection: "" })
  assert.equal(missing.url, "https://x.test/?q=")

  const shaped = QL.expand("{clipboard | trim | uppercase | raw}", { clipboard: "  foo  " })
  assert.equal(shaped.url, "FOO")
  assert.equal(QL.expand("{clipboard | nosuch}", { clipboard: "x" }).ok, false)
})

test("date, time, and weekday placeholders use the given clock", () => {
  const zone = { timeZone: "UTC" }
  assert.equal(QL.expand('{date format="yyyy-MM-dd" | raw}', Object.assign({ now: JUNE15 }, zone)).url, "2022-06-15")
  assert.equal(QL.expand('{date format="yyyy-MM-dd" offset="+1d" | raw}', Object.assign({ now: JUNE15 }, zone)).url, "2022-06-16")
  assert.equal(QL.expand('{date "yyyy-MM-dd" +1d | raw}', Object.assign({ now: JUNE15 }, zone)).url, "2022-06-16")
  assert.equal(QL.expand("{date | raw}", Object.assign({ now: JUNE1_NOON }, zone)).url, "1 Jun 2022")
  assert.equal(QL.expand("{time | raw}", Object.assign({ now: JUNE15_1505 }, zone)).url, "3:05 pm")
  assert.equal(QL.expand("{datetime | raw}", Object.assign({ now: JUNE1_1845 }, zone)).url, "1 Jun 2022 at 6:45 pm")
  assert.equal(QL.expand("{day | raw}", Object.assign({ now: JUNE15 }, zone)).url, "Wednesday")
  assert.match(QL.expand('{date locale="fr-FR" | raw}', Object.assign({ now: JUNE15 }, zone)).url, /juin/)
  assert.equal(QL.expand('{date format="yyyy" locale="fr-FR" | raw}', Object.assign({ now: JUNE15 }, zone)).ok, false)
  assert.equal(QL.expand('{date offset="+ 2d" | raw}', Object.assign({ now: JUNE15 }, zone)).ok, false)
})

test("uuid is filled in, and snippet, calculator, cursor, and browser-tab are refused", () => {
  assert.equal(QL.expand("id={uuid}", { uuid: "ABC" }).url, "id=ABC")
  assert.equal(QL.expand("{uuid | raw}", { uuid: "ABC-1" }).url, "ABC-1")
  for (const link of ["{cursor}", "{browser-tab}", '{snippet name="Hi"}', '{calculator expression="1+1"}']) {
    assert.equal(QL.expand(link, {}).ok, false, link)
  }
  const kept = QL.expand("keep {date\n}", { now: JUNE15, timeZone: "UTC" })
  assert.equal(kept.ok, true)
  assert.equal(kept.url, "keep {date\n}")
})

test("opening uses xdg-open, or gio launch when an app is chosen", () => {
  assert.deepEqual(QL.openArgv("", "https://example.com"), ["xdg-open", "https://example.com"])
  assert.deepEqual(QL.openArgv("firefox.desktop", "https://example.com"), ["gio", "launch", "firefox.desktop", "https://example.com"])
  assert.deepEqual(QL.openArgv("", "~/Downloads", "/home/rafa"), ["xdg-open", "/home/rafa/Downloads"])
})

test("a quicklink is a root-search command and shows a favicon when the link is a site", () => {
  const item = { id: "ql-1", name: "Search DuckDuckGo", link: "https://duckduckgo.com/?q={argument name=\"query\"}", iconName: "", openWith: "" }
  const candidate = QL.toCandidate(item)
  assert.equal(candidate.id, "quicklink:ql-1")
  assert.equal(candidate.type, "quicklink")
  assert.equal(candidate.kind, "quicklink")
  assert.equal(candidate.typeLabel, "Quicklink")
  assert.match(candidate.iconName, /^https:\/\/icons\.duckduckgo\.com\/ip3\/duckduckgo\.com\.ico$/)

  const sections = RS.rootSections([candidate], "duck", ctx(), deps)
  const hit = sections[0].rows.map((r) => r.candidate).find((c) => c.kind === "quicklink")
  assert.equal(hit.title, "Search DuckDuckGo")
  assert.equal(hit.subtitle, item.link)

  const actions = RS.actionsFor(hit).map((a) => a.id)
  assert.equal(actions[0], "open")
  assert.ok(actions.includes("edit-quicklink") && actions.includes("copy-link") && actions.includes("delete-quicklink"))
})

test("Search Quicklinks lists the library, then filters it", () => {
  const items = [
    QL.toCandidate({ id: "a", name: "Alpha", link: "https://a.example", iconName: "", openWith: "" }),
    QL.toCandidate({ id: "b", name: "Beta", link: "https://b.example", iconName: "", openWith: "" })
  ]
  const empty = RS.quicklinkSections(items, "", ctx(), deps)
  assert.deepEqual(empty[0].rows.map((r) => r.candidate.title), ["Alpha", "Beta"])
  const found = RS.quicklinkSections(items, "bet", ctx(), deps)
  assert.deepEqual(found[0].rows.map((r) => r.candidate.title), ["Beta"])
})

test("a URL query offers Open in Browser and Create Quicklink", () => {
  const https = RS.rootSections([], "https://example.com/a", ctx(), deps)
  assert.equal(https[0].id, "url")
  assert.deepEqual(https[0].rows.map((r) => r.candidate.title), ["Open in Browser", "Create Quicklink"])
  assert.equal(https[0].rows[0].candidate.url, "https://example.com/a")
  assert.equal(https[0].rows[1].candidate.link, "https://example.com/a")

  const www = RS.rootSections([], "www.example.com", ctx(), deps)
  assert.equal(www[0].rows[0].candidate.url, "https://www.example.com")

  const deeplink = RS.rootSections([], "spotify://track/1", ctx(), deps)
  assert.equal(deeplink[0].rows[0].candidate.title, "Open in Browser")

  const prose = RS.rootSections([], "not a url", ctx(), deps)
  assert.ok(!prose.some((s) => s.id === "url"))
})

test("Create Quicklink and Search Quicklinks are commands", () => {
  const commands = RS.BUILTINS.map(RS.builtinCandidate)
  const found = titles(RS.rootSections(commands, "quicklink", ctx(), deps))
  assert.ok(found.includes("Create Quicklink"))
  assert.ok(found.includes("Search Quicklinks"))
  assert.ok(found.includes("Import Quicklinks"))
  assert.ok(found.includes("Export Quicklinks"))
})
