// Quicklinks (SPEC §8.4): the library, placeholder expansion (SPEC §8.3),
// import/export, and the root-search row for one saved link.
// [D] A repeated import is a duplicate only when both the name and the link match.
// [D] Substituted values are percent-encoded unless the placeholder says raw.
// [D] Spaces and quotes in the literal link text are percent-encoded on expand.
// [D] A name is unique after trim, and longer than NAME_MAX is rejected.
// [I] Date patterns use local Date getters. A locale uses Qt.formatDateTime when Qt is present.
//     A throw from that call falls back to the JS month names so the link still opens.

var KEYWORDS = ["browser-tab", "calculator", "clipboard", "datetime", "argument", "selection", "snippet", "cursor", "date", "time", "uuid", "day", "ai"]
var REFUSED = { cursor: true, "browser-tab": true, snippet: true, calculator: true, ai: true }
var MODIFIERS = ["uppercase", "lowercase", "trim", "percent-encode", "json-stringify", "raw"]
var QUOTE_PAIRS = { "\"": "\"", "'": "'", "`": "`", "\u201c": "\u201d", "\u2018": "\u2019" }
var DATE_TOKENS = ["yyyy", "yy", "MMMM", "MMM", "MM", "EEEE", "HH", "hh", "mm", "ss", "dd", "y", "M", "d", "E", "H", "h", "m", "s", "a"]
var NAME_MAX = 200 // [D] Cap for a launcher row. Not a limit observed in Raycast.

function createDocument() {
  return { items: [] }
}

function cloneDoc(doc) {
  var next = JSON.parse(JSON.stringify(doc || { items: [] }))
  if (!next || typeof next !== "object" || Array.isArray(next)) next = { items: [] }
  if (!Array.isArray(next.items)) next.items = []
  return next
}

function list(doc) {
  return (doc && doc.items ? doc.items : []).slice()
}

function get(doc, id) {
  var items = doc && doc.items ? doc.items : []
  for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i]
  return null
}

function makeId(doc, now) {
  var stamp = (typeof now === "number" ? now : Date.now()).toString(36)
  var id = "ql-" + stamp + "-" + doc.items.length.toString(36)
  var seen = {}
  for (var i = 0; i < doc.items.length; i++) seen[doc.items[i].id] = true
  while (seen[id]) id += "x"
  return id
}

function blankResult(doc, error) {
  return { doc: doc, item: null, error: error, added: 0, skipped: 0, skippedNames: [] }
}

function buildItem(input, id, now, ctx) {
  var name = String(input && input.name != null ? input.name : "").trim()
  var link = String(input && input.link != null ? input.link : "").trim()
  if (!name) return { error: "Quicklink needs a name" }
  if (name.length > NAME_MAX) return { error: "Quicklink name is too long" }
  if (!link) return { error: "Quicklink needs a link" }
  if (link.charAt(0) === "-") return { error: "Quicklink link cannot start with -" }
  if (/^javascript:/i.test(link)) return { error: "Quicklink link cannot use javascript:" }
  var parsed = parseLink(link)
  if (parsed.error) return { error: parsed.error }
  var iconName = String(input.iconName || "").trim()
  if (iconName.indexOf("://") >= 0) return { error: "Quicklink iconName cannot be a remote URL" }
  var resolved = resolveStoredOpenWith(input && input.openWith, ctx)
  if (resolved.error) return { error: resolved.error }
  var openWith = resolved.id
  return {
    error: "",
    item: {
      id: id,
      name: name,
      link: link,
      iconName: iconName,
      openWith: openWith,
      createdAt: now,
      updatedAt: now
    }
  }
}

// A desktop file id, such as firefox.desktop or org.gnome.Music.desktop.
// Empty means the default opener. A leading dash would be an option to gtk-launch.
function isDesktopId(app) {
  return /^[A-Za-z0-9][A-Za-z0-9_.+-]*\.desktop$/.test(String(app || ""))
}

function stemExact(id) {
  return String(id || "").replace(/\.desktop$/i, "")
}

function canonicalDesktopId(id) {
  var text = String(id || "").trim()
  if (!text) return ""
  if (/\.desktop$/i.test(text)) return text
  return text + ".desktop"
}

function mimeList(entry) {
  var raw = entry.mimeTypes
  if (raw == null) raw = entry.mimeType
  if (raw == null) return []
  if (typeof raw === "string") {
    var parts = raw.split(";")
    var out = []
    for (var i = 0; i < parts.length; i++) {
      var piece = parts[i].trim()
      if (piece) out.push(piece)
    }
    return out
  }
  if (typeof raw.length === "number") {
    var list = []
    for (var j = 0; j < raw.length; j++) if (raw[j]) list.push(String(raw[j]).trim())
    return list
  }
  return []
}

// Every desktop entry the caller hands in, including NoDisplay and apps the
// launcher hides. id may omit ".desktop". This is not the visible app list.
function installedApps(entries) {
  var out = []
  var list = entries || []
  for (var i = 0; i < list.length; i++) {
    var entry = list[i]
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    var id = canonicalDesktopId(entry.id || entry.appId || "")
    if (!isDesktopId(id)) continue
    out.push({
      id: id,
      name: String(entry.name || entry.title || id),
      icon: String(entry.icon || entry.iconName || ""),
      mimeTypes: mimeList(entry)
    })
  }
  return out
}

// Exact stem first. A unique case-insensitive hit is the same app, so the
// stored id can be the entry's real id. Two entries that differ only by case
// do not match a third spelling.
function findApp(openWith, apps) {
  var exact = stemExact(openWith)
  var lower = exact.toLowerCase()
  var folded = null
  var foldedCount = 0
  for (var i = 0; i < apps.length; i++) {
    var stem = stemExact(apps[i].id)
    if (stem === exact) return apps[i]
    if (stem.toLowerCase() === lower) {
      folded = apps[i]
      foldedCount++
    }
  }
  return foldedCount === 1 ? folded : null
}

