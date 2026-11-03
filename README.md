# Streamatic on Meta's models

Streamatic turns the cameras a business already has into rules and alerts: "tell me if the gate is open
after 10 pm", in plain English, on any camera. It runs today on an estate in Lagos, Nigeria.

This repository is our entry to the Meta Global AI Developer Hackathon (Startup track, Build for Your
World). It holds only the work built during the event, 26 October to 4 November 2026.

## What existed before the event

Streamatic's cameras, video storage, rules, alerts on Telegram and WhatsApp, and search over camera footage. None of
that code is in this repository. The new work here calls the existing product's API like any other client.

In particular, whether a rule holds is decided by Streamatic's existing rules, built before the event: they read the
sentence, check the camera can answer it, and ask the vision model on the camera's pictures. The models below do not.

## What is built during the event

- **A camera that sets itself up.** SAM 3.1 outlines what the camera sees under a list of everyday words
  (gate, wall, car, keke, person), by day and at night. Muse Spark picks what matters for that site and
  suggests the rules worth having, keeping SAM's own names so every rule is written in words SAM answers to.
- **What it found at night.** Setup reports, zone by zone, which of the day, dusk and night pictures found it. A zone the night
  picture missed is marked uncertain at night, and what was seen but could not be outlined is named. This is code over setup's
  result, with no model call.
- **Rules that know their place.** A rule is written against an outline SAM drew, not a box someone dragged by hand. The
  place comes from SAM's box ("the door on the right side of the picture") and goes in the sentence sent to
  Streamatic's rules, and SAM's outline is drawn on each alert's pictures. Muse Spark Open chooses which picture goes on
  the alert, and is not asked whether the rule holds.
- **Read, try, then save.** Streamatic's reading of the rule is shown before anything is saved. A rule can then be asked
  over the pictures the camera stored, at a price shown first, to see every time it would have alerted. Rules are saved
  in Streamatic first and kept here with their zones and the guide's plan; their alerts are copied here as events.
- **Zones named once.** Each zone is matched across the day, dusk and night pictures by its place. You name
  it once and confirm it on every picture; SAM keeps searching by its own word.
- **A guide that does the setup with you.** Type one sentence. The guide shows its plan as a checklist,
  then works the app in front of you. A step is ticked only when the app shows it done and you confirm it.
  Muse Spark Open drafts the plan, and code checks it against the camera's zones and hours before anything
  is done. The plan also names what the alert is for, in your own words, and code refuses a zone the rule is
  not about: "a keke parked by the gate" gets a box over the gate, not the gate's outline. A refused plan goes
  back to Muse Spark Open with what was wrong, up to three times, and then to you. Before you confirm, the page
  shows how Streamatic read the rule. The model never marks a step done. The sentence can also be a voice note in English, recorded on
  the page: Muse Voice Transcribe writes it out, listening for the words setup outlined, and you read it before
  anything is planned. If this camera's setup did not outline what you asked about and another camera at the same place did,
  the guide offers that camera, with the thing outlined; code decides this over the zones, not the model.
- **Alerts in the resident's language.** Muse Spark Open says what a rule's alert means in Nigerian Pidgin and in Yoruba, from
  the rule alone, with a choice of language on the alert. It is written once per rule and kept, so playing a clip calls no model.
- **Search that goes past words.** Pause a clip and search for anything: a word, a click on the picture, or one of
  the things already found. Muse Spark Open lists what is on the frame and SAM 3.1 outlines each, down to the
  thing's exact shape, and every result stays on the one frame. SAM 3.1 then tracks the selected outline through the whole
  clip, both ways from that frame, from its box alone: no word, and no limit on how many similar things are in
  view. On the public page, where SAM's charge by the frame adds up, it tracks the minute around that frame. The outline stays on it in the player, and a bar shows when it was in view.
- **A demo engine anyone can open.** Recorded clips with the alerts Streamatic's rules raised on them, rules to select, each
  alert shown 3 seconds after its moment, a Setup page that goes through setup step by step on a picture from each camera, and the guide, whose last step adds your rule to the clip.
  Clips and rules are kept in the page's own database and its videos are served from there, so playing a clip calls no
  model. A picture you upload goes through the same setup, and nothing is kept. Spending is limited per visitor and per day.
