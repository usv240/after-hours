# After Hours — product truth

## What it is
After Hours is a time-aware map of public defibrillators (AEDs). Every other AED map answers "where is the nearest one?". After Hours answers "which one can you actually reach **right now**", because most AEDs sit inside buildings that lock at night, on weekends and over the summer.

## Who it is for
- **City and council staff, EMS planners and school facilities managers**: deciding where the next 24/7 outdoor AED cabinet should go.
- **Journalists and residents**: "is my block covered at 3 AM?"
- **Developers and other cities**: bring their own AED list (or any "help that keeps hours" list: naloxone boxes, cooling centres) and get the same analysis, through the site or the API.
- **Hackathon judges (AWS, US)**: must understand it within one screen, with no medical background.

## The proof (real data, no invented claims)
- NYC AED Inventory (NYC Open Data `2er2-jqsx`): 7,437 sites, 11,163 AEDs; 3,992 sites (53.7%) are in schools.
- FDNY EMS Incident Dispatch Data (`76xm-jjuj`): 21,287 initial-call-type ARREST dispatches in 2025; 66.7% happened outside school-building hours.
- East New York (ZIP 11207): 285 arrest calls, 65 AED sites, 63 in schools.
- France Géo'DAE (national registry with declared hours) as the validation set: Paris confirmed-open AEDs drop from 846 (Tue 2 PM) to 223 (Sun 3 AM).
- Research: Sun et al. JACC 2016; Hansen et al. Circulation 2013; Pollack et al. Circulation 2018 (bystander AED: 43.0% → 66.5% survival to discharge).

## Must never
- Present unknown hours as open.
- Look like an emergency service. Always: "In an emergency, call 911 first."
- Show individual incidents or personal data (EMS data is ZIP-level by design).
- Invent users, testimonials, partners or metrics.

## Brand commitments
- Name: After Hours.
- Built entirely on AWS; the AWS stack is shown on every page (a hackathon requirement and a reuse aid).
- Plain language first; every technical term has a one-line explanation the first time it appears.