// null installed means the desktop index is not ready yet: check the id
// shape only. An array, including an empty one, is a finished catalog.
function catalogReady(entries, opts) {
  if (opts && opts.ready === false) return false
  if (opts && opts.ready === true) return true
  return entries != null
}

function resolveStoredOpenWith(openWith, ctx) {
  var id = String(openWith || "").trim()
  if (!id) return { error: "", id: "" }
  if (!isDesktopId(id)) return { error: "Quicklink openWith must be a desktop id", id: "" }
  var ready = ctx && ctx.installed != null
  if (!ready) return { error: "", id: id }
  var app = findApp(id, installedApps(ctx.installed))
  if (app) return { error: "", id: app.id }
  var allow = ctx.allowOpenWith ? canonicalDesktopId(String(ctx.allowOpenWith).trim()) : ""
  if (allow && stemExact(allow) === stemExact(id)) return { error: "", id: allow }
  return { error: "Quicklink openWith is not an installed app", id: "" }
}

// When the index is loaded and the app is gone, the open is refused so the
// caller can toast and skip the visit. Before the index is ready, the stored
// id is launched as written.
function prepareOpen(openWith, entries, ready) {
  var id = String(openWith || "").trim()
  if (!id) return { ok: true, openWith: "", error: "" }
  if (!isDesktopId(id)) return { ok: false, openWith: id, error: "Open with must be a desktop id" }
  if (!ready) return { ok: true, openWith: id, error: "" }
  var app = findApp(id, installedApps(entries))
  if (!app) return { ok: false, openWith: id, error: id + " is not installed" }
  return { ok: true, openWith: app.id, error: "" }
}

function linkScheme(link) {
  var head = String(link || "").split("{")[0].trim()
  var match = /^([a-z][a-z0-9+.-]*):/i.exec(head)
  return match ? match[1].toLowerCase() : ""
}

function handlesScheme(app, scheme) {
  if (!scheme) return false
  var wanted = "x-scheme-handler/" + scheme
  var types = app.mimeTypes || []
  for (var i = 0; i < types.length; i++) if (String(types[i]).toLowerCase() === wanted) return true
  return false
}

function textMatches(text, query) {
  if (!query) return true
  return String(text || "").toLowerCase().indexOf(query) >= 0
}

