# Streamatic on Meta's models

Streamatic turns the cameras a business already has into rules and alerts: "tell me if the gate is open
after 10 pm", in plain English, on any camera. It runs today on an estate in Lagos, Nigeria.

This repository is our entry to the Meta Global AI Developer Hackathon (Startup track, Build for Your
World). It holds only the work built during the event, 26 October to 4 November 2026.

**Try it: https://misc.streamatic.co**

## What existed before the event

Streamatic's cameras, video storage, rules, alerts on Telegram and WhatsApp, and search over camera footage. None of
that code is in this repository. The new work here calls the existing product's API like any other client. The Telegram link
and chat on the demo page are new, built during the event in this repository, and are separate from the product's own alerts.

In particular, whether a rule holds is decided by Streamatic's existing rules, built before the event: they read the
sentence, check the camera can answer it, and ask the vision model on the camera's pictures. The models below do not.

## What is built during the event

- **A camera that sets itself up.** SAM 3.1 outlines what the camera sees under a list of everyday words
  (gate, wall, car, keke, person), by day and at night. Muse Spark picks what matters for that site and
  suggests the rules worth having, keeping SAM's own names so every rule is written in words SAM answers to.
- **Zones you can change.** On the demo page, setup lists what is in view as one set of zones, each of which you can rename or delete. The page is shared, so this applies
  only to what you see: the player, the plan for a rule, routing to a camera and the linked chat all use your zones, and Reset returns them. A rule already using a deleted zone
  keeps watching that place, since its sentence holds the place.
- **What it found at night.** Setup reports, zone by zone, which of the day, dusk and night pictures found it. A zone the night
  picture missed is marked uncertain at night, and what was seen but could not be outlined is named. This is code over setup's
  result, with no model call.
- **Rules that know their place.** A rule is written against an outline SAM drew, not a box someone dragged by hand. The
  place comes from SAM's box ("the door on the right side of the picture") and goes in the sentence sent to
  Streamatic's rules, and SAM's outline is drawn on each alert's pictures. Muse Spark Open chooses which picture goes on
  the alert, and is not asked whether the rule holds.
- **One zone across day, dusk and night.** Each zone is matched across a camera's pictures by its place, and one that was not
  found on the night picture is marked as uncertain at night.
- **Finding an item from one sentence.** Say "Track the bag" and Muse Spark Open decides this is a search rather than a rule, in the
  same call that would plan a rule, and gives up to three names for the item. Code then looks on the paused frame, and if the item is not there,
  every 30 seconds through the clip, nearest first, because SAM can miss a word on one frame and find it on the next. An item found on another frame
  is asked for again on the paused frame by its box, so the track runs around the moment you stopped at. One outline is tracked by itself; several
  wait on the picture for you to select one or more; the clip then plays from where the item comes into view.
- **Add a rule: finishing the rule from one sentence.** Say what you want watched, on the home page or on one camera.
  On the home page, code finds the camera whose setup outlined the most of what you asked about and the page carries on there;
  when several outlined it, you choose. On one camera the rule stays on that camera, unless another camera at the same place
  outlined more of it: the page then offers that camera, with the thing outlined, beside "Stay on this camera". Code decides
  this over the zones, not the model. The rest then runs by itself: Muse Spark Open
  drafts the plan, code checks it against the camera's zones and hours, the zones appear on the player, and the rule runs through
  Streamatic. Code ticks each stage when the page shows it done; the model never does. A bar on the timeline shows how much of the
  clip has been read, each alert appears as it is found, and the finished rule shows how Streamatic read it and how many alerts it
  raised, with a button to play the first. The plan also names what the alert is for, in your own
  words, and code refuses a zone the rule is not about: "a keke parked by the gate" gets a box over the gate, not the gate's
  outline. A refused plan goes back to Muse Spark Open with what was wrong, up to three times, and then to you. The sentence can
  also be a voice note in English, recorded on the page: Muse Voice Transcribe writes it out, listening for the words setup
  outlined, and you read it before anything is planned.
- **Questions about a clip.** Ask "How many people went through the front door?" in the same box. Muse Spark Open sees that this is a
  question, chooses what to count and writes the answer, and code replaces the answer if its numbers are not the counts, or declines
  if the counts do not fit. The counts come from a detector and tracker that are not Meta's: RF-DETR and ByteTrack went over each clip
  once, on Modal, and the tracks are recorded in `demo-data/`. That stands in for a detector running live, since a Modal GPU could not be set up
  in time and each run on CPUs costs money; the model still asks its questions live over those tracks. RF-DETR reads each frame in 15 enlarged sections, since a whole
  frame shrunk to the model's size loses people far from the camera, and uses the whole frame only for what is too large for a section. A question takes seconds and uses your own zones. Counts
  are approximate, since a tracker can lose someone, mix people up or count someone twice.
- **Alerts in the resident's language.** Muse Spark Open says what a rule's alert means in Nigerian Pidgin and in Yoruba, from
  the rule alone, with a choice of language on the alert. It is written once per rule and kept, so playing a clip calls no model.
