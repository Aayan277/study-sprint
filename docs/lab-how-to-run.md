# How to run the RWKV lab on your own computer

The lab is a private test copy of Study Sprint. It runs on your computer only, it never connects to your real account, and it
keeps its own separate copy of your cards. Nothing you do in it changes the real app.

You need a Windows or Mac computer, an internet connection the first time you open it, and about 15 minutes.

## One-time setup

### 1. Install Node.js

1. Go to https://nodejs.org
2. Click the big button that says **LTS** and run the installer. Keep clicking **Next** until it finishes.

### 2. Download the lab

1. Go to the project page on GitHub and open the branch list (the button that says `main`).
2. Choose the branch **claude/rwkv-lab**.
3. Click the green **Code** button, then **Download ZIP**.
4. Unzip it:
   - Windows: right-click the ZIP file, then **Extract All**.
   - Mac: double-click the ZIP file.

You now have a folder. Keep it somewhere easy to find, for example on the Desktop.

### 3. Start the lab

1. Open a terminal inside that folder:
   - Windows: open the folder in File Explorer, click the address bar at the top, type `cmd` and press Enter.
   - Mac: open **Terminal**, type `cd ` (with a space after it), drag the folder onto the Terminal window, and press Enter.
2. Type this and press Enter:

   ```
   node tools/rwkv-lab/serve.mjs
   ```

3. You will see a message saying the lab is running. Leave this window open. Closing it stops the lab.
   To stop it yourself, press **Ctrl+C**.

### 4. Open the lab

Open Chrome, Edge or Safari and go to:

```
http://localhost:8137
```

Always use this exact address. The lab's saved data belongs to this address, so a different address or port looks like an
empty lab. The first time, the page needs internet to load a few libraries.

## Put your cards in

1. On the real Study Sprint site: **Settings**, then **Your data**, then **Export backup**. A `.json` file is saved.
2. In the lab at localhost:8137: **Settings**, then **Your data**, then **Import backup**, choose that file, and press **Replace and restore**.

This makes a copy. Your real cards and your real account are not touched, and syncing is switched off in the lab.
Do this before the steps below. If you restore a backup again later, the lab notices that the reviews changed and asks for a new
**Rebuild from history**.

## Get the model file

1. Open the model's file on GitHub:
   https://github.com/JSchoreels/anki-rwkv/blob/main/artifacts/models/sm72e25/weights.int8.bin
2. Press the **Download raw file** button (the icon at the top right of the file box). The file is called `weights.int8.bin`, is
   the **SM72e25 int8** model and is small, under 0.5 MB. Do not use the larger float version.
3. Keep the file on your computer. The lab does not download it for you, and it is never uploaded anywhere.

## Turn the lab on

1. In the lab: **Settings**, open **Lab**, then press **Open RWKV lab**.
2. **Choose weights file...** and pick the file you downloaded. The line under it should say
   **Recognised: SM72e25 int8**. If it says "Unknown model file", you picked a different file.
3. Press **Rebuild from history**. The model reads all your old reviews. A big collection can take a few minutes; leave
   the page open until the bar disappears.
4. Switch **Shadow mode** on. From now on, every answer you give in the lab is also shown to the model, and the lab
   keeps score next to FSRS in the **Comparison** table. FSRS still decides when cards come back.

Use the lab for a few weeks if you can, and read the table. Tap the **?** next to a title for what it means.

## Optional: let the model schedule cards

Under **Scheduler**, choose **RWKV (lab)**. It is available only when the weights are loaded, shadow mode is on, and
the memory is up to date. After this, the model sets how long a card waits after Hard, Good and Easy, for cards that
are already in review. Again, new cards and learning steps stay with FSRS. To go back, choose **FSRS**. Nothing is lost.

If the model is slow, stopped or out of date, FSRS schedules that card by itself and the lab counts how often that happened.

## Next time

1. Open a terminal in the folder and run `node tools/rwkv-lab/serve.mjs` again.
2. Open http://localhost:8137

To update the lab, download the ZIP again and replace the folder. Your lab data stays, because it is kept by the
browser, not in the folder.

## If something looks wrong

- **"Port 8137 is already in use"**: the lab is probably already running in another window. Just open the address.
- **The page is blank the first time**: check your internet connection and reload.
- **"Out of date: rebuild needed"**: press **Rebuild from history**. This happens after deleting cards, importing, restoring
  a backup, or choosing a new weights file.
- **Start over**: in the lab screen, **Remove weights and lab data**. Your cards and reviews are not touched.

## Phones

**iPhone.** Not possible with this setup. A phone can only reach the lab if it is put on a web address, and this lab is
deliberately never hosted anywhere. Use the computer.

**Android.** Possible but fiddly, so only try it later if you want to test on the go.

1. On the phone: turn on Developer options and **USB debugging**, then connect it to the computer with a cable.
2. On the computer, with the lab running, open Chrome and go to `chrome://inspect`.
3. Under **Port forwarding**, add port `8137` with the address `localhost:8137` and tick **Enable port forwarding**.
4. On the phone, open Chrome and go to `http://localhost:8137`.

The phone has its own separate copy: restore a backup there too and repeat the model steps. It works only while the cable
is connected and the lab is running on the computer.

Recommendation: use the computer for now.
