// Quicklinks (SPEC §8.4): the library, placeholder expansion (SPEC §8.3),
// import/export, and the root-search row for one saved link.
// [D] A repeated import is a duplicate only when both the name and the link match.
// [D] Substituted values are percent-encoded unless the placeholder says raw.
// [I] Date patterns cover the Unicode tokens the defaults and the tests use.

var KEYWORDS = ["browser-tab", "calculator", "clipboard", "datetime", "argument", "selection", "snippet", "cursor", "date", "time", "uuid", "day", "ai"]
var REFUSED = { cursor: true, "browser-tab": true, snippet: true, calculator: true, ai: true }
var MODIFIERS = ["uppercase", "lowercase", "trim", "percent-encode", "json-stringify", "raw"]
var QUOTE_PAIRS = { "\"": "\"", "'": "'", "`": "`", "\u201c": "\u201d", "\u2018": "\u2019" }
var DATE_TOKENS = ["yyyy", "yy", "MMMM", "MMM", "MM", "EEEE", "HH", "hh", "mm", "ss", "dd", "y", "M", "d", "E", "H", "h", "m", "s", "a"]

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
  return { doc: doc, item: null, error: error, added: 0, skipped: 0 }
}

function buildItem(input, id, now) {
  var name = String(input && input.name != null ? input.name : "").trim()
  var link = String(input && input.link != null ? input.link : "").trim()
  if (!name) return { error: "Quicklink needs a name" }
  if (!link) return { error: "Quicklink needs a link" }
  var parsed = parseLink(link)
  if (parsed.error) return { error: parsed.error }
  return {
    error: "",
    item: {
      id: id,
      name: name,
      link: link,
      iconName: String(input.iconName || "").trim(),
      openWith: String(input.openWith || "").trim(),
      createdAt: now,
      updatedAt: now
    }
  }
}

function save(doc, input, ctx) {
  var now = ctx && typeof ctx.now === "number" ? ctx.now : Date.now()
  var next = cloneDoc(doc)
  var id = ctx && ctx.id ? String(ctx.id) : makeId(next, now)
  if (get(next, id)) return blankResult(doc, "Quicklink id already exists")
  var built = buildItem(input, id, now)
  if (built.error) return blankResult(doc, built.error)
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
  var built = buildItem(merged, id, current.createdAt)
  if (built.error) return blankResult(doc, built.error)
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
  for (var i = 0; i < parsed.length; i++) {
    var row = parsed[i]
    if (!row || typeof row !== "object") return blankResult(doc, "Quicklink needs a link")
    var name = String(row.name != null ? row.name : "").trim()
    var link = String(row.link != null ? row.link : "").trim()
    if (!name) return blankResult(doc, "Quicklink needs a name")
    if (!link) return blankResult(doc, "Quicklink needs a link")
    var duplicate = false
    for (var j = 0; j < next.items.length; j++) {
      if (sameLink(next.items[j], { name: name, link: link })) { duplicate = true; break }
    }
    if (duplicate) { skipped++; continue }
    var built = buildItem({ name: name, link: link, iconName: row.iconName, openWith: row.openWith }, makeId(next, now + i), now)
    if (built.error) return blankResult(doc, built.error)
    next.items.push(built.item)
    added++
  }
  return { doc: next, item: null, error: "", added: added, skipped: skipped }
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

function scanPlaceholders(link) {
  var text = String(link || "")
  var found = []
  var i = 0
  while (i < text.length) {
    var start = text.indexOf("{", i)
    if (start < 0) break
    var end = start + 1
    var aborted = false
    while (end < text.length && text.charAt(end) !== "}") {
      if (text.charAt(end) === "\n" || text.charAt(end) === "\r") { aborted = true; break }
      end++
    }
    if (aborted || end >= text.length) { i = start + 1; continue }
    found.push({ start: start, end: end + 1, placeholder: parsePlaceholder(text.slice(start + 1, end)) })
    i = end + 1
  }
  return found
}

function parseLink(link) {
  var found = scanPlaceholders(link)
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

function zonedParts(ms, timeZone) {
  var format = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "UTC",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long"
  })
  var map = {}
  format.formatToParts(new Date(ms)).forEach(function(part) { if (part.type !== "literal") map[part.type] = part.value })
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour === "24" ? "0" : map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: map.weekday || ""
  }
}

function civilToUtc(parts, timeZone) {
  var guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  var got = zonedParts(guess, timeZone)
  var asUtc = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second)
  return guess - (asUtc - guess)
}

function applyOffset(ms, offset, timeZone) {
  if (!offset || !String(offset).trim()) return { ok: true, ms: ms }
  if (!validOffset(offset)) return { ok: false, ms: ms }
  var zone = timeZone || "UTC"
  var parts = zonedParts(ms, zone)
  var tokens = String(offset).trim().split(/\s+/)
  for (var i = 0; i < tokens.length; i++) {
    var match = /^([+-])(\d+)([mhdMy])$/.exec(tokens[i])
    var amount = (match[1] === "-" ? -1 : 1) * parseInt(match[2], 10)
    var unit = match[3]
    if (unit === "m") parts.minute += amount
    else if (unit === "h") parts.hour += amount
    else if (unit === "d") parts.day += amount
    else if (unit === "M") parts.month += amount
    else if (unit === "y") parts.year += amount
  }
  var spilled = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second))
  return {
    ok: true,
    ms: civilToUtc({
      year: spilled.getUTCFullYear(),
      month: spilled.getUTCMonth() + 1,
      day: spilled.getUTCDate(),
      hour: spilled.getUTCHours(),
      minute: spilled.getUTCMinutes(),
      second: spilled.getUTCSeconds()
    }, zone)
  }
}

