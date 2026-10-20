import QtQuick
import qs.Commons

// A one-line text field with Qt's own editing: the caret, selection, word
// moves and deletes, undo, copy and cut [O]. keyHandler sees each key first
// and returns true for the launcher's keys; the rest edit the text.
TextInput {
  id: input

  property var keyHandler: null
  property color caretColor: color

  clip: true
  selectByMouse: true
  // A read-only field (behind the action panel) must not take focus on a click.
  activeFocusOnPress: !readOnly
  selectionColor: Util.alpha(caretColor, 0.35)
  selectedTextColor: color
  verticalAlignment: TextInput.AlignVCenter
  Keys.priority: Keys.BeforeItem
  Keys.onPressed: function(event) { if (input.keyHandler && input.keyHandler(event, input)) event.accepted = true }

  // Text is one line: a pasted or composed line break, tab or other control
  // character becomes a space. [D]
  onTextChanged: if (/[\x00-\x1f\x7f]/.test(text)) {
    var at = cursorPosition
    text = text.replace(/[\x00-\x1f\x7f]/g, " ")
    cursorPosition = Math.min(at, length)
  }

  cursorDelegate: Rectangle {
    width: Math.max(1, Style.space(2))
    color: input.caretColor
    visible: input.activeFocus && !input.readOnly

    SequentialAnimation on opacity {
      running: input.activeFocus && !input.readOnly
      loops: Animation.Infinite
      NumberAnimation { to: 1; duration: 0 }
      PauseAnimation { duration: 530 }
      NumberAnimation { to: 0; duration: 0 }
      PauseAnimation { duration: 530 }
    }
  }
}
