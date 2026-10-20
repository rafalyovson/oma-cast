process.env.TZ = "UTC"

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

test("date, time, and weekday placeholders use the local clock", () => {
  assert.equal(QL.expand('{date format="yyyy-MM-dd" | raw}', { now: JUNE15 }).url, "2022-06-15")
  assert.equal(QL.expand('{date format="yyyy-MM-dd" | raw}', { now: JUNE15, timeZone: "Pacific/Kiritimati" }).url, "2022-06-15")
  assert.equal(QL.expand('{date format="yyyy-MM-dd" offset="+1d" | raw}', { now: JUNE15 }).url, "2022-06-16")
  assert.equal(QL.expand('{date "yyyy-MM-dd" +1d | raw}', { now: JUNE15 }).url, "2022-06-16")
  assert.equal(QL.expand("{date | raw}", { now: JUNE1_NOON }).url, "1 Jun 2022")
  assert.equal(QL.expand("{time | raw}", { now: JUNE15_1505 }).url, "3:05 pm")
  assert.equal(QL.expand("{datetime | raw}", { now: JUNE1_1845 }).url, "1 Jun 2022 at 6:45 pm")
  assert.equal(QL.expand("{day | raw}", { now: JUNE15 }).url, "Wednesday")
  assert.match(QL.expand('{date locale="fr-FR" | raw}', { now: JUNE15 }).url, /juin/)
  assert.equal(QL.expand('{date format="yyyy" locale="fr-FR" | raw}', { now: JUNE15 }).ok, false)
  assert.equal(QL.expand('{date offset="+ 2d" | raw}', { now: JUNE15 }).ok, false)
})

test("uuid is filled in, and snippet, calculator, cursor, and browser-tab are refused", () => {
  assert.equal(QL.expand("id={uuid}", { uuid: "ABC" }).url, "id=ABC")
  assert.equal(QL.expand("{uuid | raw}", { uuid: "ABC-1" }).url, "ABC-1")
  for (const link of ["{cursor}", "{browser-tab}", '{snippet name="Hi"}', '{calculator expression="1+1"}']) {
    assert.equal(QL.expand(link, {}).ok, false, link)
  }
  const kept = QL.expand("keep {date\n}", { now: JUNE15 })
  assert.equal(kept.ok, true)
  assert.equal(kept.url, "keep {date\n}")
})

test("opening uses xdg-open, or uwsm-app gtk-launch when an app is chosen", () => {
  assert.deepEqual(QL.openArgv("", "https://example.com"), ["xdg-open", "https://example.com"])
  assert.deepEqual(QL.openArgv("firefox.desktop", "https://example.com"), ["uwsm-app", "--", "gtk-launch", "--", "firefox.desktop", "https://example.com"])
  assert.deepEqual(QL.openArgv("", "~/Downloads", "/home/rafa"), ["xdg-open", "/home/rafa/Downloads"])
  assert.equal(QL.openArgv("", "-rf"), null)
  assert.equal(QL.openArgv("", "  -rf  "), null)
  assert.equal(QL.openArgv("not a desktop id", "https://example.com"), null)
  assert.equal(QL.openArgv("-evil.desktop", "https://example.com"), null)
  assert.deepEqual(QL.browserArgv("https://example.com/a"), ["omarchy-launch-browser", "https://example.com/a"])
  assert.deepEqual(QL.browserArgv("HTTP://example.com"), ["omarchy-launch-browser", "HTTP://example.com"])
  assert.deepEqual(QL.browserArgv("spotify://track/1"), ["xdg-open", "spotify://track/1"])
  assert.equal(QL.browserArgv("-https://example.com"), null)
})

