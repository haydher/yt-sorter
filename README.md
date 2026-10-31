# YouTube Queue Sorter

A tiny browser extension that adds a **Sort** button to YouTube's queue and sorts it by video length, so you don't have to drag videos one at a time.

- Click **Sort** for shortest first, or **Shift+click** for longest first.
- The new order is saved by YouTube itself, so it survives reloads and moving to the next video.
- Works in Brave, Chrome, Edge and other Chromium browsers.

## Install

1. Download this repo (**Code → Download ZIP**) and unzip it, or run `git clone https://github.com/haydher/yt-sorter.git`.
2. Open `brave://extensions` (or `chrome://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder that contains `manifest.json`.
5. Open YouTube, start a queue, open it, and click **Sort** next to **Clear**.

After updating the code, click the reload icon on the extension and refresh YouTube.

## How it works

The queue is a playlist stored on YouTube's servers. The extension reads the queue's data from the page, works out the fewest moves needed, and sends the same `edit_playlist` requests YouTube sends when you drag a row. It then refreshes the on-screen list.

Live streams and videos with no known length go to the end.

## Troubleshooting

If something goes wrong, the button shows an error and the details are written to the browser console.

1. Press **F12** and open the **Console** tab.
2. Type `yt-sorter` in the filter box. Every message from this extension starts with `[yt-sorter]:`.
3. Copy those lines when reporting a problem.

YouTube changes its page often, so the button may stop working after a redesign. The console message will say what it couldn't find.

## Fix or change it with AI

Paste this into your AI assistant (Claude, ChatGPT, etc.) along with the contents of `content.js` and any `[yt-sorter]:` console lines:

```text
This is a Manifest V3 browser extension that adds a "Sort" button to YouTube's queue panel
and sorts the queue by video length. It runs in the page's MAIN world, reads the queue from
the <ytd-playlist-panel-renderer> element's `.data` (playlistId, contents, currentIndex), and
reorders it by sending POST /youtubei/v1/browse/edit_playlist with ACTION_MOVE_VIDEO_AFTER
(setVideoId + movedSetVideoIdPredecessor), authenticated with a SAPISIDHASH header.

Here is content.js and the console output (lines start with "[yt-sorter]:"):

<paste content.js>
<paste console output>

Please find out why it is failing (YouTube may have changed its DOM or API) and give me the
corrected content.js. Keep the change small and keep the "[yt-sorter]:" error logging.
```

## Notes

- Uses your existing YouTube login; no data is sent anywhere except to YouTube.
- Not affiliated with YouTube or Google.