- **Alerts on Telegram.** On a clip, "Send alerts to Telegram" links a chat to the page, and each alert of a ticked rule arrives there
  as the clip plays through it, with its picture, in the language chosen. A voice note in English or a sentence sent in the chat becomes a rule
  on that clip: Muse Voice Transcribe writes it out, the guide's checked plan is read back, and after Confirm the rule's alerts come
  back to the chat. A person is told apart by Telegram's own number for them, and the page's daily limits apply to it.
- **Questions about the week.** "How many times was the gate open after 10 pm?" Muse Spark picks the query,
  the events table does the counting, and every answer opens the moment it refers to.

## Meta models used

| Model | Where | Used for |
|---|---|---|
| SAM 3.1 | Meta Model API | Outlining the scene at setup and on each alert's pictures, tracking a selected object through video |
| Muse Voice Transcribe | Meta Model API | Writing out a voice note as the sentence the guide plans from |
| Muse Spark Open | Baseten | Listing what a camera sees, suggesting rules, drafting the guide's plan, choosing the picture an alert carries, writing an alert in Pidgin and Yoruba, naming what can be tracked in a clip, planning answers to questions |

## Running it

The demo runs on your own computer from this repository alone: the clips, their setup and their alerts are in `demo-data/`.
You need Node 22.9 or later and ffmpeg.

```
cd web && npm ci && npm run build
cd ../service && npm ci && npm run demo
```

Then open http://127.0.0.1:8787. With nothing else set, the clips, rules, alerts and the searches already kept all work,
and no model is called. What needs more:

| To use | Add |
|---|---|
| Searching and tracking anything new, the guide's plan, a voice note, your own picture | `META_MODEL_API_KEY` (Meta Model API) and `BASETEN_API_KEY` (Baseten) in `.env` at the repository root |
| Reading a new rule over a clip | Streamatic's backend, which is not public; this works on the hosted page |
| Alerts on Telegram | `DEMO_TELEGRAM_TOKEN` in `.env`: a bot of your own, from Telegram's BotFather |

`npm test` in `service/` runs the tests, with no keys and no network. `web/` is the app (React and Tailwind); `service/` is
the API, the camera setup, the tracking and the copy of Streamatic's alerts.

The app without the public limits runs over a folder of your own: `npm run serve -- <app folder> [port]`. The folder holds
`cameras/<id>/` (a `camera.json` naming the camera, its site and its pictures) and the app keeps its rules and events there.
To save rules, set `STREAMATIC_API`, `STREAMATIC_COMPANY`, `STREAMATIC_EMAIL` and `STREAMATIC_PASSWORD`, and give the camera
a `backend` in `camera.json` with its `deviceId`. `npm run demo-prepare -- <folder>` builds a folder like `demo-data/` from a
`demo.json` listing clips baked into Streamatic. `DEMO_CEILING_USD` sets the public page's daily ceiling on model spending
(10 by default). `DEMO_PAGE_URL` is the page's address, which the bot gives to someone who finds it on their own. The app sends its
own alerts to `TELEGRAM_CHAT_ID` on the same bot, in `TELEGRAM_ALERT_LANGUAGE` (`pidgin` or `yoruba`) if set.

Uploads on the public page are sent to Meta and to Baseten to be analysed, and voice notes, on the page or in the linked chat, to Meta to be written out, under the
hackathon's credit terms, which allow Meta to use them for product improvement; the page keeps no copy.

## Measured results

`eval/` holds what setup measured on three real cameras, and how to build it again.

## Credits

The clips and pictures in `demo-data/`: MEVA dataset by Kitware Inc. and IARPA,
[CC BY 4.0](https://mevadata.org/resources/MEVA-data-license.txt), resized and re-encoded. Kitware and IARPA do not endorse this work.

## Licence

MIT. See `LICENSE`.