test("a bare host with no scheme opens as https in the browser", () => {
  assert.deepEqual(QL.openArgv("", "test.am"), ["omarchy-launch-browser", "https://test.am"])
  assert.deepEqual(QL.openArgv("", "  WWW.Example.com/a?q=1  "), ["omarchy-launch-browser", "https://WWW.Example.com/a?q=1"])
  assert.deepEqual(QL.openArgv("", "test.am:443/x"), ["omarchy-launch-browser", "https://test.am:443/x"])
  assert.deepEqual(QL.openArgv("firefox.desktop", "test.am"), ["uwsm-app", "--", "gtk-launch", "--", "firefox.desktop", "https://test.am"])
  assert.deepEqual(QL.openArgv("", "~/Downloads", "/home/rafa"), ["xdg-open", "/home/rafa/Downloads"])
  assert.deepEqual(QL.openArgv("", "/etc/hosts"), ["xdg-open", "/etc/hosts"])
  assert.deepEqual(QL.openArgv("", "https://example.com"), ["xdg-open", "https://example.com"])
  assert.deepEqual(QL.openArgv("", "spotify://track/1"), ["xdg-open", "spotify://track/1"])
  assert.deepEqual(QL.openArgv("", "notes"), ["xdg-open", "notes"])
  const saved = QL.save(QL.createDocument(), { name: "Am", link: "test.am", openWith: "" }, { now: 1, id: "ql-am" })
  assert.equal(saved.error, "")
  assert.equal(saved.item.link, "test.am")
  const expanded = QL.expand(saved.item.link, {})
  assert.deepEqual(QL.openArgv(saved.item.openWith, expanded.url), ["omarchy-launch-browser", "https://test.am"])
})

