// Phone or tablet: the main pointer is a finger, so text comes from an
// on-screen keyboard. There Enter must insert a new line - the keyboard has no
// Shift+Enter, and the send button is always on screen (Egor 22.09.26: "Enter
// sends instead of a line break, lines cannot be split"). A desktop with a
// mouse keeps Enter = send. Checked per keystroke, not cached: a tablet can
// gain or lose a mouse without reloading the page.
export function isTouchKeyboard(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(pointer: coarse)').matches;
}