function byAppName(a, b) {
  var an = a.name.toLowerCase()
  var bn = b.name.toLowerCase()
  if (an < bn) return -1
  if (an > bn) return 1
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

var DEFAULT_OPEN_WITH = "Default (browser / xdg-open)"

function openWithLabel(entries, id, opts) {
  var current = String(id || "").trim()
  if (!current) return DEFAULT_OPEN_WITH
  if (!catalogReady(entries, opts)) return current
  var app = findApp(current, installedApps(entries))
  if (app) return app.name
  return current + " (not installed)"
}

// Icon stored on the Open With field. Empty id is Default. A catalog that
// is not ready yet has no icon, so the field does not guess.
function openWithIcon(entries, id, opts) {
  var current = String(id || "").trim()
  if (!current) return { iconName: "", glyph: "\uf0ac" }
  if (!catalogReady(entries, opts)) return { iconName: "", glyph: "" }
  var app = findApp(current, installedApps(entries))
  if (!app) return { iconName: "", glyph: "" }
  return { iconName: app.icon || "", glyph: "" }
}

// After a choice the list closes. Focus moves to the next field when one
// exists. The last field keeps focus so the next Enter can save.
function afterOpenWithPick(fieldCount, focus) {
  var count = fieldCount | 0
  var index = focus | 0
  var next = index + 1
  if (next < count) return { focus: next, listOpen: false }
  return { focus: index, listOpen: false }
}

// Searchable Open With rows. Handlers for the link's scheme come first
// when the entry has mimeTypes or a mimeType string. Quickshell 0.3.2's
// DesktopEntry does not expose MimeType, so a live entry sorts with the rest.
// A saved id that is not installed stays in the list so edit can keep it.
function importOpenWithIds(jsonString) {
  var parsed
  try {
    parsed = JSON.parse(String(jsonString || ""))
  } catch (e) {
    return []
  }
  if (!Array.isArray(parsed)) return []
  var ids = []
  for (var i = 0; i < parsed.length; i++) {
    var row = parsed[i]
    if (!row || typeof row !== "object" || Array.isArray(row) || !row.openWith) continue
    ids.push(String(row.openWith))
  }
  return ids
}

function openWithChoices(entries, opts) {
  var options = opts || {}
  var query = String(options.query || "").trim().toLowerCase()
  var scheme = linkScheme(options.link)
  var current = String(options.current || "").trim()
  var rows = []
  if (!catalogReady(entries, options)) {
    if (textMatches(DEFAULT_OPEN_WITH, query)) {
      rows.push({ id: "", title: DEFAULT_OPEN_WITH, iconName: "", subtitle: "", missing: false, glyph: "\uf0ac" })
    }
    if (current && isDesktopId(current) && textMatches(current, query)) {
      rows.push({ id: current, title: current, iconName: "", subtitle: "", missing: false, glyph: "" })
    }
    return rows
  }
  var apps = installedApps(entries)
  var handlers = []
  var rest = []
  var matched = current ? findApp(current, apps) : null
  for (var i = 0; i < apps.length; i++) {
    var app = apps[i]
    if (!textMatches(app.name + " " + app.id + " " + stemExact(app.id), query)) continue
    if (handlesScheme(app, scheme)) handlers.push(app)
    else rest.push(app)
  }
  handlers.sort(byAppName)
  rest.sort(byAppName)
  if (textMatches(DEFAULT_OPEN_WITH, query)) {
    rows.push({ id: "", title: DEFAULT_OPEN_WITH, iconName: "", subtitle: "", missing: false, glyph: "\uf0ac" })
  }
  if (current && isDesktopId(current) && !matched && textMatches(current + " (not installed)", query)) {
    rows.push({ id: current, title: current + " (not installed)", iconName: "", subtitle: "", missing: true, glyph: "" })
  }
  for (var h = 0; h < handlers.length; h++) {
    rows.push({ id: handlers[h].id, title: handlers[h].name, iconName: handlers[h].icon, subtitle: "", missing: false, glyph: "" })
  }
  for (var r = 0; r < rest.length; r++) {
    rows.push({ id: rest[r].id, title: rest[r].name, iconName: rest[r].icon, subtitle: "", missing: false, glyph: "" })
  }
  return rows
}

function save(doc, input, ctx) {
  var now = ctx && typeof ctx.now === "number" ? ctx.now : Date.now()
  var next = cloneDoc(doc)
  var id = ctx && ctx.id ? String(ctx.id) : makeId(next, now)
  if (get(next, id)) return blankResult(doc, "Quicklink id already exists")
  var built = buildItem(input, id, now, ctx)
  if (built.error) return blankResult(doc, built.error)
  if (takenName(next, built.item.name, "")) return blankResult(doc, "Quicklink name is already used")
  next.items.push(built.item)
  return { doc: next, item: built.item, error: "", added: 1, skipped: 0 }
}

function update(doc, patch, ctx) {
  var now = ctx && typeof ctx.now === "number" ? ctx.now : Date.now()
  var id = String(patch && patch.id || "")
  var current = get(doc, id)
  if (!current) return blankResult(doc, "Quicklink not found")
  var merged = {
    name: patch.name !== undefined ? patch.name : current.name,
    link: patch.link !== undefined ? patch.link : current.link,
    iconName: patch.iconName !== undefined ? patch.iconName : current.iconName,
    openWith: patch.openWith !== undefined ? patch.openWith : current.openWith
  }
  var built = buildItem(merged, id, current.createdAt, {
    installed: ctx && ctx.installed,
    allowOpenWith: current.openWith
  })
  if (built.error) return blankResult(doc, built.error)
  if (takenName(doc, built.item.name, id)) return blankResult(doc, "Quicklink name is already used")
  built.item.createdAt = current.createdAt
  built.item.updatedAt = now
  var next = cloneDoc(doc)
  for (var i = 0; i < next.items.length; i++) if (next.items[i].id === id) next.items[i] = built.item
  return { doc: next, item: built.item, error: "", added: 0, skipped: 0 }
}

function remove(doc, id) {
  if (!get(doc, id)) return blankResult(doc, "Quicklink not found")
  var next = cloneDoc(doc)
  next.items = next.items.filter(function(item) { return item.id !== id })
  return { doc: next, item: null, error: "", added: 0, skipped: 0 }
}

function sameLink(a, b) {
  return String(a.name || "").trim() === String(b.name || "").trim()
    && String(a.link || "").trim() === String(b.link || "").trim()
}

function takenName(doc, name, exceptId) {
  var wanted = String(name || "").trim().toLowerCase()
  var items = doc && doc.items ? doc.items : []
  for (var i = 0; i < items.length; i++) {
    if (exceptId && items[i].id === exceptId) continue
    if (String(items[i].name || "").trim().toLowerCase() === wanted) return true
  }
  return false
}

function rowLabel(row, index) {
  if (row && typeof row === "object" && !Array.isArray(row) && row.name != null) {
    var name = String(row.name).trim()
    if (name) return name.length > 80 ? name.slice(0, 80) : name
  }
  return "row " + (index + 1)
}

function importText(doc, jsonString, ctx) {
  var parsed
  try {
    parsed = JSON.parse(String(jsonString || ""))
  } catch (e) {
    return blankResult(doc, "Import is not valid JSON")
  }
  if (!Array.isArray(parsed)) return blankResult(doc, "Import must be a JSON array")

  var now = ctx && typeof ctx.now === "number" ? ctx.now : Date.now()
  var next = cloneDoc(doc)
  var added = 0
  var skipped = 0
  var skippedNames = []
  for (var i = 0; i < parsed.length; i++) {
    var row = parsed[i]
    var label = rowLabel(row, i)
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      skipped++
      skippedNames.push(label)
      continue
    }
    var name = String(row.name != null ? row.name : "").trim()
    var link = String(row.link != null ? row.link : "").trim()
    if (!name || !link) {
      skipped++
      skippedNames.push(label)
      continue
    }
    var duplicate = false
    for (var j = 0; j < next.items.length; j++) {
      if (sameLink(next.items[j], { name: name, link: link })) { duplicate = true; break }
    }
    if (duplicate) { skipped++; continue }
    var built = buildItem({ name: name, link: link, iconName: row.iconName, openWith: row.openWith }, makeId(next, now + i), now, ctx)
    if (built.error || takenName(next, name, "")) {
      skipped++
      skippedNames.push(label)
      continue
    }
    next.items.push(built.item)
    added++
  }
  return { doc: next, item: null, error: "", added: added, skipped: skipped, skippedNames: skippedNames }
}

function exportList(doc) {
  return list(doc).map(function(item) {
    var row = { name: item.name, link: item.link }
    if (item.iconName) row.iconName = item.iconName
    if (item.openWith) row.openWith = item.openWith
    return row
  })
}

function isOpenQuote(ch) {
  return QUOTE_PAIRS[ch] !== undefined
}

function readQuoted(text, start) {
  var close = QUOTE_PAIRS[text.charAt(start)]
  var out = ""
  for (var i = start + 1; i < text.length; i++) {
    var ch = text.charAt(i)
    if (ch === "\\" && i + 1 < text.length) { out += text.charAt(i + 1); i++; continue }
    if (ch === close) return { value: out, end: i + 1 }
    out += ch
  }
  return { value: out, end: text.length }
}