test("a quicklink is a root-search command, and a favicon is opt-in", () => {
  const item = { id: "ql-1", name: "Search DuckDuckGo", link: "https://duckduckgo.com/?q={argument name=\"query\"}", iconName: "", openWith: "" }
  const candidate = QL.toCandidate(item)
  assert.equal(candidate.id, "quicklink:ql-1")
  assert.equal(candidate.type, "quicklink")
  assert.equal(candidate.kind, "quicklink")
  assert.equal(candidate.typeLabel, "Quicklink")
  assert.equal(candidate.iconName, "")
  assert.equal(Schema.configDefaults.quicklinkFavicons, false)
  assert.equal(Schema.withConfigDefaults(null).quicklinkFavicons, false)
  assert.equal(Schema.withConfigDefaults({ quicklinkFavicons: true }).quicklinkFavicons, true)
  const hinted = QL.toCandidate(item, { favicons: true })
  assert.match(hinted.iconName, /^https:\/\/icons\.duckduckgo\.com\/ip3\/duckduckgo\.com\.ico$/)
  const http = QL.toCandidate({ id: "ql-http", name: "Http", link: "http://example.com", iconName: "", openWith: "" }, { favicons: true })
  assert.equal(http.iconName, "")
  const remote = QL.toCandidate({ id: "ql-remote", name: "Remote", link: "https://example.com", iconName: "https://evil.test/a.png", openWith: "" }, { favicons: true })
  assert.match(remote.iconName, /^https:\/\/icons\.duckduckgo\.com\/ip3\/example\.com\.ico$/)

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

test("the quicklinks migration keeps a library that is already there", () => {
  const existing = {
    items: [
      { id: "ql-keep", name: " Keep ", link: " https://keep.test ", iconName: "folder-16", openWith: "firefox.desktop", createdAt: 1, updatedAt: 2 },
      { id: "ql-remote", name: "Remote", link: "https://remote.test", iconName: "https://evil.test/icon.png" },
      { name: "", link: "https://noname.test" },
      { name: "No link" },
      null,
      "nope"
    ]
  }
  const migrated = Migrate.migrate(existing, Schema.quicklinksMigrations, 9)
  assert.equal(migrated.doc.schemaVersion, 1)
  assert.equal(migrated.doc.items.length, 2)
  assert.equal(migrated.doc.items[0].id, "ql-keep")
  assert.equal(migrated.doc.items[0].name, "Keep")
  assert.equal(migrated.doc.items[0].link, "https://keep.test")
  assert.equal(migrated.doc.items[0].iconName, "folder-16")
  assert.equal(migrated.doc.items[0].openWith, "firefox.desktop")
  assert.equal(migrated.doc.items[0].createdAt, 1)
  assert.equal(migrated.doc.items[1].id, "ql-remote")
  assert.equal(migrated.doc.items[1].iconName, "")
})

test("save and import reject a remote icon and leave the library unchanged", () => {
  const doc = QL.createDocument()
  const remote = "https://evil.test/a.png"
  assert.match(QL.save(doc, { name: "X", link: "https://x.test", iconName: remote }, { now: 1 }).error, /icon/i)
  assert.deepEqual(doc.items, [])
  assert.match(QL.importText(doc, JSON.stringify([{ name: "X", link: "https://x.test", iconName: remote }]), { now: 1 }).error, /icon/i)
  assert.deepEqual(doc.items, [])
  const saved = QL.save(doc, { name: "X", link: "https://x.test", iconName: "folder-16" }, { now: 1, id: "ql-1" })
  assert.equal(saved.error, "")
  assert.match(QL.update(saved.doc, { id: "ql-1", iconName: remote }, { now: 2 }).error, /icon/i)
  assert.equal(QL.get(saved.doc, "ql-1").iconName, "folder-16")
})

test("an argument option title expands to its value", () => {
  const link = 'https://x.test/?tone={argument name="tone" options="happy, sad, title: professional"}'
  assert.equal(QL.expand(link, { arguments: { tone: "title" } }).url, "https://x.test/?tone=professional")
  assert.equal(QL.expand(link, { arguments: { tone: "TITLE" } }).url, "https://x.test/?tone=professional")
  assert.equal(QL.expand(link, { arguments: { tone: "professional" } }).url, "https://x.test/?tone=professional")
  assert.equal(QL.expand(link, { arguments: { tone: "Professional" } }).url, "https://x.test/?tone=professional")
  assert.equal(QL.expand(link, { arguments: { tone: "happy" } }).url, "https://x.test/?tone=happy")
  assert.equal(QL.expand(link, { arguments: { tone: "Happy" } }).url, "https://x.test/?tone=happy")
  const rejected = QL.expand(link, { arguments: { tone: "nope" } })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /option/i)
  assert.equal(QL.expand(link, { arguments: { tone: "" } }).ok, false)
})

test("a link that starts with a dash is rejected when it is saved and when it is opened", () => {
  const doc = QL.createDocument()
  assert.match(QL.save(doc, { name: "Dash", link: "-https://x.test" }, { now: 1 }).error, /-/)
  assert.deepEqual(doc.items, [])
  assert.match(QL.importText(doc, JSON.stringify([{ name: "Dash", link: " -rf" }]), { now: 1 }).error, /-/)
  assert.deepEqual(doc.items, [])
  const saved = QL.save(doc, { name: "Arg", link: "{argument name=\"q\"}", openWith: "" }, { now: 1, id: "ql-arg" })
  assert.equal(saved.error, "")
  const expanded = QL.expand(saved.item.link, { arguments: { q: "-rf" } })
  assert.equal(expanded.ok, true)
  assert.equal(QL.openArgv("", expanded.url), null)
})

test("Open With lists installed apps, prefers the link scheme, and keeps a missing id visible", () => {
  const apps = [
    { id: "firefox", name: "Firefox", icon: "firefox", mimeTypes: "x-scheme-handler/https;text/html" },
    { id: "chromium.desktop", name: "Chromium", icon: "chromium", mimeTypes: ["x-scheme-handler/https", "x-scheme-handler/http"] },
    { id: "org.gnome.Music.desktop", name: "Music", icon: "music", mimeTypes: ["x-scheme-handler/spotify"] },
    { id: "Alacritty.desktop", name: "Alacritty", icon: "Alacritty", mimeTypes: [] }
  ]
  const all = QL.openWithChoices(apps, { link: "https://example.com/{argument name=\"q\"}", query: "", current: "firefox.desktop" })
  assert.equal(all[0].id, "")
  assert.equal(all[0].title, "Default (browser / xdg-open)")
  assert.deepEqual(all.slice(1).map((row) => row.id), ["chromium.desktop", "firefox.desktop", "Alacritty.desktop", "org.gnome.Music.desktop"])
  assert.equal(all[2].iconName, "firefox")
  assert.equal(QL.openWithLabel(apps, "firefox.desktop"), "Firefox")
  assert.equal(QL.openWithLabel(apps, ""), "Default (browser / xdg-open)")

  const found = QL.openWithChoices(apps, { link: "https://example.com", query: "fire", current: "" })
  assert.deepEqual(found.map((row) => row.title), ["Firefox"])

  const spotify = QL.openWithChoices(apps, { link: "spotify://track/1", query: "", current: "" })
  assert.equal(spotify[1].id, "org.gnome.Music.desktop")
  assert.ok(spotify.some((row) => row.id === "Alacritty.desktop"))

  const missing = QL.openWithChoices(apps, { link: "https://example.com", query: "", current: "gone.desktop" })
  assert.equal(missing[1].id, "gone.desktop")
  assert.equal(missing[1].title, "gone.desktop (not installed)")
  assert.equal(QL.openWithLabel(apps, "gone.desktop"), "gone.desktop (not installed)")

  const doc = QL.createDocument()
  const saved = QL.save(doc, { name: "Browser", link: "https://x.test", openWith: "firefox.desktop" }, { now: 1, id: "ql-app", installed: apps })
  assert.equal(saved.error, "")
  assert.equal(saved.item.openWith, "firefox.desktop")
  assert.match(QL.save(doc, { name: "Missing", link: "https://y.test", openWith: "gone.desktop" }, { now: 1, installed: apps }).error, /installed/i)
  const imported = QL.importText(doc, JSON.stringify([{ name: "Music", link: "spotify://x", openWith: "org.gnome.Music.desktop" }]), { now: 1, installed: apps })
  assert.equal(imported.error, "")
  assert.equal(imported.added, 1)
  assert.match(QL.importText(doc, JSON.stringify([{ name: "Gone", link: "https://z.test", openWith: "gone.desktop" }]), { now: 1, installed: apps }).error, /installed/i)
  const renamed = QL.update(saved.doc, { id: "ql-app", name: "Web" }, { now: 2, installed: [] })
  assert.equal(renamed.error, "")
  assert.equal(renamed.item.openWith, "firefox.desktop")
  assert.match(QL.update(saved.doc, { id: "ql-app", openWith: "gone.desktop" }, { now: 2, installed: apps }).error, /installed/i)
})

test("openWith has to be a desktop id", () => {
  const doc = QL.createDocument()
  const ok = QL.save(doc, { name: "Browser", link: "https://x.test", openWith: "org.gnome.Music.desktop" }, { now: 1, id: "ql-app" })
  assert.equal(ok.error, "")
  assert.equal(ok.item.openWith, "org.gnome.Music.desktop")
  assert.equal(QL.save(doc, { name: "Plain", link: "https://y.test", openWith: "" }, { now: 1 }).error, "")
  for (const openWith of ["not a desktop id", "-evil.desktop", "foo/bar.desktop", "firefox"]) {
    assert.match(QL.save(doc, { name: "Bad", link: "https://bad.test", openWith }, { now: 1 }).error, /desktop/i, openWith)
  }
  assert.match(QL.importText(doc, JSON.stringify([{ name: "Bad", link: "https://bad.test", openWith: "nope" }]), { now: 1 }).error, /desktop/i)
  assert.match(QL.update(ok.doc, { id: "ql-app", openWith: "firefox" }, { now: 2 }).error, /desktop/i)
  assert.equal(QL.get(ok.doc, "ql-app").openWith, "org.gnome.Music.desktop")
})

test("an unfinished app index checks only the desktop id and shows it raw", () => {
  const doc = QL.createDocument()
  const saved = QL.save(doc, { name: "Early", link: "https://x.test", openWith: "firefox.desktop" }, { now: 1, id: "ql-early", installed: null })
  assert.equal(saved.error, "")
  assert.equal(saved.item.openWith, "firefox.desktop")
  assert.match(QL.save(doc, { name: "Empty", link: "https://y.test", openWith: "firefox.desktop" }, { now: 1, installed: [] }).error, /installed/i)
  assert.equal(QL.openWithLabel(null, "firefox.desktop"), "firefox.desktop")
  assert.equal(QL.openWithLabel([], "firefox.desktop", { ready: false }), "firefox.desktop")
  assert.equal(QL.openWithLabel([], "firefox.desktop"), "firefox.desktop (not installed)")
  const pending = QL.openWithChoices(null, { ready: false, query: "", current: "firefox.desktop", link: "https://x.test" })
  assert.equal(pending[0].title, "Default (browser / xdg-open)")
  assert.equal(pending[1].id, "firefox.desktop")
  assert.equal(pending[1].title, "firefox.desktop")
  assert.equal(pending[1].missing, false)
})

test("Open With accepts NoDisplay and launcher-hidden entries in the catalog", () => {
  const catalog = [
    { id: "firefox", name: "Firefox", noDisplay: false },
    { id: "firefox-url-handler.desktop", name: "Firefox Handler", noDisplay: true },
    { id: "hidden-notes.desktop", name: "Hidden Notes", hidden: true }
  ]
  const doc = QL.createDocument()
  const saved = QL.save(doc, { name: "Handler", link: "https://x.test", openWith: "firefox-url-handler.desktop" }, { now: 1, id: "ql-handler", installed: catalog })
  assert.equal(saved.error, "")
  assert.equal(saved.item.openWith, "firefox-url-handler.desktop")
  assert.equal(QL.openWithLabel(catalog, "hidden-notes.desktop"), "Hidden Notes")
  const choices = QL.openWithChoices(catalog, { link: "https://x.test", query: "", current: "firefox-url-handler.desktop" })
  assert.ok(choices.some((row) => row.id === "firefox-url-handler.desktop" && row.title === "Firefox Handler" && row.missing === false))
  assert.ok(choices.some((row) => row.id === "hidden-notes.desktop" && row.missing === false))
  assert.equal(QL.importText(doc, JSON.stringify([{ name: "Notes", link: "notes://x", openWith: "hidden-notes.desktop" }]), { now: 2, installed: catalog }).error, "")
})

test("a different letter case is stored as the installed entry's id", () => {
  const apps = [{ id: "firefox", name: "Firefox", icon: "firefox" }]
  const doc = QL.createDocument()
  const saved = QL.save(doc, { name: "Browser", link: "https://x.test", openWith: "Firefox.desktop" }, { now: 1, id: "ql-case", installed: apps })
  assert.equal(saved.error, "")
  assert.equal(saved.item.openWith, "firefox.desktop")
  assert.equal(QL.openWithLabel(apps, "Firefox.desktop"), "Firefox")
  const imported = QL.importText(doc, JSON.stringify([{ name: "Other", link: "https://y.test", openWith: "FIREFOX.desktop" }]), { now: 2, installed: apps })
  assert.equal(imported.error, "")
  assert.equal(imported.doc.items.filter((item) => item.name === "Other")[0].openWith, "firefox.desktop")
  const both = [{ id: "App.desktop", name: "Upper" }, { id: "app.desktop", name: "Lower" }]
  assert.equal(QL.save(doc, { name: "Exact", link: "https://a.test", openWith: "App.desktop" }, { now: 3, installed: both }).item.openWith, "App.desktop")
  assert.match(QL.save(doc, { name: "Ambiguous", link: "https://b.test", openWith: "APP.desktop" }, { now: 3, installed: both }).error, /installed/i)
  const choices = QL.openWithChoices(apps, { link: "https://x.test", query: "", current: "Firefox.desktop" })
  assert.equal(choices.filter((row) => row.missing).length, 0)
  assert.ok(choices.some((row) => row.id === "firefox.desktop"))
})

test("choosing an Open With app closes the list and keeps the app icon", () => {
  assert.deepEqual(QL.afterOpenWithPick(3, 1), { focus: 2, listOpen: false })
  assert.deepEqual(QL.afterOpenWithPick(3, 2), { focus: 2, listOpen: false })
  const apps = [{ id: "firefox", name: "Firefox", icon: "firefox" }]
  assert.deepEqual(QL.openWithIcon(apps, ""), { iconName: "", glyph: "\uf0ac" })
  assert.deepEqual(QL.openWithIcon(apps, "firefox.desktop"), { iconName: "firefox", glyph: "" })
  assert.deepEqual(QL.openWithIcon(null, "firefox.desktop"), { iconName: "", glyph: "" })
  assert.deepEqual(QL.openWithIcon([], "gone.desktop"), { iconName: "", glyph: "" })
  const fs = require("node:fs")
  const path = require("node:path")
  const qml = fs.readFileSync(path.join(__dirname, "../plugin/ui/LauncherWindow.qml"), "utf8")
  assert.match(qml, /openWithListDismissed/)
  assert.match(qml, /Quicklinks\.afterOpenWithPick/)
  assert.match(qml, /copy\.iconName = String\(row\.iconName/)
})

test("Open With says Enter selects the app and Ctrl+Enter saves", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const qml = fs.readFileSync(path.join(__dirname, "../plugin/ui/LauncherWindow.qml"), "utf8")
  const docs = fs.readFileSync(path.join(__dirname, "../CLAUDE.md"), "utf8")
  assert.match(qml, /title: "Select App"/)
  assert.match(qml, /text: "Save Quicklink"/)
  assert.match(qml, /keys: "Ctrl ↵"/)
  assert.match(docs, /Enter selects the highlighted app and Ctrl\+Enter saves the quicklink/)
})

test("opening refuses an uninstalled app once the index is loaded", () => {
  const apps = [{ id: "firefox.desktop", name: "Firefox" }]
  assert.deepEqual(QL.prepareOpen("", apps, true), { ok: true, openWith: "", error: "" })
  assert.deepEqual(QL.prepareOpen("Firefox.desktop", apps, true), { ok: true, openWith: "firefox.desktop", error: "" })
  assert.deepEqual(QL.prepareOpen("gone.desktop", apps, true), { ok: false, openWith: "gone.desktop", error: "gone.desktop is not installed" })
  assert.deepEqual(QL.prepareOpen("gone.desktop", [], false), { ok: true, openWith: "gone.desktop", error: "" })
  assert.deepEqual(QL.prepareOpen("gone.desktop", null, false), { ok: true, openWith: "gone.desktop", error: "" })
})

test("randomUuid sets the version 4 and variant bits", () => {
  for (let i = 0; i < 40; i++) {
    assert.match(QL.randomUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  }
})

test("a URL query needs a scheme and a host, and a hit stays above it", () => {
  assert.equal(RS.isUrlQuery("http:"), false)
  assert.equal(RS.isUrlQuery("www."), false)
  assert.equal(RS.isUrlQuery("a:"), false)
  assert.equal(RS.isUrlQuery("word:value"), false)
  assert.equal(RS.isUrlQuery("not a url"), false)
  assert.equal(RS.isUrlQuery("www.example.com"), true)
  assert.equal(RS.isUrlQuery("https://example.com/a"), true)
  assert.equal(RS.isUrlQuery("spotify://track/1"), true)

  assert.ok(!RS.rootSections([], "http:", ctx(), deps).some((s) => s.id === "url"))
  assert.ok(!RS.rootSections([], "www.", ctx(), deps).some((s) => s.id === "url"))
  assert.ok(!RS.rootSections([], "word:value", ctx(), deps).some((s) => s.id === "url"))

  const candidate = QL.toCandidate({ id: "ql-1", name: "Example", link: "https://example.com/a", iconName: "", openWith: "" })
  const sections = RS.rootSections([candidate], "https://example.com/a", ctx(), deps)
  assert.equal(sections[0].id, "results")
  assert.equal(sections[0].rows[0].candidate.title, "Example")
  assert.equal(sections[1].id, "url")
})

test("a quoted brace stays inside the attribute", () => {
  const parsed = QL.parseLink('{argument name="a}b" default="x}y"}')
  assert.equal(parsed.error, "")
  assert.equal(parsed.arguments[0].name, "a}b")
  assert.equal(parsed.arguments[0].defaultValue, "x}y")
  assert.equal(QL.expand('{argument name="a}b"}', { arguments: { "a}b": "ok" } }).url, "ok")
})

test("import says a non-object row is invalid", () => {
  const doc = QL.createDocument()
  for (const row of [null, "nope", []]) {
    const result = QL.importText(doc, JSON.stringify([row]), { now: 1 })
    assert.match(result.error, /invalid/i)
    assert.doesNotMatch(result.error, /needs a link/i)
  }
  assert.deepEqual(doc.items, [])
})

test("candidates drop items that are not objects with string id, name, and link", () => {
  const doc = {
    items: [
      { id: "ql-1", name: "Ok", link: "https://ok.test" },
      { id: 2, name: "Num", link: "https://n.test" },
      { id: "ql-3", name: "No link" },
      null,
      ["ql-4", "Arr", "https://a.test"],
      { id: "ql-5", name: "Also", link: "https://also.test" }
    ]
  }
  assert.deepEqual(QL.candidateItems(doc).map((item) => item.id), ["ql-1", "ql-5"])
  assert.equal(QL.toCandidate({ id: 2, name: "Num", link: "https://n.test" }), null)
})

test("Create Quicklink and Search Quicklinks are commands", () => {
  const commands = RS.BUILTINS.map(RS.builtinCandidate)
  const found = titles(RS.rootSections(commands, "quicklink", ctx(), deps))
  assert.ok(found.includes("Create Quicklink"))
  assert.ok(found.includes("Search Quicklinks"))
  assert.ok(found.includes("Import Quicklinks"))
  assert.ok(found.includes("Export Quicklinks"))
})
