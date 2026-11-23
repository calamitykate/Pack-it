# Track-it — moving boxes & deceased estate expenses

Track-it is Pack-it plus an **Expenses** tab for keeping the accounts of a deceased estate as its administrator or executor.
It's its own app: separate name, icon and Home Screen install, with its own data. Pack-it is unchanged.

## Expenses tab

- **Record each payment**: amount, date, who it was paid to, what for, category, and who paid.
  If you (or someone else) paid out of your own pocket, it's marked **To reimburse** until you tick it off.
- **Receipts**: snap a photo of the receipt or attach a PDF invoice or statement. You can attach several to each payment.
  Payments with no receipt are flagged, so you can find them easily.
- **Recurring costs**: tick **🔁 Recurring** for something paid regularly, e.g. a storage unit at $323 a month.
  Each payment is added on its due date, so you can attach that month's receipt. If the first payment was in the past,
  Track-it offers to add the payments due since then. Change the amount later, or **Stop** it when the unit is cleared;
  payments already recorded stay as they were.
- **Totals**: total spent, amount still to reimburse, and filters by month, category, *To reimburse* or *No receipt*.
- **Export spreadsheet** (.xlsx): a summary (estate details, totals, what's owed to whom, totals by category),
  every expense, and the recurring costs.
- **Save all receipts**: every receipt, named to match the spreadsheet, e.g. `2026-11-01 Kennards Self Storage $323.00.pdf`.
  Use this to send them to the solicitor or accountant.

## Boxes tab

Everything Pack-it does: box labels, photos, contents with quantities, search, Excel export.
Pack-it backups can be restored into Track-it.

If you only want one of the two, untick the other under **⚙︎ Settings → Show in the app**.

## Privacy

- **Everything you enter stays on your phone.** The GitHub address only serves the app's code. The expenses, receipts, photos
  and estate details are kept on the device and are never uploaded.
- **Passcode (recommended):** **⚙︎ Settings → Set a passcode** encrypts all the data on the phone (AES-256). Track-it then
  asks for the passcode when it opens, and locks again after a few minutes in the background (you can change how long).
  Backups are encrypted with it too.
  **The passcode can't be recovered.** If it's forgotten, the data can't be opened, and that includes backups. Write it down somewhere safe.
- The page asks search engines not to list it.

## Using it on your iPhone

1. Open the Track-it address in **Safari** (see *Hosting* below).
2. Tap **Share** → **Add to Home Screen**. From then on, open it from the Home Screen icon.
   This matters because iOS keeps Home Screen apps' data safe. Pages left in a Safari tab can be cleared if they aren't used for a while.
3. **⚙︎ Settings**: set a passcode and fill in the estate details.
4. Every so often, **⚙︎ Settings → Save full backup** and keep the file somewhere off the phone, such as iCloud Drive.

## Hosting

This folder is a plain static site with no build step, and it's self-contained: you can move it into its own repository if you want.
It needs HTTPS (for the camera, offline use and encryption).

- **GitHub Pages, from the Pack-it repository:** once this folder is on the branch Pages publishes from,
  Track-it is at *your Pack-it address* + `track-it/`, e.g. `https://<username>.github.io/<repo>/track-it/`.
- **Own repository:** copy this folder's contents to the root of a new repository, then *Settings → Pages → Deploy from a branch*.

On a free GitHub plan, Pages only works for public repositories. That's fine, because the repository holds only the app's code and none of your information.

To run it locally, run `python3 -m http.server` in this folder, then open http://localhost:8000.

## Credits

Excel files are created with [ExcelJS](https://github.com/exceljs/exceljs) (MIT licence, see `vendor/exceljs-LICENSE.txt`).