function splitPipes(inner) {
  var parts = []
  var buf = ""
  var quote = ""
  for (var i = 0; i < inner.length; i++) {
    var ch = inner.charAt(i)
    if (quote) {
      if (ch === "\\" && i + 1 < inner.length) { buf += ch + inner.charAt(i + 1); i++; continue }
      buf += ch
      if (ch === quote) quote = ""
      continue
    }
    if (isOpenQuote(ch)) { quote = ch; buf += ch; continue }
    if (ch === "|") { parts.push(buf); buf = ""; continue }
    buf += ch
  }
  parts.push(buf)
  return {
    head: parts[0],
    modifiers: parts.slice(1).map(function(part) { return part.trim() }).filter(function(part) { return part })
  }
}

function matchKeyword(head) {
  var trimmed = String(head || "").trim()
  for (var i = 0; i < KEYWORDS.length; i++) {
    var keyword = KEYWORDS[i]
    if (trimmed === keyword) return { keyword: keyword, rest: "" }
    if (trimmed.indexOf(keyword) === 0 && trimmed.charAt(keyword.length) === " ")
      return { keyword: keyword, rest: trimmed.slice(keyword.length) }
  }
  return null
}

function parseAttrs(rest) {
  var attrs = {}
  var positional = []
  var text = String(rest || "")
  var i = 0
  while (i < text.length) {
    while (i < text.length && text.charAt(i) === " ") i++
    if (i >= text.length) break
    if (isOpenQuote(text.charAt(i))) {
      var quoted = readQuoted(text, i)
      positional.push(quoted.value)
      i = quoted.end
      continue
    }
    var keyed = /^([A-Za-z][\w-]*)=/.exec(text.slice(i))
    if (keyed) {
      i += keyed[0].length
      var value = ""
      if (i < text.length && isOpenQuote(text.charAt(i))) {
        var read = readQuoted(text, i)
        value = read.value
        i = read.end
      } else {
        var end = i
        while (end < text.length && text.charAt(end) !== " ") end++
        value = text.slice(i, end)
        i = end
      }
      attrs[keyed[1]] = value
      continue
    }
    var bare = i
    while (bare < text.length && text.charAt(bare) !== " ") bare++
    positional.push(text.slice(i, bare))
    i = bare
  }
  return { attrs: attrs, positional: positional }
}

function parseOptions(text) {
  var items = []
  var buf = ""
  var raw = String(text || "")
  for (var i = 0; i < raw.length; i++) {
    var ch = raw.charAt(i)
    if (ch === "\\" && i + 1 < raw.length) { buf += raw.charAt(i + 1); i++; continue }
    if (ch === ",") { items.push(buf); buf = ""; continue }
    buf += ch
  }
  items.push(buf)
  var options = []
  for (var j = 0; j < items.length; j++) {
    var token = items[j].trim()
    if (!token) continue
    var colon = token.indexOf(":")
    if (colon < 0) options.push({ title: token, value: token })
    else options.push({ title: token.slice(0, colon).trim(), value: token.slice(colon + 1).trim() })
  }
  return options
}

function validOffset(offset) {
  if (!offset) return true
  var tokens = String(offset).trim().split(/\s+/)
  for (var i = 0; i < tokens.length; i++) if (!/^[+-]\d+[mhdMy]$/.test(tokens[i])) return false
  return true
}

function parsePlaceholder(inner) {
  var split = splitPipes(inner)
  var modifiers = split.modifiers
  for (var m = 0; m < modifiers.length; m++) {
    if (MODIFIERS.indexOf(modifiers[m]) < 0) return { error: "Unknown modifier " + modifiers[m] }
  }
  var head = split.head.trim()
  var kw = matchKeyword(head)
  if (!kw) {
    if (head.indexOf("=") >= 0) return { error: "Unknown placeholder" }
    var colon = head.indexOf(":")
    var legacyName = (colon < 0 ? head : head.slice(0, colon)).trim()
    var legacyDefault = colon < 0 ? "" : head.slice(colon + 1).trim()
    if (!legacyName) return { error: "Quicklink needs an argument name" }
    return {
      error: "", kind: "argument", name: legacyName, defaultValue: legacyDefault,
      required: !legacyDefault, options: [], modifiers: modifiers, attrs: {}
    }
  }
  if (REFUSED[kw.keyword]) return { error: "Quicklinks cannot use {" + kw.keyword + "}" }
  var parsedAttrs = parseAttrs(kw.rest)
  if (kw.keyword === "argument") {
    var name = parsedAttrs.attrs.name || "argument"
    var def = parsedAttrs.attrs["default"] || ""
    return {
      error: "", kind: "argument", name: name, defaultValue: def, required: !def,
      options: parsedAttrs.attrs.options ? parseOptions(parsedAttrs.attrs.options) : [],
      modifiers: modifiers, attrs: parsedAttrs.attrs
    }
  }
  if (kw.keyword === "clipboard" || kw.keyword === "selection" || kw.keyword === "uuid")
    return { error: "", kind: kw.keyword, modifiers: modifiers, attrs: parsedAttrs.attrs }
  var format = parsedAttrs.attrs.format || ""
  var offset = parsedAttrs.attrs.offset || ""
  var locale = parsedAttrs.attrs.locale || ""
  for (var p = 0; p < parsedAttrs.positional.length; p++) {
    var token = parsedAttrs.positional[p]
    if (/^[+-]\d+[mhdMy]$/.test(token)) { if (!offset) offset = token }
    else if (!format) format = token
  }
  if (format && locale) return { error: "Date format and locale cannot be combined" }
  if (offset && !validOffset(offset)) return { error: "Bad date offset" }
  return { error: "", kind: kw.keyword, modifiers: modifiers, attrs: { format: format, offset: offset, locale: locale } }
}

