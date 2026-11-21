# Pack-it — moving box tracker

A simple iPhone app (a web app you add to your Home Screen) for keeping track of moving boxes:

- **Automatic box labels** made from the room and what's inside, e.g. `Dine-001-sent` = Dining room, box 1, sentimental.
  Numbers count up separately for each room. You can type your own label if a box is already labelled.
- **Snap a photo** of the box label (and the contents, if it helps). You can attach as many photos as you like.
- **List the contents**, one item per line. You can also note where each box is going (Keep, Family member, Donate, Sell…), who it's for, and whether it's fragile.
- **Search everything**: type "medals" and see which box they're in.
- **Export to Excel** (.xlsx) with three sheets: *Boxes* (one row per box, with a photo), *Items* (one row per item, easy to filter), and *By room* (totals).
- **Backup & restore**: one file holding everything, full-size photos included.
- Works **offline**. All data stays **on the phone**; nothing is uploaded.

## Using it on your iPhone

1. Open the app's web address in **Safari**.
2. Tap **Share** → **Add to Home Screen**. From then on, open it from the Home Screen icon.
   (This matters: iOS keeps Home Screen apps' data safe. Pages left in a Safari tab can be cleared if not used for a while.)
3. Tap **＋ New box**, pick the room and category, write the suggested label on the box, snap a photo, list the contents, and **Save**.
4. **⚙︎ Settings → Export Excel spreadsheet** → *Save to Files* (or Mail / AirDrop).
5. Every so often, **⚙︎ Settings → Save full backup** and keep the file somewhere off the phone, such as iCloud Drive or an email to yourself.

Rooms and categories (and their label codes) can be changed in **Settings**.

## Hosting

This is a plain static site with no build step: `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, `icons/`, `vendor/`.
It needs HTTPS for the camera and offline features. Any static host works:

- **GitHub Pages**: repo *Settings → Pages → Deploy from a branch*, pick the branch and `/ (root)`.
  (On a free GitHub plan, Pages only works for public repositories. The code holds no personal data; your boxes live only on your phone.)
- **Netlify Drop** (app.netlify.com/drop): drag this folder onto the page.

To run locally: `python3 -m http.server` in this folder, then open http://localhost:8000.

## Credits

Excel files are created with [ExcelJS](https://github.com/exceljs/exceljs) (MIT licence, see `vendor/exceljs-LICENSE.txt`).
