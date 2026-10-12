# Viewport Controls and Keyboard Shortcuts

[Documentation home](../README.md) · [Open ST.E.V.E.](https://davbachman.github.io/STEVE/)

## Viewport Controls

| Input | Action |
| --- | --- |
| Click an object | Select it |
| Left-drag a selected plot or unpinned light | Move in XY |
| `Shift` + left-drag | Move along Z |
| Right-drag | Orbit |
| `Shift` + right-drag | Pan |
| Scroll | Zoom |
| Double-click | Frame the selection, or the scene when nothing is selected |
| `Top`, `Front`, `Side` | Use an axis-aligned view |
| `⛶` | Frame the selection/scene |
| `⌂` | Reset the camera |
| `?` | Show or hide the viewport control reminder |

Use **Collapse** and **Expand** at the top right of the equation editor to hide or restore the equation input and preview. The expanded editor scrolls when its contents are long.

The two panel icons in the top-right corner hide or restore the left and right sidebars. In smaller windows, the panels open as drawers, one at a time; click the shaded area to close them. **Undo** and **Redo** are beside the File menu and retain the latest 100 document changes. Selecting an object reveals its **Duplicate** and **Delete** buttons.

## Keyboard Shortcuts

Except for `Esc`, shortcuts apply when focus is not inside a text or number field.

| Shortcut | Action |
| --- | --- |
| `Esc` | Cancel an in-progress GIF recording, cancel intersection-surface/light-curve picking, or clear the selection |
| `Delete` or `Backspace` | Delete the selected object |
| `Command/Ctrl` + `C` | Copy the selected object and all of its settings |
| `Command/Ctrl` + `V` | Paste an object; pasting a full tuple or equality creates a new classified plot |
| `Command/Ctrl` + `Z` | Undo |
| `Command/Ctrl` + `Shift` + `Z` | Redo |
| `Command/Ctrl` + `Y` | Redo |

One Undo step reverses a slider gesture or a short burst of equation typing. A pause in typing, leaving the editor, or another edit starts a new typing step.

---

[Previous: Appearance, Lighting, and Scene Controls](appearance.md) · [Table of contents](../README.md#table-of-contents) · [Next: Files, Recovery, and Exports](files-and-exports.md)