function placeholderEnd(text, start) {
  var quote = ""
  for (var i = start + 1; i < text.length; i++) {
    var ch = text.charAt(i)
    if (quote) {
      if (ch === "\\" && i + 1 < text.length) { i++; continue }
      if (ch === quote) quote = ""
      continue
    }
    if (ch === "\n" || ch === "\r") return { end: -1, error: "" }
    if (isOpenQuote(ch)) { quote = QUOTE_PAIRS[ch]; continue }
    if (ch === "}") return { end: i, error: "" }
  }
  if (quote) return { end: -1, error: "Unclosed quote" }
  return { end: -1, error: "Unclosed placeholder" }
}

function scanPlaceholders(link) {
  var text = String(link || "")
  var found = []
  var i = 0
  while (i < text.length) {
    var start = text.indexOf("{", i)
    if (start < 0) break
    var closed = placeholderEnd(text, start)
    if (closed.error) return { error: closed.error, found: [] }
    if (closed.end < 0) { i = start + 1; continue }
    found.push({ start: start, end: closed.end + 1, placeholder: parsePlaceholder(text.slice(start + 1, closed.end)) })
    i = closed.end + 1
  }
  return { error: "", found: found }
}

function parseLink(link) {
  var scanned = scanPlaceholders(link)
  if (scanned.error) return { error: scanned.error, arguments: [], needsClipboard: false, needsSelection: false }
  var found = scanned.found
  var args = []
  var needsClipboard = false
  var needsSelection = false
  for (var i = 0; i < found.length; i++) {
    var placeholder = found[i].placeholder
    if (placeholder.error) return { error: placeholder.error, arguments: [], needsClipboard: false, needsSelection: false }
    if (placeholder.kind === "clipboard") needsClipboard = true
    if (placeholder.kind === "selection") needsSelection = true
    if (placeholder.kind !== "argument") continue
    var existing = null
    for (var a = 0; a < args.length; a++) if (args[a].name === placeholder.name) existing = args[a]
    if (existing) {
      if (!existing.defaultValue && placeholder.defaultValue) {
        existing.defaultValue = placeholder.defaultValue
        existing.required = false
      }
      if (existing.options.length === 0 && placeholder.options.length) existing.options = placeholder.options
      continue
    }
    args.push({
      name: placeholder.name,
      defaultValue: placeholder.defaultValue,
      required: placeholder.required,
      options: placeholder.options
    })
  }
  if (args.length > 3) return { error: "A quicklink can take at most 3 arguments", arguments: [], needsClipboard: false, needsSelection: false }
  return { error: "", arguments: args, needsClipboard: needsClipboard, needsSelection: needsSelection }
}

function applyModifiers(value, modifiers) {
  var text = String(value == null ? "" : value)
  var encoded = false
  var raw = false
  for (var i = 0; i < modifiers.length; i++) {
    var modifier = modifiers[i]
    if (modifier === "uppercase") text = text.toUpperCase()
    else if (modifier === "lowercase") text = text.toLowerCase()
    else if (modifier === "trim") text = text.trim()
    else if (modifier === "percent-encode") { text = encodeURIComponent(text); encoded = true }
    else if (modifier === "json-stringify") text = JSON.stringify(text)
    else if (modifier === "raw") raw = true
    else return { ok: false, text: "", error: "Unknown modifier " + modifier }
  }
  if (!raw && !encoded) text = encodeURIComponent(text)
  return { ok: true, text: text, error: "" }
}

function clipboardAt(clipboard, offset) {
  var n = offset > 0 ? offset : 0
  if (Array.isArray(clipboard)) return n < clipboard.length && clipboard[n] != null ? String(clipboard[n]) : ""
  if (n > 0) return ""
  return clipboard == null ? "" : String(clipboard)
}

var MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
var MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
var MONTHS_SHORT_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]
var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
var WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function localParts(ms) {
  var date = new Date(ms)
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
    weekday: date.getDay()
  }
}

function applyOffset(ms, offset) {
  if (!offset || !String(offset).trim()) return { ok: true, ms: ms }
  if (!validOffset(offset)) return { ok: false, ms: ms }
  var date = new Date(ms)
  var tokens = String(offset).trim().split(/\s+/)
  for (var i = 0; i < tokens.length; i++) {
    var match = /^([+-])(\d+)([mhdMy])$/.exec(tokens[i])
    var amount = (match[1] === "-" ? -1 : 1) * parseInt(match[2], 10)
    var unit = match[3]
    if (unit === "m") date.setMinutes(date.getMinutes() + amount)
    else if (unit === "h") date.setHours(date.getHours() + amount)
    else if (unit === "d") date.setDate(date.getDate() + amount)
    else if (unit === "M") date.setMonth(date.getMonth() + amount)
    else if (unit === "y") date.setFullYear(date.getFullYear() + amount)
  }
  return { ok: true, ms: date.getTime() }
}

function frenchLocale(locale) {
  return String(locale || "").toLowerCase().indexOf("fr") === 0
}

function formatWithQt(ms, pattern, locale) {
  if (!locale || typeof Qt === "undefined" || !Qt.locale || !Qt.formatDateTime) return ""
  // Documented form: formatDateTime(date, format, localeFormatOption).
  // The third argument is a FormatType such as Locale.ShortFormat, not a Locale.
  // Passing Qt.locale() there does not convert, so a Qt that follows that
  // signature throws "incompatible arguments". The catch uses the JS month names.
  try {
    var formatted = Qt.formatDateTime(new Date(ms), pattern, Qt.locale(String(locale).replace(/-/g, "_")))
    return formatted ? String(formatted) : ""
  } catch (e) {
    return ""
  }
}

function weekdayName(ms, locale, width) {
  if (locale) {
    var formatted = formatWithQt(ms, width === "short" ? "ddd" : "dddd", locale)
    if (formatted) return formatted
  }
  var day = localParts(ms).weekday
  return width === "short" ? WEEKDAYS_SHORT[day] : WEEKDAYS[day]
}