- **Search that goes past words.** Pause a clip and search for anything: a word, a box drawn around it, or one of
  the things already found. Muse Spark Open lists what is on the frame and SAM 3.1 outlines each, down to the
  thing's exact shape, and every result stays on the one frame. A drawn box asks for the one thing it encloses, which
  Muse Spark Open names; the outline found under that name is kept when it is the same thing, because a box alone can take in the ground around it. SAM 3.1 then tracks up to four selected outlines in one request, over the minute around
  that frame, since SAM charges by the frame and not by the item, both ways from it and from their boxes alone: no word, and no limit on how many similar things are in
  view. A bar shows how far the track has gone, worked out from the frames SAM has finished. Each item keeps its own outline and colour in the player, and its own bar for when it was in view.
- **Events.** Every alert Streamatic's rules raised on the clips, and those of the rules a visitor added, which only that visitor sees, in English, Pidgin or Yoruba. Each opens
  its clip at that moment with its rule selected.
- **Suggestions tested on the clip.** Each suggested sentence was run three times through the page's own path and raised a real alert each time. No
  result is kept: selecting a suggestion runs it live, with one click.
- **A demo engine anyone can open.** Recorded clips with the alerts Streamatic's rules raised on them, rules to select, each
  alert shown 3 seconds after its moment, a Setup page that sets up each camera live and adds the rules you select to its clip, and Add a rule.
  Clips and rules are kept in the page's own database and its videos are served from there, so playing a clip calls no
  model. A picture you upload goes through the same setup, and nothing is kept. Spending is limited per visitor and per day.
  Each visitor starts at Setup: the rest of the page opens once they have set up a camera, and a clip, its alerts, its place in Events and its
  searches wait until its own camera is set up. Reset in the top bar returns all of it to the start. Tracks are listed per visitor, and their
  results are cached so that a repeat costs nothing.
- **Alerts on Telegram.** On a clip, "Send alerts to Telegram" links a chat to the page, for every clip, and each alert of a ticked rule arrives there
  as its clip plays through it, with its picture, in the language chosen. If the picture cannot be sent, the alert still arrives as words. A voice note in English or a sentence sent in the chat becomes a rule
  on a camera the visitor has set up, selected with a button when there is more than one: Muse Voice Transcribe writes it out, the checked plan is read back, and after Confirm the rule's alerts come
  to the chat as its clip plays through them. A person is told apart by Telegram's own number for them, and the page's daily limits apply to it.

## Meta models used

| Model | Where | Used for |
|---|---|---|
| SAM 3.1 | Meta Model API | Outlining the scene at setup and on each alert's pictures, tracking a selected object through video |
| Muse Voice Transcribe | Meta Model API | Writing out a voice note as the sentence a rule is planned from |
| Muse Spark Open | Baseten | Listing what a camera sees, suggesting rules, deciding whether a sentence is a rule, a search or a question, drafting the plan for a rule, choosing what to count for a question and writing the answer, choosing the picture an alert carries, writing an alert in Pidgin and Yoruba, naming what can be tracked in a clip |

The detector and tracker behind questions are not Meta's: RF-DETR (Apache 2.0) and ByteTrack (MIT), run on Modal. They only count for questions and never decide an alert.

## Why the demo uses recorded clips

This page uses recorded clips. The cameras Streamatic has deployed are on private property, so for reasons of permission and privacy they appear only in
the submission video.

Only the clips, their first rules and what the detector found are recorded. Setup, a new rule and a question run live.

## Running it

The demo runs on your own computer from this repository alone: the clips, their setup and their alerts are in `demo-data/`.
You need Node 22.9 or later and ffmpeg.

```
cd web && npm ci && npm run build
cd ../service && npm ci && npm run demo
```

Then open http://127.0.0.1:8787. With nothing else set, setup uses the result saved with this copy, the clips, rules and alerts all work,
and no model is called. What needs more:

| To use | Add |
|---|---|
| Searching and tracking anything new, planning a rule, a voice note, your own picture | `META_MODEL_API_KEY` (Meta Model API) and `BASETEN_API_KEY` (Baseten) in `.env` at the repository root |
| Reading a new rule over a clip | Streamatic's backend, which is not public; this works on the hosted page |
| Alerts on Telegram | `DEMO_TELEGRAM_TOKEN` in `.env`: a bot of your own, from Telegram's BotFather |
| Questions about a clip | The keys above: the clips' tracks are recorded in `demo-data/`. For a clip with none, a detector of your own on Modal, as below, with its address and secret in `.env` as `DETECT_URL` and `DETECT_SECRET`; it runs once on your Modal account and the tracks are kept beside the clip |

```
modal secret create streamatic-detect DETECT_SECRET=<a long random value>
modal deploy service/modal/detect.py
```

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
[CC BY 4.0](https://mevadata.org/resources/MEVA-data-license.txt), resized and re-encoded. This work is not affiliated with Kitware or IARPA.

## Licence

MIT. See `LICENSE`.
