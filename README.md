# Streamatic on Meta's models

Streamatic turns the cameras a business already has into rules and alerts: "tell me if the gate is open
after 10 pm", in plain English, on any camera. It runs today on an estate in Lagos, Nigeria.

This repository is our entry to the Meta Global AI Developer Hackathon (Startup track, Build for Your
World). It holds only the work built during the event, 26 October to 4 November 2026.

## What existed before the event

Streamatic's cameras, video storage, alerts on Telegram and WhatsApp, and search over camera footage.
None of that code is in this repository. The new work here calls the existing product's API like any other
client.

## What is built during the event

- **A camera that sets itself up.** SAM 3.1 outlines what the camera sees under a list of everyday words
  (gate, wall, car, keke, person), by day and at night. Muse Spark picks what matters for that site and
  suggests the rules worth having, keeping SAM's own names so every rule is written in words SAM answers to.
- **Rules on outlines.** A rule watches the outline SAM drew, not a box someone dragged by hand. SAM 3.1
  looks again only when something changes there.
- **A guide that does the setup with you.** Type one sentence. The guide shows its plan as a checklist,
  then works the app in front of you. A step is ticked only when the app shows it done and you confirm it.
- **A second opinion on every alert.** Muse Spark Open, Meta's open model, judges each alert's picture again
  without seeing the first verdict. If it disagrees, the alert says so.
- **Questions about the week.** "How many times was the gate open after 10 pm?" Muse Spark picks the query,
  the events table does the counting, and every answer opens the moment it refers to.

## Meta models used

| Model | Where | Used for |
|---|---|---|
| SAM 3.1 | Meta Model API | Outlining the scene at setup and on each event |
| Muse Spark 1.3 | Meta Model API | Planning: reading the rule, choosing what to watch, answering questions |
| Muse Spark Open | Baseten | The second opinion on each alert |

## Status

Work in progress. Setup instructions and the demo page address will be added as each part lands.

## Licence

MIT. See `LICENSE`.