function defaultDate(ms, locale) {
  if (locale) {
    var formatted = formatWithQt(ms, "d MMM yyyy", locale)
    if (formatted) return formatted
  }
  var parts = localParts(ms)
  var months = frenchLocale(locale) ? MONTHS_SHORT_FR : MONTHS_SHORT
  return parts.day + " " + months[parts.month - 1] + " " + parts.year
}

function defaultTime(ms) {
  var parts = localParts(ms)
  var hour = parts.hour % 12
  if (hour === 0) hour = 12
  var minute = parts.minute < 10 ? "0" + parts.minute : String(parts.minute)
  return hour + ":" + minute + " " + (parts.hour < 12 ? "am" : "pm")
}

function formatPattern(ms, pattern) {
  var parts = localParts(ms)
  var hour12 = parts.hour % 12
  if (hour12 === 0) hour12 = 12
  var pad = function(n, width) { var s = String(n); while (s.length < width) s = "0" + s; return s }
  var out = ""
  var i = 0
  while (i < pattern.length) {
    if (pattern.charAt(i) === "'") {
      if (pattern.charAt(i + 1) === "'") { out += "'"; i += 2; continue }
      var close = pattern.indexOf("'", i + 1)
      if (close < 0) { out += pattern.slice(i + 1); break }
      out += pattern.slice(i + 1, close)
      i = close + 1
      continue
    }
    var matched = ""
    for (var t = 0; t < DATE_TOKENS.length; t++) {
      if (pattern.indexOf(DATE_TOKENS[t], i) === i) { matched = DATE_TOKENS[t]; break }
    }
    if (!matched) { out += pattern.charAt(i); i++; continue }
    if (matched === "yyyy") out += pad(parts.year, 4)
    else if (matched === "yy") out += pad(parts.year % 100, 2)
    else if (matched === "y") out += String(parts.year)
    else if (matched === "MMMM") out += MONTHS_LONG[parts.month - 1]
    else if (matched === "MMM") out += MONTHS_SHORT[parts.month - 1]
    else if (matched === "MM") out += pad(parts.month, 2)
    else if (matched === "M") out += String(parts.month)
    else if (matched === "dd") out += pad(parts.day, 2)
    else if (matched === "d") out += String(parts.day)
    else if (matched === "EEEE") out += WEEKDAYS[parts.weekday]
    else if (matched === "E") out += WEEKDAYS_SHORT[parts.weekday]
    else if (matched === "HH") out += pad(parts.hour, 2)
    else if (matched === "H") out += String(parts.hour)
    else if (matched === "hh") out += pad(hour12, 2)
    else if (matched === "h") out += String(hour12)
    else if (matched === "mm") out += pad(parts.minute, 2)
    else if (matched === "m") out += String(parts.minute)
    else if (matched === "ss") out += pad(parts.second, 2)
    else if (matched === "s") out += String(parts.second)
    else if (matched === "a") out += parts.hour < 12 ? "am" : "pm"
    i += matched.length
  }
  return out
}

function dateText(kind, attrs, ctx) {
  var shifted = applyOffset(typeof ctx.now === "number" ? ctx.now : Date.now(), attrs.offset)
  if (!shifted.ok) return { ok: false, text: "", error: "Bad date offset" }
  var ms = shifted.ms
  var locale = attrs.locale || ""
  if (kind === "day") return { ok: true, text: weekdayName(ms, locale, "long"), error: "" }
  if (attrs.format) return { ok: true, text: formatPattern(ms, attrs.format), error: "" }
  if (kind === "time") return { ok: true, text: defaultTime(ms), error: "" }
  if (kind === "datetime") return { ok: true, text: defaultDate(ms, locale) + " at " + defaultTime(ms), error: "" }
  return { ok: true, text: defaultDate(ms, locale), error: "" }
}

function optionValue(placeholder, text) {
  var options = placeholder.options || []
  if (!options.length) return { ok: true, text: text, error: "" }
  var wanted = String(text).toLowerCase()
  var i
  for (i = 0; i < options.length; i++) {
    var titled = options[i]
    if (titled && String(titled.title).toLowerCase() === wanted) return { ok: true, text: String(titled.value), error: "" }
  }
  for (i = 0; i < options.length; i++) {
    var valued = options[i]
    if (valued && String(valued.value).toLowerCase() === wanted) return { ok: true, text: String(valued.value), error: "" }
  }
  return { ok: false, text: "", error: "\"" + text + "\" is not an option" }
}

function resolvePlaceholder(placeholder, ctx) {
  if (placeholder.kind === "argument") {
    var provided = ctx.arguments && ctx.arguments[placeholder.name]
    var text = provided == null || provided === "" ? (placeholder.defaultValue || "") : provided
    return optionValue(placeholder, String(text))
  }
  if (placeholder.kind === "clipboard") {
    var offset = parseInt(placeholder.attrs.offset || "0", 10)
    if (!isFinite(offset) || offset < 0) offset = 0
    return { ok: true, text: clipboardAt(ctx.clipboard, offset), error: "" }
  }
  if (placeholder.kind === "selection") return { ok: true, text: ctx.selection == null ? "" : String(ctx.selection), error: "" }
  if (placeholder.kind === "uuid") return { ok: true, text: ctx.uuid == null ? "" : String(ctx.uuid), error: "" }
  if (placeholder.kind === "date" || placeholder.kind === "time" || placeholder.kind === "datetime" || placeholder.kind === "day")
    return dateText(placeholder.kind, placeholder.attrs, ctx)
  return { ok: false, text: "", error: placeholder.error || "Unknown placeholder" }
}

function encodeLiteral(text) {
  return String(text).replace(/[ "'`]/g, function(ch) {
    if (ch === " ") return "%20"
    if (ch === "\"") return "%22"
    if (ch === "'") return "%27"
    return "%60"
  })
}

