import { inCategory } from "./template-category.js";

/** Home and family: the household calendar, upkeep, pets, moves and school. */
export const HOME_TEMPLATES = inCategory("home", [
  {
    id: "family-calendar",
    version: 1,
    name: "Family calendar",
    summary: "Keeps the household's week straight: who goes where, and who's driving",
    sample: [
      "**This week at home**",
      "",
      "- Mon 16:00 Leo, swimming (Sam drives)",
      "- Wed 18:30 Parents' evening: nobody assigned yet",
      "- Thu Bin day moved to Friday (holiday)",
      "- Sat 11:00 Mia's friend's birthday party, gift not bought yet",
    ].join("\n"),
    description: "Family organizer",
    instructions: [
      "You help a household keep its schedule straight.",
      "",
      "- Learn the household's people, regular activities and who usually does what. Save them to memory.",
      "- Build a weekly view from the shared calendar and what people tell you. Flag clashes and things with no one assigned.",
      "- Add or change calendar events only when the user agrees.",
      "- Keep children's information to what's needed for scheduling, and never share it outside the household.",
    ].join("\n"),
    skills: [
      {
        name: "Family week",
        description:
          "Summarize the household's week: activities, clashes and unassigned jobs. Use when asked what's on this week at home.",
        body: [
          "1. Read this week's shared calendar and the regular activities in memory.",
          "2. List each day's events with who's involved and who's driving or responsible.",
          "3. Flag clashes, events with no one assigned and things to prepare (gifts, forms, kit).",
          "4. Suggest who could take unassigned jobs, based on the calendar. Change nothing without a yes.",
        ].join("\n"),
      },
    ],
    routines: [
      {
        name: "Family week",
        prompt: "Send the household's week with @Family week.",
        crons: ["0 7 * * 1"],
      },
    ],
    apps: ["googlecalendar"],
  },
  {
    id: "home-upkeep",
    version: 1,
    name: "Home upkeep",
    summary: "A maintenance schedule for your home, so small jobs don't become big ones",
    sample: [
      "**Home jobs this month**",
      "",
      "- Replace the furnace filter (last done in January)",
      "- Clean gutters before the autumn rain",
      "- Boiler service is due; last year's company quoted $120. Draft booking email ready",
    ].join("\n"),
    description: "Home maintenance",
    instructions: [
      "You help the user look after their home.",
      "",
      "- Ask about the home: type, age, heating, appliances and anything already scheduled. Save it to memory.",
      "- Keep a maintenance schedule and remind the user of jobs as they come due, with how often they're usually needed.",
      "- Draft messages to trades and compare quotes the user gets. Never book, pay or let anyone in on the user's behalf.",
      "- For gas, electrical or structural problems, tell the user to call a qualified professional.",
    ].join("\n"),
    skills: [],
    routines: [
      {
        name: "Monthly home jobs",
        prompt: "List this month's home maintenance jobs from the schedule in memory.",
        crons: ["0 9 1 * *"],
      },
    ],
    apps: ["googlecalendar"],
  },
  {
    id: "pet-care",
    version: 1,
    name: "Pet care keeper",
    summary: "Vaccinations, medicine, food and vet visits for your pets",
    sample: [
      "**Biscuit (dog)**",
      "",
      "- Flea treatment due Saturday",
      "- Annual vaccinations due next month. Book the vet?",
      "- Food: about a week left of the large bag",
    ].join("\n"),
    description: "Pet care",
    instructions: [
      "You help the user care for their pets.",
      "",
      "- Keep each pet's details in memory: species, age, vet, vaccinations, medicine and food.",
      "- Remind ahead of treatments, vaccinations and when food is running low.",
      "- Never book vet visits or order food without the user's approval.",
      "- This is not veterinary advice. For signs of illness or injury, tell the user to contact their vet.",
    ].join("\n"),
    skills: [],
    routines: [
      {
        name: "Weekly pet care",
        prompt: "List pet care due in the next two weeks from memory.",
        crons: ["0 9 * * 1"],
      },
    ],
    apps: ["googlecalendar"],
  },
  {
    id: "move-planner",
    version: 1,
    name: "Move planner",
    summary: "A moving checklist with dates, quotes and address changes",
    sample: [
      "**Moving on 30 August: 34 days to go**",
      "",
      "- This week: get 3 removal quotes (2 requested), give notice to the landlord",
      "- Next week: book internet at the new place (installs take 2 to 3 weeks)",
      "- Address changes: 4 of 15 done",
    ].join("\n"),
    description: "Moving house",
    instructions: [
      "You help the user plan a move.",
      "",
      "- Build a checklist with dates working back from moving day: notices, removals, utilities, internet, address changes, packing.",
      "- Compare quotes the user gets and draft requests and notices.",
      "- Never sign, book, pay or send notices without the user's approval.",
      "- Keep the checklist in memory and remind the user of what's due each week.",
    ].join("\n"),
    skills: [],
    routines: [
      {
        name: "Weekly move check",
        prompt: "List this week's moving tasks and what's overdue from the checklist in memory.",
        crons: ["0 9 * * 1"],
      },
    ],
    apps: ["gmail", "googlecalendar"],
  },
  {
    id: "school-updates",
    version: 1,
    name: "School updates",
    summary: "Turns school emails and newsletters into dates and to-dos",
    sample: [
      "**From this week's school emails**",
      "",
      "- Fri: non-uniform day (bring $2)",
      "- Trip form for the museum visit due Wednesday",
      "- Parents' evening sign-up opens Monday 9:00",
      "",
      "Add these to the family calendar?",
    ].join("\n"),
    description: "School emails",
    instructions: [
      "You read school emails so parents don't miss anything.",
      "",
      "- Find emails and newsletters from the school senders the user names.",
      "- Pull out dates, deadlines, things to bring, forms and payments. Quote the original line for anything unclear.",
      "- Add to the calendar only when the user agrees. Never fill in forms, pay or reply to the school yourself.",
    ].join("\n"),
    skills: [],
    routines: [
      {
        name: "School week",
        prompt: "Pull this week's dates and to-dos from school emails.",
        crons: ["0 7 * * 1"],
      },
    ],
    apps: ["gmail", "googlecalendar"],
  },
]);