function monthName(ms, timeZone, locale, width) {
  return new Intl.DateTimeFormat(locale || "en-GB", { timeZone: timeZone || "UTC", month: width }).format(new Date(ms))
}

function weekdayName(ms, timeZone, locale, width) {
  return new Intl.DateTimeFormat(locale || "en-GB", { timeZone: timeZone || "UTC", weekday: width }).format(new Date(ms))
}

function defaultDate(ms, timeZone, locale) {
  var format = new Intl.DateTimeFormat(locale || "en-GB", {
    timeZone: timeZone || "UTC", day: "numeric", month: "short", year: "numeric"
  })
  var out = ""
  format.formatToParts(new Date(ms)).forEach(function(part) {
    if (part.type === "day" || part.type === "month" || part.type === "year") out += part.value
    else if (part.type === "literal") out += " "
  })
  return out.replace(/\s+/g, " ").trim()
}

function defaultTime(ms, timeZone) {
  var format = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "UTC", hour: "numeric", minute: "2-digit", hourCycle: "h12"
  })
  var hour = ""
  var minute = ""
  var period = ""
  format.formatToParts(new Date(ms)).forEach(function(part) {
    if (part.type === "hour") hour = part.value
    if (part.type === "minute") minute = part.value
    if (part.type === "dayPeriod") period = part.value.toLowerCase()
  })
  return hour + ":" + minute + " " + period
}

function formatPattern(ms, pattern, timeZone, locale) {
  var zone = timeZone || "UTC"
  var parts = zonedParts(ms, zone)
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
    else if (matched === "MMMM") out += monthName(ms, zone, locale, "long")
    else if (matched === "MMM") out += monthName(ms, zone, locale, "short")
    else if (matched === "MM") out += pad(parts.month, 2)
    else if (matched === "M") out += String(parts.month)
    else if (matched === "dd") out += pad(parts.day, 2)
    else if (matched === "d") out += String(parts.day)
    else if (matched === "EEEE") out += weekdayName(ms, zone, locale, "long")
    else if (matched === "E") out += weekdayName(ms, zone, locale, "short")
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
  var zone = ctx.timeZone || "UTC"
  var shifted = applyOffset(typeof ctx.now === "number" ? ctx.now : Date.now(), attrs.offset, zone)
  if (!shifted.ok) return { ok: false, text: "", error: "Bad date offset" }
  var ms = shifted.ms
  if (kind === "day") return { ok: true, text: weekdayName(ms, zone, attrs.locale || "en-GB", "long"), error: "" }
  if (attrs.format) return { ok: true, text: formatPattern(ms, attrs.format, zone, attrs.locale), error: "" }
  if (kind === "time") return { ok: true, text: defaultTime(ms, zone), error: "" }
  if (kind === "datetime") return { ok: true, text: defaultDate(ms, zone, attrs.locale) + " at " + defaultTime(ms, zone), error: "" }
  return { ok: true, text: defaultDate(ms, zone, attrs.locale), error: "" }
}

function resolvePlaceholder(placeholder, ctx) {
  if (placeholder.kind === "argument") {
    var provided = ctx.arguments && ctx.arguments[placeholder.name]
    var text = provided == null || provided === "" ? (placeholder.defaultValue || "") : provided
    return { ok: true, text: String(text), error: "" }
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

function expand(link, ctx) {
  var text = String(link || "")
  var context = ctx || {}
  var out = ""
  var i = 0
  while (i < text.length) {
    var start = text.indexOf("{", i)
    if (start < 0) { out += text.slice(i); break }
    out += text.slice(i, start)
    var end = start + 1
    var aborted = false
    while (end < text.length && text.charAt(end) !== "}") {
      if (text.charAt(end) === "\n" || text.charAt(end) === "\r") { aborted = true; break }
      end++
    }
    if (aborted || end >= text.length) { out += "{"; i = start + 1; continue }
    var placeholder = parsePlaceholder(text.slice(start + 1, end))
    if (placeholder.error) return { ok: false, url: "", error: placeholder.error }
    var value = resolvePlaceholder(placeholder, context)
    if (!value.ok) return { ok: false, url: "", error: value.error }
    var shaped = applyModifiers(value.text, placeholder.modifiers)
    if (!shaped.ok) return { ok: false, url: "", error: shaped.error }
    out += shaped.text
    i = end + 1
  }
  return { ok: true, url: out, error: "" }
}

function expandHome(url, home) {
  var text = String(url || "")
  if (!home) return text
  if (text === "~" || text.indexOf("~/") === 0) return String(home).replace(/\/+$/, "") + text.slice(1)
  return text
}

function openArgv(openWith, url, home) {
  var target = expandHome(url, home)
  var app = String(openWith || "").trim()
  if (app) return ["gio", "launch", app, target]
  return ["xdg-open", target]
}

function faviconFor(link) {
  var head = String(link || "").split("{")[0].trim()
  var match = /^https?:\/\/([^\/?#]+)/i.exec(head)
  if (!match) return ""
  return "https://icons.duckduckgo.com/ip3/" + match[1].replace(/:\d+$/, "") + ".ico"
}

function toCandidate(item) {
  var stored = String(item.iconName || "")
  var iconName = stored || faviconFor(item.link)
  var remote = iconName.indexOf("://") >= 0
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
    toCandidate: toCandidate,
    randomUuid: randomUuid
  }
}