function expand(link, ctx) {
  var text = String(link || "")
  var context = ctx || {}
  // A file path is handed to xdg-open or gtk-launch. Encoding its spaces
  // turns "~/My Notes" into a missing file.
  var keepLiteral = /^[/~]/.test(text.trim())
  function literal(part) { return keepLiteral ? String(part) : encodeLiteral(part) }
  var out = ""
  var i = 0
  while (i < text.length) {
    var start = text.indexOf("{", i)
    if (start < 0) { out += literal(text.slice(i)); break }
    out += literal(text.slice(i, start))
    var closed = placeholderEnd(text, start)
    if (closed.error) return { ok: false, url: "", error: closed.error }
    if (closed.end < 0) { out += "{"; i = start + 1; continue }
    var placeholder = parsePlaceholder(text.slice(start + 1, closed.end))
    if (placeholder.error) return { ok: false, url: "", error: placeholder.error }
    var value = resolvePlaceholder(placeholder, context)
    if (!value.ok) return { ok: false, url: "", error: value.error }
    var shaped = applyModifiers(value.text, placeholder.modifiers)
    if (!shaped.ok) return { ok: false, url: "", error: shaped.error }
    out += shaped.text
    i = closed.end + 1
  }
  return { ok: true, url: out, error: "" }
}

function expandHome(url, home) {
  var text = String(url || "")
  if (!home) return text
  if (text === "~" || text.indexOf("~/") === 0) return String(home).replace(/\/+$/, "") + text.slice(1)
  return text
}

// [D] These last labels are file extensions, not TLDs.
var FILE_EXT = { json: true, md: true, js: true, jsx: true, ts: true, tsx: true, txt: true, pdf: true, png: true, jpg: true, jpeg: true, gif: true, svg: true, html: true, css: true, xml: true }

function isPort(text) {
  if (!/^\d{1,5}$/.test(text)) return false
  var n = parseInt(text, 10)
  return n >= 1 && n <= 65535
}

function isIpv4(host) {
  var parts = String(host || "").split(".")
  if (parts.length !== 4) return false
  for (var i = 0; i < parts.length; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return false
    if (parseInt(parts[i], 10) > 255) return false
  }
  return true
}

function isForbiddenHostChar(code) {
  if (code === 0x200B || code === 0x200C || code === 0x200D || code === 0xFEFF || code === 0x2060 || code === 0x180E) return true
  if (code === 0x200E || code === 0x200F) return true
  if (code >= 0x202A && code <= 0x202E) return true
  if (code >= 0x2066 && code <= 0x2069) return true
  return false
}

function isHostLabel(label) {
  if (!label || label.length > 63) return false
  if (label.charAt(0) === "-" || label.charAt(label.length - 1) === "-") return false
  for (var i = 0; i < label.length; i++) {
    var code = label.charCodeAt(i)
    if (isForbiddenHostChar(code)) return false
    if (code > 127) continue
    if (!/[A-Za-z0-9-]/.test(label.charAt(i))) return false
  }
  return true
}

function isDomain(host) {
  if (String(host || "").toLowerCase() === "localhost") return true
  var labels = String(host || "").split(".")
  if (labels.length < 2) return false
  for (var i = 0; i < labels.length; i++) if (!isHostLabel(labels[i])) return false
  var last = labels[labels.length - 1]
  if (FILE_EXT[last.toLowerCase()]) return false
  for (var c = 0; c < last.length; c++) {
    if (last.charCodeAt(c) > 127 || /[A-Za-z]/.test(last.charAt(c))) return true
  }
  return false
}

function isIpv6(host) {
  if (!host || host.length > 39 || !/^[0-9A-Fa-f:]+$/.test(host)) return false
  var pieces = host.split(":")
  if (pieces.length < 3 || pieces.length > 8) return false
  for (var i = 0; i < pieces.length; i++) if (pieces[i].length > 4) return false
  return true
}

function isLoopback(host, ipv6) {
  if (String(host || "").toLowerCase() === "localhost") return true
  if (!ipv6) return false
  var text = String(host || "").toLowerCase()
  return text === "::1" || text === "0:0:0:0:0:0:0:1"
}

function splitHostPort(authority) {
  if (authority.charAt(0) === "[") {
    var end = authority.indexOf("]")
    if (end < 2) return null
    var host = authority.slice(1, end)
    if (!isIpv6(host)) return null
    var rest = authority.slice(end + 1)
    if (!rest) return { host: host, port: "", ipv6: true }
    if (rest.charAt(0) !== ":" || !isPort(rest.slice(1))) return null
    return { host: host, port: rest.slice(1), ipv6: true }
  }
  var colon = authority.lastIndexOf(":")
  if (colon < 0) return { host: authority, port: "" }
  if (authority.indexOf(":") !== colon) return null
  var port = authority.slice(colon + 1)
  if (!isPort(port)) return null
  return { host: authority.slice(0, colon), port: port }
}

