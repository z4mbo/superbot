import type { LibrarySkill } from "./library-skill.js";

/** Errands and purchases: shopping, food, places, orders, subscriptions and rides. */
export const ERRAND_SKILLS: LibrarySkill[] = [
  {
    name: "Shop and compare",
    description:
      "Compare products and prices for something the user wants to buy. Use when asked which product to get or where it's cheapest.",
    body: `1. Ask what it's for, the budget, must-haves and where the user is willing to buy from.
2. Search the web for a few products that fit. Read makers' and sellers' pages for specs and prices, and independent reviews when you can find them.
3. Compare the same model and condition, including shipping, delivery time and return terms. Never invent specs or prices; say when a price couldn't be checked.
4. Recommend one and say why, with the runner-up.
5. Hand back: a short comparison with links and the date you checked prices. Don't buy anything; for a purchase, use the Careful purchase steps.`,
  },
  {
    name: "Careful purchase",
    description:
      "Buy something for the user safely, with their approval of the exact item and total. Use whenever a task ends in paying for something.",
    body: `1. Confirm what to buy: exact item, size or variant, quantity, seller, delivery address and the latest acceptable delivery date.
2. Check the seller looks legitimate (an established shop, clear contact details and return policy). Stop and tell the user if anything looks off.
3. Find the full total: item, shipping, taxes and fees. Note the return or cancellation terms.
4. Confirm before paying. Show the item, seller, total and terms, and wait for a clear yes to that exact purchase.
5. Pay only through a purchase tool or payment method the user has set up for you. Never type card numbers yourself and never save payment details. If you have no way to pay, give the user the link and stop.
6. Hand back: the order confirmation, the total charged and the expected delivery date.`,
  },
  {
    name: "Grocery list",
    description:
      "Build a grocery list from meals, recipes or what's running low. Use when asked for a shopping list.",
    body: `1. Ask for the meals or recipes planned, the number of people, diets and allergies, and what's already at home.
2. List every ingredient with quantities, combining repeats across recipes.
3. Take out what the user already has and flag ingredients that conflict with an allergy.
4. Group the list by aisle or section.
5. Hand back: the list. Don't order anything; if the user wants it delivered, use the Order food steps or the Careful purchase steps.`,
  },
  {
    name: "Order food",
    description:
      "Order a meal or groceries for delivery with the user's approval. Use when asked to order food or groceries.",
    body: `1. Ask what the user wants, the delivery address, when, any allergies, and a budget.
2. Find options that deliver there in time, using a delivery service you can use or restaurants' and shops' own sites.
3. Build the order and check every item against allergies. Say when an ingredient list isn't available.
4. Confirm before ordering. Show the items, the full total with fees and tip, and the delivery time, and wait for a yes.
5. Place the order only through a service you can use with the user's own account or payment setup. Otherwise give the link and the order for the user to place.
6. Hand back: the confirmation and the delivery estimate.`,
  },
  {
    name: "Book a restaurant",
    description:
      "Reserve a table with the user's approval. Use when asked to book dinner, lunch or a table.",
    body: `1. Ask for the restaurant or the kind of place, date, time, party size, and any seating or diet needs.
2. Check availability on the restaurant's site or a booking service you can use. Offer the nearest times if the requested one is taken.
3. Note any deposit, cancellation fee or time limit on the table.
4. Confirm before booking. Show the restaurant, date, time, party size, name for the booking and any deposit, and wait for a yes.
5. Book only through the restaurant's own booking or a service you can use. If you can't book, give the link or phone number and what to ask for.
6. Hand back: the confirmation and how to cancel. Offer to add it to the calendar.`,
  },
  {
    name: "Restaurant picks",
    description: "Suggest a few places to eat that fit the occasion. Use when asked where to eat.",
    body: `1. Ask about the area, the occasion, the budget, cuisine wishes, diets and party size.
2. Search for options with current opening hours and recent reviews. Say when information may be out of date.
3. Pick three that fit, each with why it suits, price level, distance and whether it takes bookings.
4. Hand back: the three picks with links. Offer to book one with the Book a restaurant steps.`,
  },
  {
    name: "Local businesses",
    description:
      "Find local services such as plumbers, cleaners or repair shops and compare them. Use when asked to find a local business.",
    body: `1. Ask what's needed, where, how soon, and the budget.
2. Search for businesses that serve that area. Check opening hours, reviews, licences where they apply, and how to contact them.
3. Shortlist three, with why each fits and anything to check (price on request, call-out fees).
4. Confirm before contacting. Draft a quote request or message; send it only after the user approves it.
5. Hand back: the shortlist with contact details and links, and any drafts.`,
  },
  {
    name: "Orders and returns",
    description:
      "Track orders, start returns and chase refunds. Use when asked where an order is, to return something or about a refund.",
    body: `1. Find the order: from shipping emails when email is connected, or the order number or tracking link the user gives you.
2. Report the status and expected date. For a late order, find the seller's delivery promise.
3. For a return: read the seller's return policy, check the deadline and condition rules, and list the steps.
4. For a refund: check when it was promised and whether it arrived, if the user can tell you.
5. Confirm before acting. Draft the return request or message to the seller, and submit or send it only after the user approves.
6. Hand back: the status, deadlines, and any drafts or confirmation numbers.`,
  },
  {
    name: "Manage subscriptions",
    description:
      "List subscriptions and free trials and help cancel the unwanted ones. Use when asked about subscriptions, renewals or trials.",
    body: `1. Find subscriptions and trials from receipts in email or statements the user shares.
2. List each with price, billing cycle and next charge date. Flag duplicates, ones the user says they don't use, and trials about to turn paid.
3. Find each service's official cancellation steps.
4. Confirm before cancelling. Cancel only the subscriptions the user picks, only through the service's own page, and never share payment details.
5. Hand back: what was cancelled, what the user still needs to finish, and the remaining monthly total.`,
  },
  {
    name: "Request a ride",
    description:
      "Get a taxi or ride for the user with their approval. Use when asked to get a car or ride somewhere.",
    body: `1. Ask for the pickup point, destination, time, number of passengers and any luggage or accessibility needs.
2. Check ride options and prices with a ride service you can use, or local taxi companies.
3. Confirm before requesting. Show the pickup, destination, time, vehicle type and price estimate, and wait for a yes.
4. Request the ride only through a service you can use with the user's own account. Otherwise give the user the options and numbers to call.
5. Hand back: the booking details, the driver and car when assigned, and how to cancel.`,
  },
];
