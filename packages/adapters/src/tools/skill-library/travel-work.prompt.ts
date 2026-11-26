import type { LibrarySkill } from "./library-skill.js";

/** Travel, career, sales, markets, code and privacy. */
export const TRAVEL_WORK_SKILLS: LibrarySkill[] = [
  {
    name: "Find flights",
    description:
      "Search and compare flights, and book one only with the user's approval. Use when asked to find or book flights.",
    body: `1. Ask for the route, dates and how flexible they are, number of travelers, cabin, bags and any airline preferences.
2. Search live fares with a flight service you can use or airlines' own sites. If you can't search live prices, say so and give the user where to look.
3. Show the cheapest, the fastest and the best-timed options with total prices, stops, times and baggage rules, and when you checked.
4. Confirm before booking. Show the exact flights, travelers' names as on their passports, the total price and the change and refund rules, and wait for a yes.
5. Book only through a service you can use with the user's own account or payment setup. Otherwise give the booking link.
6. Hand back: the confirmation or the link, and remind the user to check passport and visa rules on official sites.`,
  },
  {
    name: "Find a stay",
    description:
      "Find and compare places to stay, and book only with the user's approval. Use when asked to find a hotel or rental.",
    body: `1. Ask for the place, dates, guests, budget per night, the area they want to be in and must-haves (cancellation, kitchen, accessibility).
2. Search options with current prices. Note the total with taxes and fees, rating, location and cancellation deadline.
3. Show up to three, with the trade-offs.
4. Confirm before booking. Show the property, dates, guests, total price and cancellation terms, and wait for a yes.
5. Book only through a service you can use. Otherwise give the link.
6. Hand back: the confirmation or link, the cancellation deadline, and the check-in details.`,
  },
  {
    name: "Travel itinerary",
    description:
      "Put a trip's bookings and plans into one day-by-day itinerary. Use when asked for an itinerary or to organize a trip.",
    body: `1. Collect the trip's confirmations from email when connected, or what the user pastes: flights, stays, trains, cars, events and reservations.
2. Lay them out day by day with times in the local time zone, addresses and confirmation numbers.
3. Point out gaps and tight connections: a late arrival with no stay, a short transfer, a check-in before the room is ready.
4. Suggest how to get between places and what to book ahead. Book nothing without the user's approval.
5. Offer to add the plan to the calendar, and add it only when the user agrees.
6. Hand back: the itinerary.`,
  },
  {
    name: "Search for jobs",
    description:
      "Find job openings that match the user's criteria and track applications. Use when asked to look for jobs.",
    body: `1. Ask for the roles, locations or remote, salary floor, must-haves and companies to avoid, unless they're in memory.
2. Search job boards and company career pages. Keep only openings that meet every must-have, and note when each was posted.
3. List matches with title, company, location, salary if listed, link, and which must-haves each meets.
4. Offer to draft a cover letter from the user's real experience. Never invent jobs, skills, dates or results.
5. Confirm before applying. Submit an application or message a recruiter only after the user approves that exact application.
6. Hand back: the matches, and update the application tracker in memory.`,
  },
  {
    name: "Find leads",
    description:
      "Find companies and contacts that match an ideal customer profile. Use when asked for leads or prospects.",
    body: `1. Ask for the ideal customer: industry, size, region, the signals that show need, and exclusions, unless they're in memory.
2. Search public sources such as company sites, job posts, news and directories for companies showing those signals.
3. For each match, give the evidence with a link and the most relevant role to contact.
4. Use only business contact details published for that purpose. Never guess personal addresses.
5. Leave out companies already in the user's CRM or on the do-not-contact list.
6. Hand back: the list. Draft first messages if asked, and send nothing without the user's approval.`,
  },
  {
    name: "Enrich a lead",
    description:
      "Add company and role details to a lead from public sources. Use when asked to research or fill in a lead.",
    body: `1. Take the lead's name, company or website.
2. Find the company's size, industry, location, recent news and what it sells, and the person's public professional role.
3. Link the source for each fact and mark anything uncertain. Collect nothing about the person's private life.
4. Confirm before writing to the CRM. Update records only after the user approves.
5. Hand back: a short profile with sources.`,
  },
  {
    name: "Markets and filings",
    description:
      "Summarize a public company's filings, results and market news. Use when asked about a company's results, filings or stock news.",
    body: `1. Ask which company and what the user wants to know (results, risks, guidance, ownership changes).
2. Read the latest filings and results from official sources: the regulator's filing system and the company's investor page. Say when data may be delayed.
3. Compare headline numbers with the same period last year and with guidance. Note new risks and one-off items.
4. Link every figure to its source.
5. Hand back: five bullets or fewer, ending with a note that this is information, not investment advice. Never place trades or tell the user to buy or sell.`,
  },
  {
    name: "Code review",
    description:
      "Review a code change for bugs, security problems and missing tests. Use when asked to review a pull request or diff.",
    body: `1. Get the change: a pull request link, a diff, or files. Read the description, then the full diff, and the surrounding code a change depends on.
2. Look for wrong behavior and edge cases first, then security problems, then missing or weak tests, then unclear names. Skip style a formatter would fix.
3. Check each suspected problem against the code before reporting it.
4. Write at most five points, most important first, each with the file and line, what's wrong and a suggested fix. Say how sure you are when you aren't.
5. Confirm before posting. Post review comments, approve or request changes only when the user says to. Never merge.
6. Hand back: the review and a suggested verdict.`,
  },
  {
    name: "Data broker opt-out",
    description:
      "Remove the user's listings from people-search and data-broker sites and track the requests. Use when asked to remove personal information online.",
    body: `1. Only help with the user's own information, or someone who asked them for help. Ask for the details to search: name, past cities, email addresses and phone numbers, the smallest set that works.
2. Check people-search sites for listings, with a browser when you have one. Otherwise give the user each site's official opt-out page.
3. For each listing, prepare the opt-out using the site's own process and note what it needs (email confirmation, a form, an ID check).
4. Confirm before submitting. Submit each opt-out only after the user approves it. Never pay to remove information.
5. Hand back: a tracker of site, date requested, status and when to check again, saved to memory with the user's consent.`,
  },
];
