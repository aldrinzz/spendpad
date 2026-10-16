# LavishTracker

A one-screen daily spending tracker for two people. You add it to your phone's home screen from a web link. No Play Store, no App Store, nothing to pay for. Both phones share one Google Sheet, so you see the same numbers.

Open it and the keypad is already there: type the amount, tap **Card** or **UPI**, done.

## The rules (decided 10 Oct 2026)

| What | Rule |
|---|---|
| **Daily limit** | Worked out fresh every morning: money left this month ÷ days left (today included). Money left = bank balance − Card/UPI spends not paid off yet, after keeping the emergency fund aside. Spend less and the coming days get a little more; spend more and they get a little less. The month always ends at ₹0. |
| **Credit card** | The cycle runs from the 19th to the 18th, and that cycle's bill is due on the 8th of the following month. The screen shows the **last bill** (minus payments you record) and **this cycle** split into Card and UPI on card. On the 19th, this cycle automatically becomes the next bill. Both days can be changed. |
| **Bank balance** | Works like your bank account: combined salary − Bank spends − card bill payments − emergency fund. Card and UPI-on-card spends leave the bank only when you pay the card bill, so they come off then (never twice). |
| **Emergency fund** | A fixed amount (₹2,000) kept out of the bank balance. It doesn't touch the daily limit. |
| **Who spent it** | Each phone remembers whose it is, so every entry is tagged automatically. Tap the name chip to switch. |

Every expense counts against the daily limit, whether it's paid by Card, UPI or Bank. Card bill payments don't.

## Setup

### 1. Create the shared Google Sheet (about 5 minutes, once)

1. Go to **sheets.new** in the Google account that should hold the data. Name the sheet `LavishTracker`.
2. **Extensions → Apps Script**. Delete what's there and paste in all of [`google-sheet/Code.gs`](google-sheet/Code.gs).
3. Near the top, change `'CHANGE-ME'` to a secret phrase only you two know (for example three random words). Save with ⌘S.
4. **Deploy → New deployment**. Click the gear next to "Select type" and choose **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**.
5. Google asks you to authorise it. Choose your account, then on "Google hasn't verified this app" click **Advanced → Go to LavishTracker (unsafe) → Allow**. The warning appears for every personal script. This one only touches this sheet.
6. Copy the **Web app URL** (it ends in `/exec`). This is the **sync link**.
7. Optional check: open `<sync link>?key=<your phrase>` in a browser. You should see `{"ok":true,"entries":[],"settings":{}}`.

The sheet's **Entries** tab becomes a full log of every expense (date, amount, Card/UPI, who), which is handy for reviewing a month.

### 2. Install on both phones

Open the app link on the phone:

- **Android (Chrome):** ⋮ menu → **Add to Home screen** (or **Install app**).
- **iPhone (Safari):** Share button → **Add to Home Screen**.

Always open it from the home-screen icon. It runs full-screen and works without internet.

### 3. First phone

1. The welcome screen asks for both names and salaries, the daily limit, the emergency fund, and what happened before today: spent this month, card and UPI spends this cycle, and any unpaid card bill. Tap **Start**.
2. ⚙ → paste the **sync link** and the **sync key** (your secret phrase). The status should change to "Synced just now".

### 4. Second phone

1. On the welcome screen tap **Connect to the other phone**. Don't fill in the form, or you'll overwrite the first phone's numbers.
2. Under "This phone belongs to", pick whose phone it is.
3. Paste the same sync link and key, then tap **Sync now**. Everything from the first phone appears.

The dot on the ⚙ icon shows sync status: green means synced, amber means waiting (for example offline; it catches up automatically), red means a problem. Open ⚙ to see what's wrong.

## Good to know

- **Undo:** after logging, tap **Undo** in the message at the top. To remove an older entry, open the Daily limit screen (tap the big number), find the day, tap ✕ and then **Delete**.
- **Hold ⌫** to clear the whole amount you've typed.
- **Card bill payments:** tap **Card owed** → type the amount → **Paid**.
- **Privacy:** anyone with both the sync link *and* the key can read and change the data, so keep them between you two. The app's code contains none of your data.
- **Backup:** ⚙ → Download backup saves everything as a file. The Google Sheet is also a backup.
- **If you edit Code.gs later:** Deploy → Manage deployments → ✏️ → Version: **New version** → Deploy. The sync link stays the same.
- **App updates** reach the phones the second time the app is opened after an update.

## Files

| File | What it does |
|---|---|
| `index.html`, `styles.css`, `app.js` | The screen: keypad, tiles, detail sheets, sync |
| `budget.js` | All the rules above, as plain functions |
| `google-sheet/Code.gs` | The sync script that lives inside the Google Sheet |
| `sw.js`, `manifest.webmanifest`, `icons/` | Make it installable and usable offline |
| `tests/` | Checks for the rules and the sync script |

Run the checks (needs Node 18+):

```bash
node --test 'tests/*.test.js'
```
