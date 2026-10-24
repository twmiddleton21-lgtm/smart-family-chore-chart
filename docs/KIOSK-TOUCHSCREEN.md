# Touchscreen kiosks: scrolling and touch

How the app handles finger scrolling on a fullscreen kiosk (for example Chromium on a Raspberry Pi with a portrait touchscreen), and what to check on the device.

## How scrolling works

- Every page, panel and dialog scrolls **natively**: finger drag, mouse wheel and keyboard (Page Up/Down, Space, Home/End). There are no custom touch handlers by default.
- **Scrollbars are hidden** (`scrollbar-width: none`, plus `::-webkit-scrollbar` for older Chromium). Nothing is clipped: `overflow` is unchanged, so content stays reachable.
- **A drag never ticks a chore.** Buttons use `touch-action: manipulation`: a tap responds at once, and a drag that starts on a chore, profile card or button scrolls the page. The browser cancels the tap when a scroll starts. Chores and profile cards also have `user-select: none`, so a drag doesn't highlight their text.
- **No pull-to-refresh or bounce** (`overscroll-behavior-y: none` on the page): an accidental reload on a kiosk would sign a parent out. Dialogs use `overscroll-behavior: contain`, so scrolling to the end of a dialog doesn't scroll the page behind it.

## The usual cause of "scrollbars appear, but dragging doesn't scroll"

The app was tested in Google Chrome with real touch events at 1080×1920. There, dragging scrolled the page from anywhere, and no chore was ticked.

When the same drag arrives as **mouse** input instead, the page doesn't scroll and the drag **selects text**, which matches the reported problem. This happens when the kiosk browser doesn't recognise the touchscreen as a touch device and treats the finger as a mouse pointer. It's a browser or display-server setting, not something the page can detect.

### Fix 1 (preferred): let the browser receive real touch events

On the kiosk, check how Chromium is started (for example in the autostart or kiosk script) and try:

- **Wayland desktop** (recent Raspberry Pi OS): run Chromium as a native Wayland app, `--ozone-platform=wayland`. Under XWayland it may get the touchscreen as a mouse.
- **X11 desktop:** add `--touch-events=enabled`.

Then test: open a chore chart, drag a finger up from the middle of a chore. The page should scroll without highlighting any text.

These flags change from one Chromium version to the next, so check them on your device. They weren't tested on a Raspberry Pi as part of this change.

### Fix 2 (fallback): drag-to-scroll mode in the app

If the browser can't be made to send touch events, open the app with **`?dragscroll=1`** at the end of the kiosk's address, for example:

```
http://192.168.1.20:3080/?dragscroll=1
```

In this mode, which is **off unless the address asks for it** (`src/lib/dragScroll.ts`):

- Pressing and dragging with the (emulated) mouse scrolls the nearest scrollable area, or the page.
- A press that moves less than 10 px is still an ordinary tap.
- The click at the end of a drag is ignored, so scrolling never ticks a chore.
- Text isn't selected, except inside text fields.
- There's no momentum: the page stops when the finger lifts.

Use it only on the kiosk. On a computer with a real mouse it would turn mouse drags into scrolling.

## Supported viewports

The layout is checked automatically at:

- 1080×1920 portrait (kiosk)
- 768×1024 (tablet)
- 390×844 (phone)
- 1920×1080 (landscape)

## What the automated tests cover, and what they don't

`e2e/kiosk-touch.spec.ts` runs in Google Chrome at 1080×1920 with touch enabled. It checks that:

- A finger drag scrolls, whether it starts on a chore or on a heading, and ticks nothing.
- A tap still ticks and unticks a chore.
- Scrollbars are hidden, while the wheel and keyboard still scroll.
- Long chore names stay clear of the points.
- Home-page cards are compact.
- The `?dragscroll=1` fallback scrolls on a mouse drag and still accepts a plain click.

Touch is **synthesised** through the browser's DevTools protocol. These tests prove what the browser does with touch events. They **don't** prove that a particular touchscreen, driver and kiosk setup delivers touch events. That needs a check on the device itself:

1. Drag to scroll on the home page, a chore chart, the rewards page, the Family Calendar, and a parent-area dialog.
2. Start drags on chores, profile cards and buttons: nothing should tick or open.
3. Tap chores, profiles, Rewards, Redeem, Back and Family Calendar: each should respond on the first tap.
4. Look for highlighted text after dragging, and for an accidental page reload when pulling down at the top.
