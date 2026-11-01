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

## Returning home after 2 minutes without input

From version 0.6.0, a paired kiosk goes back to the home screen after **2 minutes without input** (taps, keys, scrolling), the same time as a typical kiosk display-dim timeout. It closes any open sign-in prompt, and leaving the parent area this way locks it and signs the parent out. It waits while someone is typing, has an editor open, has unsaved meal changes or a save on its way, for at most 10 minutes without input.

The display dimming itself is set up on the kiosk device, not in the app. The app can't see or change it; it only uses the same 2-minute time (`HOME_IDLE_MS` in `src/state/homeIdle.ts`). If you change the device's timeout, change that too.

Check on the device:

1. Open a chore chart and leave it. At about 2 minutes the screen should dim, and the home screen should show when it wakes.
2. Open the parent area, sign in and leave it: it should go home and ask for the password again.
3. Start adding a chore, type a name and leave it: it should stay for up to 10 minutes.

## Seasonal themes and birthdays on the kiosk

From version 0.7.0, every screen (sign-in, home, the children's screens, the parent area and the calendar) can carry a seasonal theme or a birthday celebration (Parent area → Themes & Celebrations). There is one decoration layer for the whole app. The sky, ground and garland sit behind the content; falling snow, and in front of it the things that fly or float across (bats, hearts and roses, fireworks and confetti, balloons, Santa's sleigh), pass in front of the cards and panels. Navigation and action buttons, form fields, dialogs, messages and the preview bar always stay on top, and no decoration ever takes a tap, swipe or scroll. For a kiosk:

- **Nothing on the device changes.** Dimming, overnight standby and touch set-up are untouched; the themes are ordinary page content.
- **Taps, swipes and scrolling always reach the app.** No decoration takes a touch, including the ones in front. Dialogs (PIN entry, parent sign-in, confirmations), messages and the preview bar are always drawn above them. While someone types in a field on the page, the flying pieces fade out until they're done.
- **Santa flies by while someone is using the screen:** 15–40 seconds after it wakes (the page starts, or the first tap after the animations paused), then every 4 to 10 minutes, one crossing at a time. A fly-by that falls due when nobody has touched the screen for 2 minutes (the display is dim) waits for the next tap and then comes 15–40 seconds later. A parent's preview shows him within a few seconds.
- **Light on the Pi.** Only transform and opacity are animated, with no downloads.
  - Snow is three tiled sheets rather than hundreds of elements; the fairy lights are 28 glowing bulbs. Santa exists in the page only while crossing.
  - The animations pause after 10 minutes without input and start again at the next tap; no Santa fly-bys are planned while paused.
  - Measured in Chrome at 1080×1920, 60 Hz, with the CPU slowed 4×: 60 frames a second for every theme; about 1.6–2.2 ms of main-thread work per frame for Halloween and 2.3–2.8 ms for Christmas (it varies from run to run). While Santa crosses (about 15 seconds every few minutes) the frame rate stays at 60, with roughly 4 ms more main-thread work per frame at that slowdown (measured again in November 2026, the same with snow in front of the content as behind it).
  - **Not yet measured on the Raspberry Pi itself.**
- **Reduced motion.** If the browser or OS asks for reduced motion, every decoration stays still (the theme is still shown) and Santa doesn't fly.
- **Birthday reward.** On a child's birthday, the first tap on a paired kiosk opens the celebration and gives the reward. The server gives it only once per child per year, however many kiosks or taps. A parent's own (unpaired) phone or laptop shows the banner but doesn't trigger the celebration. The child's Rewards screen lists it as "Birthday bonus <year>", without the day: a paired kiosk is never sent birthdays or the day a reward was given (parents signed in see both).

To check on the Pi: preview each theme from the parent area ("Preview", then "Back to scheduled theme"); for Christmas, wait a few seconds for Santa. Scroll a chore chart and tick a few chores while a theme shows. Watch that the 2-minute return home and the display dimming behave as before.