// A host with no scheme: a domain, an IPv4 address, an IDN such as münchen.de,
// or host:port. localhost and [::1] are http [D]. Every other bare host is https.
// Paths (~/, /, ./) and anything that already has a scheme stay as written.
// RootSearch.js repeats these rules. core modules cannot import each other.
function bareWebUrl(target) {
  var text = String(target || "").trim()
  if (!text || /\s/.test(text)) return ""
  var first = text.charAt(0)
  if (first === "/" || first === "~" || first === "." || first === "-") return ""
  if (text.indexOf("://") >= 0) return ""
  if (/^javascript:/i.test(text)) return ""
  var cut = text.search(/[/?#]/)
  var authority = cut < 0 ? text : text.slice(0, cut)
  var tail = cut < 0 ? "" : text.slice(cut)
  if (!authority) return ""
  var split = splitHostPort(authority)
  if (!split || !split.host) return ""
  if (split.ipv6) {
    if (!isIpv6(split.host)) return ""
  } else if (!isIpv4(split.host) && !isDomain(split.host)) return ""
  var scheme = isLoopback(split.host, split.ipv6) ? "http" : "https"
  var hostText = split.ipv6 ? "[" + split.host + "]" : split.host
  return scheme + "://" + hostText + (split.port ? ":" + split.port : "") + tail
}

function refusedLink(url) {
  var target = String(url || "").trim()
  if (/^javascript:/i.test(target)) return "Quicklink link cannot use javascript:"
  if (!target || target.charAt(0) === "-") return "Link cannot start with -"
  return ""
}

function openArgv(openWith, url, home) {
  var target = expandHome(url, home).trim()
  // Omarchy's xdg-open is a script that rejects "--" ("unexpected option '--'").
  // A target that starts with "-" would be read as an option, so it is refused.
  if (refusedLink(target)) return null
  var bare = bareWebUrl(target)
  if (bare) target = bare
  var app = String(openWith || "").trim()
  if (!app) {
    if (bare) return ["omarchy-launch-browser", target]
    return ["xdg-open", target]
  }
  if (!isDesktopId(app)) return null
  return ["uwsm-app", "--", "gtk-launch", "--", app, target]
}

// http(s) goes through Omarchy's browser launcher, as the web-search fallbacks do.
// Anything else (spotify://, a file) uses xdg-open with no "--".
function browserArgv(url) {
  var target = String(url || "").trim()
  if (!target || target.charAt(0) === "-") return null
  if (/^https?:\/\//i.test(target)) return ["omarchy-launch-browser", target]
  return openArgv("", target)
}

function faviconFor(link) {
  var head = String(link || "").split("{")[0].trim()
  var match = /^https:\/\/([^\/?#]+)/i.exec(head)
  if (!match) return ""
  var authority = match[1]
  var at = authority.lastIndexOf("@")
  if (at >= 0) authority = authority.slice(at + 1)
  var host = authority.replace(/:\d+$/, "")
  if (!host) return ""
  return "https://icons.duckduckgo.com/ip3/" + host + ".ico"
}

function clearQuicklinkFrecency(items, id) {
  var key = "quicklink:" + String(id || "")
  var next = {}
  var source = items && typeof items === "object" ? items : {}
  for (var name in source) {
    if (name === key) continue
    next[name] = source[name]
  }
  return next
}

function clearQuicklinkSettings(commands, id) {
  var key = "quicklink:" + String(id || "")
  var next = {}
  var source = commands && typeof commands === "object" ? commands : {}
  for (var name in source) {
    if (name === key) continue
    next[name] = source[name]
  }
  return next
}

function normalizeArguments(parsed, values) {
  var out = {}
  var source = values || {}
  for (var key in source) out[key] = source[key]
  var args = parsed && parsed.arguments ? parsed.arguments : []
  for (var i = 0; i < args.length; i++) {
    var arg = args[i]
    var raw = out[arg.name]
    var text = raw == null ? "" : String(raw).trim()
    if (!text) {
      if (arg.defaultValue) out[arg.name] = arg.defaultValue
      else if (arg.required) return { error: arg.name + " is required", values: out }
      else out[arg.name] = ""
    } else out[arg.name] = text
  }
  return { error: "", values: out }
}

function isItem(item) {
  return !!item && typeof item === "object" && !Array.isArray(item)
    && typeof item.id === "string" && item.id.trim() !== ""
    && typeof item.name === "string" && item.name.trim() !== ""
    && typeof item.link === "string" && item.link.trim() !== ""
}

function candidateItems(doc) {
  return list(doc).filter(isItem)
}

function toCandidate(item, opts) {
  if (!isItem(item)) return null
  var stored = typeof item.iconName === "string" ? item.iconName.trim() : ""
  if (stored.indexOf("://") >= 0) stored = ""
  var hint = opts && opts.favicons ? faviconFor(item.link) : ""
  if (hint.indexOf("https://") !== 0) hint = ""
  var iconName = stored || hint
  var remote = iconName.indexOf("https://") === 0
  return {
    id: "quicklink:" + item.id,
    type: "quicklink",
    kind: "quicklink",
    title: item.name,
    subtitle: item.link,
    keywords: [],
    typeLabel: "Quicklink",
    glyph: remote || !iconName ? "\uf0c1" : "",
    glyphFont: "",
    iconName: iconName,
    link: item.link,
    openWith: item.openWith || "",
    quicklinkId: item.id,
    rootSearch: { when: "always" }
  }
}

function randomUuid() {
  var hex = "0123456789abcdef"
  var out = ""
  for (var i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += "-"
    else if (i === 14) out += "4"
    else if (i === 19) out += hex.charAt(8 + Math.floor(Math.random() * 4))
    else out += hex.charAt(Math.floor(Math.random() * 16))
  }
  return out
}

if (typeof module !== "undefined") {
  module.exports = {
    createDocument: createDocument,
    list: list,
    get: get,
    save: save,
    update: update,
    remove: remove,
    importText: importText,
    exportList: exportList,
    parseLink: parseLink,
    expand: expand,
    openArgv: openArgv,
    bareWebUrl: bareWebUrl,
    refusedLink: refusedLink,
    clearQuicklinkSettings: clearQuicklinkSettings,
    clearQuicklinkFrecency: clearQuicklinkFrecency,
    normalizeArguments: normalizeArguments,
    installedApps: installedApps,
    openWithChoices: openWithChoices,
    openWithLabel: openWithLabel,
    openWithIcon: openWithIcon,
    afterOpenWithPick: afterOpenWithPick,
    prepareOpen: prepareOpen,
    importOpenWithIds: importOpenWithIds,
    browserArgv: browserArgv,
    toCandidate: toCandidate,
    candidateItems: candidateItems,
    randomUuid: randomUuid
  }
}
