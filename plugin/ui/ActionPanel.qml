import QtQuick
import qs.Commons

// Ctrl+K action panel (SPEC §10.2): popover anchored bottom-right, its own
// search field, rows grouped by section, each with its shortcut.
Rectangle {
  id: panel

  property var actions: []          // [{id, title, shortcut, section, icon}]
  property string filter: ""
  property int selectedIndex: 0
  property var look: null
  property real zoom: 1
  property var keyHandler: null
  property var pasteHandler: null

  signal activated(string actionId)

  function px(v) { return Math.round(Style.space(v) * panel.zoom) }

  readonly property var visibleActions: {
    var f = panel.filter.trim().toLowerCase()
    return panel.actions.filter(function(a) { return !f || a.title.toLowerCase().indexOf(f) >= 0 })
  }

  function move(delta) {
    var n = panel.visibleActions.length
    if (n === 0) return
    panel.selectedIndex = (panel.selectedIndex + delta + n) % n
    list.positionViewAtIndex(panel.selectedIndex, ListView.Contain)
  }

  function activateSelected() {
    var a = panel.visibleActions[panel.selectedIndex]
    if (a) panel.activated(a.id)
  }

  readonly property alias filterField: filterInput

  onFilterChanged: {
    selectedIndex = 0
    if (filterInput && filterInput.text !== panel.filter) {
      filterInput.text = panel.filter
      filterInput.cursorPosition = filterInput.text.length
    }
  }
  onActionsChanged: selectedIndex = 0

  width: px(340)
  height: Math.min(px(360), list.contentHeight + searchRow.height + px(16))
  radius: Math.max(Style.cornerRadius, px(8))
  color: look.background
  border.width: 1
  border.color: Util.alpha(look.foreground, 0.15)

  MouseArea { anchors.fill: parent }

  ListView {
    id: list
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.bottom: separator.top
    anchors.margins: panel.px(6)
    clip: true
    model: panel.visibleActions
    boundsBehavior: Flickable.StopAtBounds
    onActiveFocusChanged: if (list.activeFocus) filterInput.forceActiveFocus()

    delegate: Item {
      required property var modelData
      required property int index
      readonly property bool newSection: index > 0 && panel.visibleActions[index - 1].section !== modelData.section
      width: ListView.view.width
      height: panel.px(34) + (newSection ? panel.px(9) : 0)

      Rectangle {
        visible: parent.newSection
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.topMargin: panel.px(4)
        height: 1
        color: Util.alpha(panel.look.foreground, 0.1)
      }

      Rectangle {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        height: panel.px(34)
        radius: Math.max(Style.cornerRadius, panel.px(6))
        color: index === panel.selectedIndex ? panel.look.selectedBackground : "transparent"

        Text {
          id: actionIcon
          anchors.left: parent.left
          anchors.leftMargin: panel.px(10)
          anchors.verticalCenter: parent.verticalCenter
          width: panel.px(18)
          horizontalAlignment: Text.AlignHCenter
          textFormat: Text.PlainText
          text: modelData.icon || ""
          color: panel.look.foreground
          opacity: 0.75
          font.family: modelData.icon === "" ? "omarchy" : panel.look.fontFamily
          font.pixelSize: panel.px(13)
        }

        Text {
          anchors.left: actionIcon.right
          anchors.leftMargin: panel.px(8)
          anchors.right: keys.left
          anchors.rightMargin: panel.px(8)
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: modelData.title
          color: panel.look.foreground
          elide: Text.ElideRight
          font.family: panel.look.fontFamily
          font.pixelSize: Math.round(Style.font.body * panel.zoom)
        }

        KeyHint {
          id: keys
          anchors.right: parent.right
          anchors.rightMargin: panel.px(8)
          anchors.verticalCenter: parent.verticalCenter
          keys: modelData.shortcut || ""
          color: panel.look.foreground
          fontFamily: panel.look.fontFamily
          zoom: panel.zoom
        }

        MouseArea {
          anchors.fill: parent
          hoverEnabled: true
          onPositionChanged: panel.selectedIndex = index
          onClicked: { panel.selectedIndex = index; panel.activateSelected() }
        }
      }
    }
  }

  Rectangle {
    id: separator
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: searchRow.top
    height: 1
    color: Util.alpha(panel.look.foreground, 0.1)
  }

  Item {
    id: searchRow
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    height: panel.px(38)

    Text {
      anchors.left: parent.left
      anchors.leftMargin: panel.px(14)
      anchors.right: parent.right
      anchors.rightMargin: panel.px(14)
      anchors.verticalCenter: parent.verticalCenter
      height: parent.height
      visible: filterInput.text.length === 0
      textFormat: Text.PlainText
      text: "Search for actions…"
      color: Util.alpha(panel.look.foreground, 0.45)
      font.family: filterInput.font.family
      font.pixelSize: filterInput.font.pixelSize
      verticalAlignment: Text.AlignVCenter
      elide: Text.ElideRight
    }

    TextInput {
      id: filterInput
      anchors.left: parent.left
      anchors.leftMargin: panel.px(14)
      anchors.right: parent.right
      anchors.rightMargin: panel.px(14)
      anchors.verticalCenter: parent.verticalCenter
      height: parent.height
      clip: true
      selectByMouse: true
      persistentSelection: true
      color: panel.look.foreground
      selectionColor: panel.look.selectedBackground
      selectedTextColor: panel.look.foreground
      font.family: panel.look.fontFamily
      font.pixelSize: Math.round(Style.font.body * panel.zoom)
      verticalAlignment: TextInput.AlignVCenter
      cursorDelegate: Rectangle {
        width: Math.max(1, Style.space(2))
        color: panel.look.accent
        visible: filterInput.cursorVisible
      }
      Keys.priority: Keys.BeforeItem
      Keys.onPressed: function(event) { if (panel.keyHandler && panel.keyHandler(event)) event.accepted = true }
      onTextEdited: if (panel.filter !== text) panel.filter = text

      MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.MiddleButton
        onClicked: if (panel.pasteHandler) panel.pasteHandler(filterInput)
      }
    }
  }
}
