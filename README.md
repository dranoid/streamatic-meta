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
| Muse Spark Open | Baseten | Listing what a camera sees, suggesting rules, judging drawn zones, the second opinion on each alert, answering questions |

## Running it

Work in progress; the demo page address will be added when it is up. To run it on your own computer, put
`META_MODEL_API_KEY` (Meta Model API) and `BASETEN_API_KEY` (Baseten) in `.env` at the repository root, then:

```
cd service && npm install && npm test
cd ../web && npm install && npm run build
cd ../service && npm run serve -- <app folder>
```

The app folder holds `cameras/<id>/` (a `camera.json` naming the camera, its site and its day, dusk and night
pictures), and the app keeps its rules and events there. `web/` is the app (React and Tailwind); `service/` is
the API, the camera setup, the rules and the alerts.

## Licence

MIT. See `LICENSE`.
